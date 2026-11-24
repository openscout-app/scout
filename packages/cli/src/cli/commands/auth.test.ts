import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { distKeyPath, fileDistKeyStore } from "@openscout/runtime/routing";
import { resolveInstalledWebFullClient } from "@openscout/runtime/client";

import { createScoutCommandContext } from "../context.ts";
import { runAuthCommand } from "./auth.ts";
import { runWebCommand, type ScoutWebCommandDeps } from "./web.ts";

const HOST = "https://console.openscout.app";
const DEVICE_CODE = "a".repeat(64);
const KEY = "osdist_fromthebrowser0123";
const VERSION = "9.8.7";

const GRANT = {
  device_code: DEVICE_CODE,
  user_code: "BCDF-GHJK",
  verification_uri: `${HOST}/device`,
  verification_uri_complete: `${HOST}/device?code=BCDF-GHJK`,
  expires_in: 600,
  interval: 5,
};
const PENDING = { status: 400, body: { error: "authorization_pending" } };
const APPROVED = { status: 200, body: { key: KEY, login: "arach", label: "Scout CLI on mini", key_id: "k1" } };

type Poll = { status: number; body: unknown } | Error;

let root: string;
let support: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scout-auth-cmd-"));
  support = join(root, "support");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(options: {
  polls?: Poll[];
  grant?: { status: number; body: unknown };
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  tarball?: Uint8Array<ArrayBuffer>;
} = {}) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const opened: string[] = [];
  const sleeps: number[] = [];
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const polls = [...(options.polls ?? [PENDING, PENDING, APPROVED])];
  let clock = 0;
  const tty = options.tty ?? true;
  const context = createScoutCommandContext({
    cwd: root,
    env: options.env ?? {},
    stdout: (line) => lines.push(line),
    stderr: (line) => prompts.push(line),
    isTty: tty,
    outputMode: options.json ? "json" : "plain",
  });
  const deps: ScoutWebCommandDeps = {
    supportDirectory: support,
    version: VERSION,
    // Never the real Keychain from a test.
    keyStores: [fileDistKeyStore(support)],
    stdinIsTty: tty,
    readStdin: async () => "",
    restartWeb: async () => "http://127.0.0.1:43120",
    hostname: () => "mini",
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openBrowser: async (url) => (opened.push(url), true),
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/v1/cli/device/code")) {
        const grant = options.grant ?? { status: 200, body: GRANT };
        return Response.json(grant.body, { status: grant.status });
      }
      if (url.endsWith("/v1/cli/device/token")) {
        const poll = polls.shift() ?? PENDING;
        if (poll instanceof Error) throw poll;
        return Response.json(poll.body, { status: poll.status });
      }
      if (url.endsWith("/v1/dist/whoami")) return Response.json({ login: "arach", label: "mini" });
      if (url.includes("/v1/dist/web-full/") && options.tarball) {
        return new Response(options.tarball, {
          headers: { "x-openscout-sha256": createHash("sha256").update(options.tarball).digest("hex") },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  };
  return { context, deps, lines, prompts, opened, sleeps, requests };
}

const keyWhere = () => fileDistKeyStore(support).where;
const savedKey = () => existsSync(distKeyPath(support)) ? readFileSync(distKeyPath(support), "utf8").trim() : null;

async function packClient(version: string): Promise<Uint8Array<ArrayBuffer>> {
  const client = join(root, `client-${version}`);
  mkdirSync(join(client, "assets"), { recursive: true });
  writeFileSync(join(client, "index.html"), "<title>Scout</title>");
  writeFileSync(join(client, "scout-web-profile.json"), JSON.stringify({ profile: "full", version }));
  const tarball = join(root, `${version}.tar.gz`);
  await promisify(execFile)("tar", ["-czf", tarball, "-C", client, "."], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
  return new Uint8Array(readFileSync(tarball));
}

describe("scout auth login", () => {
  test("shows the page and code, opens the browser, waits for approval and saves the key", async () => {
    const run = harness();
    await runAuthCommand(run.context, ["login"], run.deps);

    expect(run.requests[0]).toEqual({ url: `${HOST}/v1/cli/device/code`, method: "POST", body: { label: "Scout CLI on mini" } });
    expect(run.requests.slice(1).map((request) => request.body)).toEqual(Array(3).fill({ device_code: DEVICE_CODE }));
    expect(run.sleeps).toEqual([5000, 5000, 5000]);
    expect(run.opened).toEqual([GRANT.verification_uri_complete]);
    expect(run.prompts.join("\n")).toContain(GRANT.verification_uri_complete);
    expect(run.prompts.join("\n")).toContain("Code: BCDF-GHJK");
    expect(savedKey()).toBe(KEY);
    expect(run.lines.join("\n")).toBe(`Signed in as arach. Key saved in ${keyWhere()}.\nNext: scout web install`);
    // The key is saved, never shown.
    expect([...run.lines, ...run.prompts].join("\n")).not.toContain(KEY);
  });

  test("slow_down adds five seconds to the wait", async () => {
    const run = harness({ polls: [{ status: 400, body: { error: "slow_down" } }, PENDING, APPROVED] });
    await runAuthCommand(run.context, ["login"], run.deps);
    expect(run.sleeps).toEqual([5000, 10000, 10000]);
    expect(savedKey()).toBe(KEY);
  });

  test("a dropped request or a busy host is not an answer; waiting goes on", async () => {
    const run = harness({ polls: [new Error("socket hang up"), { status: 503, body: null }, { status: 429, body: null }, APPROVED] });
    await runAuthCommand(run.context, ["login"], run.deps);
    expect(savedKey()).toBe(KEY);
  });

  test("denial, an expired code, a used code, an account without access and a full key list each stop with nothing saved", async () => {
    const cases: Array<[Poll, string]> = [
      [{ status: 400, body: { error: "access_denied" } }, "denied"],
      [{ status: 400, body: { error: "expired_token" } }, "expired"],
      [{ status: 400, body: { error: "invalid_grant" } }, "no longer knows this sign-in"],
      [{ status: 403, body: { error: "not_entitled" } }, "can't download the full web app"],
      [{ status: 409, body: { error: "too_many_keys" } }, "Revoke one at https://console.openscout.app/#downloads"],
    ];
    for (const [poll, message] of cases) {
      const run = harness({ polls: [PENDING, poll] });
      await expect(runAuthCommand(run.context, ["login"], run.deps)).rejects.toThrow(message);
      expect(savedKey()).toBeNull();
    }
  });

  test("the code runs out on this side too when the host never answers", async () => {
    const run = harness({ grant: { status: 200, body: { ...GRANT, expires_in: 12 } }, polls: [] });
    await expect(runAuthCommand(run.context, ["login"], run.deps)).rejects.toThrow("expired before it was approved");
    expect(run.sleeps).toEqual([5000, 5000, 5000]);
    expect(savedKey()).toBeNull();
  });

  test("an expiry names a dropped request only when the host never answered after it", async () => {
    const shortGrant = { status: 200, body: { ...GRANT, expires_in: 12 } };
    const recovered = harness({ grant: shortGrant, polls: [new Error("socket hang up"), PENDING] });
    const healed = await runAuthCommand(recovered.context, ["login"], recovered.deps).catch((error: Error) => error.message);
    expect(healed).toBe("The sign-in code expired before it was approved. Run: scout auth login");
    const dropped = harness({ grant: shortGrant, polls: [PENDING, new Error("socket hang up")] });
    await expect(runAuthCommand(dropped.context, ["login"], dropped.deps)).rejects.toThrow("(last answer: socket hang up)");
  });

  test("--no-browser, SSH and a non-terminal print the page without opening it", async () => {
    for (const setup of [
      { args: ["login", "--no-browser"] },
      { args: ["login"], env: { SSH_CONNECTION: "10.0.0.2 50000 10.0.0.3 22" } },
      { args: ["login"], tty: false },
    ]) {
      const run = harness({ env: setup.env, tty: setup.tty });
      await runAuthCommand(run.context, setup.args, run.deps);
      expect(run.opened).toEqual([]);
      expect(run.prompts.join("\n")).toContain(GRANT.verification_uri_complete);
      expect(savedKey()).toBe(KEY);
      rmSync(support, { recursive: true, force: true });
    }
  });

  test("a sign-in page on another site is refused and never opened", async () => {
    const run = harness({ grant: { status: 200, body: { ...GRANT, verification_uri_complete: "https://evil.example/device?code=BCDF-GHJK" } } });
    await expect(runAuthCommand(run.context, ["login"], run.deps)).rejects.toThrow("another site");
    expect(run.opened).toEqual([]);
    expect(run.requests).toHaveLength(1);
  });

  test("OPENSCOUT_DIST_URL moves the whole sign-in to a local host", async () => {
    const local = "http://127.0.0.1:8787";
    const run = harness({
      env: { OPENSCOUT_DIST_URL: local },
      grant: { status: 200, body: { ...GRANT, verification_uri: `${local}/device`, verification_uri_complete: `${local}/device?code=BCDF-GHJK` } },
    });
    await runAuthCommand(run.context, ["login"], run.deps);
    expect(run.requests.every((request) => request.url.startsWith(local))).toBe(true);
    expect(run.opened).toEqual([`${local}/device?code=BCDF-GHJK`]);
  });

  test("too many starts from one address explains itself", async () => {
    const run = harness({ grant: { status: 429, body: { error: "slow_down" } } });
    await expect(runAuthCommand(run.context, ["login"], run.deps)).rejects.toThrow("Too many sign-in attempts");
  });

  test("cancelling while waiting saves nothing", async () => {
    const controller = new AbortController();
    const run = harness();
    await expect(runAuthCommand(run.context, ["login"], {
      ...run.deps,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    })).rejects.toThrow("Sign-in cancelled. Nothing was saved.");
    expect(savedKey()).toBeNull();
  });

  test("--json prints one value; the prompts go to stderr", async () => {
    const run = harness({ json: true });
    await runAuthCommand(run.context, ["login"], run.deps);
    expect(run.lines).toHaveLength(1);
    expect(JSON.parse(run.lines[0]!)).toEqual({ signedIn: true, login: "arach", label: "Scout CLI on mini", keyWhere: keyWhere() });
  });

  test("--key keeps the paste path: checked with the host, then saved", async () => {
    const run = harness();
    await runAuthCommand(run.context, ["login", "--key", "osdist_pasted"], run.deps);
    expect(run.requests.map((request) => request.url)).toEqual([`${HOST}/v1/dist/whoami`]);
    expect(savedKey()).toBe("osdist_pasted");
    expect(run.lines.join("\n")).toContain('Signed in as arach (key "mini")');
  });
});

describe("scout auth status and logout", () => {
  test("status says how to sign in, then who is signed in, without the key", async () => {
    const out = harness();
    await runAuthCommand(out.context, ["status"], out.deps);
    expect(out.lines.join("\n")).toBe("Not signed in. Run: scout auth login");
    expect(out.requests).toHaveLength(0);

    await fileDistKeyStore(support).write(KEY);
    const signedIn = harness({ json: true });
    await runAuthCommand(signedIn.context, ["status"], signedIn.deps);
    expect(JSON.parse(signedIn.lines[0]!)).toMatchObject({ signedIn: true, state: "signed_in", login: "arach", keyWhere: keyWhere() });
    expect(signedIn.lines[0]).not.toContain(KEY);
  });

  test("logout removes the key and points at revoking it; an environment key is named", async () => {
    await fileDistKeyStore(support).write(KEY);
    const run = harness({ env: { SCOUT_DIST_KEY: KEY } });
    await runAuthCommand(run.context, ["logout"], run.deps);
    expect(savedKey()).toBeNull();
    const text = run.lines.join("\n");
    expect(text).toContain("Download key removed. To stop it working anywhere, revoke it at https://console.openscout.app/#downloads");
    expect(text).toContain("SCOUT_DIST_KEY is still set");
    expect(text).not.toContain(KEY);
  });
});

describe("scout web through scout auth", () => {
  test("install with no key at a terminal signs in first, then installs", async () => {
    const run = harness({ tarball: await packClient(VERSION) });
    await runWebCommand(run.context, ["install", "--no-restart"], run.deps);
    expect(run.prompts[0]).toBe("Signing in first…");
    expect(savedKey()).toBe(KEY);
    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).not.toBeNull();
    const text = run.lines.join("\n");
    expect(text).toContain("Signed in as arach.");
    expect(text).not.toContain("Next: scout web install");
    expect(run.requests.at(-1)!.url).toBe(`${HOST}/v1/dist/web-full/${VERSION}`);
  });

  test("install with no key and no terminal names scout auth login and asks the host nothing", async () => {
    const run = harness({ tty: false });
    await expect(runWebCommand(run.context, ["install"], run.deps)).rejects.toThrow("scout auth login");
    expect(run.requests).toHaveLength(0);
  });

  test("scout web login at a terminal is the browser sign-in", async () => {
    const run = harness();
    await runWebCommand(run.context, ["login"], run.deps);
    expect(run.requests[0]!.url).toBe(`${HOST}/v1/cli/device/code`);
    expect(savedKey()).toBe(KEY);
  });
});
