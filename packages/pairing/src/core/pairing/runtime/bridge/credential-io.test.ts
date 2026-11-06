/** Real credential I/O, isolated HOME and public-host-key/probe seams only. */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { createCredentialBinding } from "./credential-binding.ts";
import { credentialOwnerId, provisionSshTerminalAccess } from "./ssh-terminal-access.ts";
const real = { ...fs }, realOs = { ...os };
const a = "1234567890abcdef" + "a".repeat(48), b = "1234567890abcdef" + "b".repeat(48);
const sshA = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC0uMiA4QE9WW2JpcHF4f4aNlJuiqbC4ucLJ0tng5+Y=";
const sshB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmAh46VnK29zdbj6vMAGSSvycjZ4eXq7gGrIoF0";
let root = "", home = "", probes = 0, writes = 0;
let lockHook: (() => void) | undefined;
let probeHook: ((step: string) => Promise<void>) | undefined;
function inside(path: unknown): void {
  if (typeof path !== "string" || !home || !resolve(path).startsWith(resolve(home) + "/")) {
    throw new Error("Credential fixture refuses filesystem access outside isolated HOME");
  }
}
mock.module("os", () => ({ ...realOs, homedir: () => home || (() => { throw Error("sandbox missing"); })(),
  hostname: () => "fixture", userInfo: () => ({ username: "fixture" }) }));
mock.module("fs", () => ({ ...real,
  readFileSync(path: any, ...args: any[]) {
    if (path === "/etc/ssh/ssh_host_ed25519_key.pub") return sshA;
    inside(path); return Reflect.apply(real.readFileSync, real, [path, ...args]);
  },
  openSync(path: any, ...args: any[]) {
    inside(path);
    if (String(path).endsWith(".scout-authorized-keys.lock") && lockHook) {
      const action = lockHook; lockHook = undefined; action();
      throw Object.assign(new Error("fixture lock contention"), { code: "EEXIST" });
    }
    return Reflect.apply(real.openSync, real, [path, ...args]);
  },
  writeFileSync(path: any, ...args: any[]) { inside(path); writes++; return Reflect.apply(real.writeFileSync, real, [path, ...args]); },
  renameSync(from: any, to: any) { inside(from); inside(to); return real.renameSync(from, to); },
  mkdirSync(path: any, ...args: any[]) { inside(path); return Reflect.apply(real.mkdirSync, real, [path, ...args]); },
  chmodSync(path: any, mode: any) { inside(path); return real.chmodSync(path, mode); },
  unlinkSync(path: any) { inside(path); return real.unlinkSync(path); },
}));
mock.module("./log.ts", () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const originalProbes = await import("@openscout/runtime/system-probes");
mock.module("@openscout/runtime/system-probes", () => ({ ...originalProbes,
  async execSystemFile(_command: string, args: string[]) {
    probes++;
    const step = args.includes("has-session") ? "exists" : args.includes("list-clients") ? "clients"
      : args.includes("list-panes") ? "panes" : "resolve";
    await probeHook?.(step);
    return { stdout: step === "resolve" ? "/fixture/tmux" : step === "clients" ? "client\n" : step === "panes" ? "80\t24\tzsh" : "", stderr: "", exitCode: 0 };
  },
}));
const { readMobileTerminalStatus, provisionMobileTerminalAccess } = await import("./mobile-terminal-provision.ts");
let stamp = "initial", live = true, keys = [a, b];
let bridge: object, binding: object;
const owner = { readAuthority: () => ({ stamp, revision: 1,
  peers: keys.map(publicKey => ({ publicKey, pairedAt: "now", lastSeen: "now" })) }) };
const file = () => join(home, ".ssh", "authorized_keys");
const validGrant = (key = a) => provisionSshTerminalAccess({ authorizedKeys: "", deviceId: key.slice(0, 16),
  pairingNoisePublicKey: key, sshPublicKey: sshA, terminalSessionName: "scout" }).authorizedKeys;
beforeEach(() => {
  root = real.mkdtempSync(join(realOs.tmpdir(), "scout-credential-io-")); home = join(root, "home");
  real.mkdirSync(join(home, ".ssh"), { recursive: true });
  stamp = "initial"; live = true; keys = [a, b]; probes = writes = 0; lockHook = undefined; probeHook = undefined;
  bridge = {}; binding = createCredentialBinding(bridge, a, () => live, owner);
  real.writeFileSync(file(), validGrant());
});
afterEach(() => { real.rmSync(root, { recursive: true, force: true }); home = ""; });
for (const step of ["resolve", "exists", "clients", "panes"]) {
  for (const change of ["revoke", "replace", "disconnect", "regrant"]) {
    test(`real status refuses ${change} while awaiting ${step}`, async () => {
      let entered!: () => void, resume!: () => void;
      const reached = new Promise<void>(done => { entered = done; });
      const paused = new Promise<void>(done => { resume = done; });
      probeHook = async current => { if (current === step) { entered(); await paused; } };
      const operation = readMobileTerminalStatus(undefined, a.slice(0, 16), binding);
      await reached;
      if (change === "disconnect") live = false;
      else if (change === "replace") createCredentialBinding(bridge, a, () => live, owner);
      else { stamp = "revoked"; keys = []; if (change === "regrant") { stamp = "regranted"; keys = [a, b]; } }
      resume();
      await expect(operation).rejects.toThrow("expired");
      expect(writes).toBe(0);
    });
  }
}
test("provisioning cannot write after invalidation while acquiring its real lock", async () => {
  const before = real.readFileSync(file(), "utf8");
  lockHook = () => { stamp = "changed-during-lock"; };
  await expect(provisionMobileTerminalAccess(sshB, a.slice(0, 16), undefined, binding)).rejects.toThrow("expired");
  expect(real.readFileSync(file(), "utf8")).toBe(before);
  expect(writes).toBe(0); expect(probes).toBe(0);
});
test("real migration replaces only an exactly established owner", async () => {
  const legacy = `restrict,pty ${sshA} scout:terminal-access:v0 device=${Buffer.from(a.slice(0, 16)).toString("base64url")} pairing=${credentialOwnerId(a)} session=c2NvdXQ\n`;
  const foreign = validGrant(b);
  real.writeFileSync(file(), legacy + foreign);
  const result = await provisionMobileTerminalAccess(sshB, a.slice(0, 16), undefined, binding);
  expect(result.sessionName).toBe("scout");
  const after = real.readFileSync(file(), "utf8");
  expect(after).not.toContain(legacy.trim()); expect(after).toContain(foreign.trim());
  expect(after).toContain(`owner=${credentialOwnerId(a)}`); expect(after).toContain(sshB);
  expect(writes).toBe(1);
});
test("ambiguous production grants remain unchanged in real provisioning", async () => {
  const before = `restrict,pty ${sshA} scout:terminal-access:v0 device=${Buffer.from(a.slice(0, 16)).toString("base64url")} pairing=unbound session=c2NvdXQ\n`;
  real.writeFileSync(file(), before);
  await expect(provisionMobileTerminalAccess(sshB, a.slice(0, 16), undefined, binding)).rejects.toThrow("local review");
  expect(real.readFileSync(file(), "utf8")).toBe(before); expect(writes).toBe(0);
});
test("status without an owned persisted session never probes ambient tmux", async () => {
  real.writeFileSync(file(), validGrant(b));
  await expect(readMobileTerminalStatus(undefined, a.slice(0, 16), binding)).rejects.toThrow("No SSH terminal session");
  expect(probes).toBe(0); expect(writes).toBe(0);
});
