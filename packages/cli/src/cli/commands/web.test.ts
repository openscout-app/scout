import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveInstalledWebFullClient } from "@openscout/runtime/client";

import { createScoutCommandContext } from "../context.ts";
import {
  distKeyPath,
  fileDistKeyStore,
  keychainDistKeyStore,
  runWebCommand,
  type DistKeyStore,
  type ScoutWebCommandDeps,
} from "./web.ts";

const KEY = "osdist_0123456789abcdef";
const VERSION = "9.8.7";

let root: string;
let support: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scout-web-cmd-"));
  support = join(root, "support");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function packClient(version: string, profileVersion = version): Promise<Uint8Array<ArrayBuffer>> {
  const client = join(root, `client-${version}-${profileVersion}`);
  mkdirSync(join(client, "assets"), { recursive: true });
  writeFileSync(join(client, "index.html"), "<title>Scout</title>");
  writeFileSync(join(client, "assets", "app.js"), "Mission Control");
  writeFileSync(join(client, "scout-web-profile.json"), JSON.stringify({ profile: "full", version: profileVersion }));
  const tarball = join(root, `${version}-${profileVersion}.tar.gz`);
  await promisify(execFile)("tar", ["-czf", tarball, "-C", client, "."], { timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 });
  return new Uint8Array(readFileSync(tarball));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function harness(options: {
  tarball?: Uint8Array<ArrayBuffer>;
  digest?: string;
  env?: NodeJS.ProcessEnv;
  status?: number;
  restarted?: string[];
  keyStores?: DistKeyStore[];
  stdin?: string;
  json?: boolean;
} = {}) {
  const lines: string[] = [];
  const requests: Array<{ url: string; auth: string | null }> = [];
  const context = createScoutCommandContext({
    cwd: root,
    env: options.env ?? {},
    stdout: (line) => lines.push(line),
    stderr: () => undefined,
    isTty: false,
    outputMode: options.json ? "json" : "plain",
  });
  const deps: ScoutWebCommandDeps = {
    supportDirectory: support,
    version: VERSION,
    // Never the real Keychain from a test.
    keyStores: options.keyStores ?? [fileDistKeyStore(support)],
    readStdin: async () => options.stdin ?? "",
    restartWeb: async () => {
      options.restarted?.push("restart");
      return "http://127.0.0.1:43120";
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (options.status) return Response.json({ error: "nope" }, { status: options.status });
      if (url.endsWith("/v1/dist/whoami")) return Response.json({ login: "arach", label: "mini" });
      if (!options.tarball) return Response.json({ error: "not_published", version: VERSION }, { status: 404 });
      return new Response(options.tarball, {
        headers: { "x-openscout-sha256": options.digest ?? sha256(options.tarball) },
      });
    },
  };
  return { context, deps, lines, requests };
}

describe("scout web", () => {
  test.skipIf(process.platform !== "linux")("install leaves stdout usable for the next command even under GC", async () => {
    const tarball = await packClient(VERSION);
    const archive = join(root, "stdio.tar.gz");
    writeFileSync(archive, tarball);
    // Own the risky old-Bun state in a child, with real pollable stdio pipes.
    const child = Bun.spawn({
      cmd: [process.execPath, new URL("./fixtures/web-stdio.ts", import.meta.url).pathname, archive, support],
      env: { ...process.env, BUN_JSC_slowPathAllocsBetweenGCs: "3" },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "stdio survived install\n", stderr: "stdio regression finished\n" });
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 35_000);

  test("login checks the key with the host and saves it privately", async () => {
    const { context, deps, lines, requests } = harness();
    await runWebCommand(context, ["login", "--key", KEY], deps);
    expect(requests[0]).toEqual({ url: "https://console.openscout.app/v1/dist/whoami", auth: `Bearer ${KEY}` });
    expect(readFileSync(distKeyPath(support), "utf8").trim()).toBe(KEY);
    expect(statSync(distKeyPath(support)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain('Signed in as arach (key "mini")');

    await expect(runWebCommand(context, ["login", "--key", "osmcp_wrong"], deps)).rejects.toThrow("download key");
  });

  test("a rejected key is not saved", async () => {
    const { context, deps } = harness({ status: 401 });
    await expect(runWebCommand(context, ["login", "--key", KEY], deps)).rejects.toThrow("not accepted");
    expect(existsSync(distKeyPath(support))).toBe(false);
  });

  test("install downloads, verifies and installs the full client for this version, then restarts web", async () => {
    const restarted: string[] = [];
    const tarball = await packClient(VERSION);
    const { context, deps, lines, requests } = harness({ tarball, env: { SCOUT_DIST_KEY: KEY }, restarted });
    await runWebCommand(context, ["install"], deps);

    expect(requests[0]!.url).toBe(`https://console.openscout.app/v1/dist/web-full/${VERSION}`);
    const installed = resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support });
    expect(installed).toBe(join(support, "web", "full", VERSION));
    expect(readFileSync(join(installed!, "index.html"), "utf8")).toContain("Scout");
    expect(restarted).toEqual(["restart"]);
    expect(lines.join("\n")).toContain(`Installed the full web app ${VERSION}`);

    // Nothing left behind from the install.
    expect(readdirSync(join(support, "web", "full"))).toEqual([VERSION]);

    // Other versions are never served by this server, even if present.
    expect(resolveInstalledWebFullClient("9.8.6", { env: {}, supportDirectory: support })).toBeNull();
    expect(resolveInstalledWebFullClient(VERSION, { env: { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" }, supportDirectory: support })).toBeNull();

    const again = harness({ tarball, env: { SCOUT_DIST_KEY: KEY } });
    await runWebCommand(again.context, ["install"], again.deps);
    expect(again.requests).toHaveLength(0);
    expect(again.lines.join("\n")).toContain("already installed");
  });

  test("a checksum mismatch or a client for another version is never installed", async () => {
    const tarball = await packClient(VERSION);
    const tampered = harness({ tarball, digest: "0".repeat(64), env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(tampered.context, ["install"], tampered.deps)).rejects.toThrow("Checksum mismatch");

    const wrong = harness({ tarball: await packClient(VERSION, "1.0.0"), env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(wrong.context, ["install"], wrong.deps)).rejects.toThrow("isn't the full web app");

    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
    expect(readdirSync(join(support, "web", "full"))).toEqual([]);
  });

  test("a stuck unpack child has a hard deadline, reports its error and leaves no partial install", async () => {
    const tarball = await packClient(VERSION);
    const { context, deps } = harness({ tarball, env: { SCOUT_DIST_KEY: KEY } });
    const child = spyOn(childProcess, "execFile").mockImplementation(((_file: string, ...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      callback(Object.assign(new Error("tar ETIMEDOUT"), { code: "ETIMEDOUT" }), "", "partial tar diagnostic");
      return {};
    }) as typeof childProcess.execFile);
    try {
      await expect(runWebCommand(context, ["install", "--no-restart"], deps)).rejects.toThrow("Couldn't unpack the download: tar ETIMEDOUT");
      expect(child).toHaveBeenCalledWith("tar", expect.any(Array), expect.objectContaining({ timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 }), expect.any(Function));
      expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
      expect(readdirSync(join(support, "web", "full"))).toEqual([]);
    } finally { child.mockRestore(); }
  });

  test("a stalled body is cancelled at the download deadline and leaves no partial install", async () => {
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { cancelled = true; },
    });
    const run = harness({ env: { SCOUT_DIST_KEY: KEY } });
    // Cleanup-only EOF: without the consumer deadline this yields a normal test failure, not a hung runner.
    const watchdog = setTimeout(() => { if (!cancelled) controller.close(); }, 750);
    try { await expect(runWebCommand(run.context, ["install", "--no-restart"], {
      ...run.deps, downloadTimeoutMs: 25,
      // Deliberately not connected to fetch's signal: the consumer must own a deadline.
      fetchImpl: async () => new Response(body, { headers: { "x-openscout-sha256": "0".repeat(64) } }),
    })).rejects.toThrow(/abort/i); } finally { clearTimeout(watchdog); }
    expect(cancelled).toBe(true);
    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
    expect(readdirSync(join(support, "web", "full"))).toEqual([]);
  });

  test("install explains a missing key and an unpublished version", async () => {
    const none = harness();
    await expect(runWebCommand(none.context, ["install"], none.deps)).rejects.toThrow("No download key. Sign in first: scout auth login");
    expect(none.requests).toHaveLength(0);

    const unpublished = harness({ env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(unpublished.context, ["install"], unpublished.deps)).rejects.toThrow(`isn't published for Scout ${VERSION}`);
  });

  test("status reports what is served; uninstall leaves no bundled app", async () => {
    const tarball = await packClient(VERSION);
    const run = harness({ tarball, env: { SCOUT_DIST_KEY: KEY } });
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("serves     no bundled web app");

    await runWebCommand(run.context, ["install", "--no-restart"], run.deps);
    run.lines.length = 0;
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("serves     the full web app");

    await runWebCommand(run.context, ["uninstall"], run.deps);
    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
  });

  test("login without --key reads a piped key", async () => {
    const { context, deps } = harness({ stdin: `${KEY}\n` });
    await runWebCommand(context, ["login"], deps);
    expect(readFileSync(distKeyPath(support), "utf8").trim()).toBe(KEY);
  });

  test("a fresh Basic install explains how to get Full without exposing a key", async () => {
    const run = harness({ json: true });
    await runWebCommand(run.context, ["status"], run.deps);
    expect(JSON.parse(run.lines[0]!)).toMatchObject({
      serves: "none", reason: "not-installed", installed: null, installedVersions: [],
      nextSteps: ["scout auth login", "scout web install"],
    });
    expect(run.requests).toHaveLength(0);
  });

  test("an upgraded CLI diagnoses the old Full client and recovers with the saved key", async () => {
    const previousVersion = "9.8.6";
    const previous = harness({ tarball: await packClient(previousVersion), env: { SCOUT_DIST_KEY: KEY } });
    await fileDistKeyStore(support).write(KEY);
    await runWebCommand(previous.context, ["install", "--no-restart"], { ...previous.deps, version: previousVersion });

    const current = harness({ tarball: await packClient(VERSION), json: true });
    await runWebCommand(current.context, ["status"], current.deps);
    expect(JSON.parse(current.lines[0]!)).toMatchObject({
      version: VERSION, serves: "none", reason: "version-mismatch", installed: null,
      installedVersions: [previousVersion], nextSteps: ["scout web install"],
    });
    expect(current.lines[0]).not.toContain(KEY);
    expect(current.requests).toHaveLength(0);

    const plain = harness();
    await runWebCommand(plain.context, ["status"], plain.deps);
    expect(plain.lines.join("\n")).toContain(`does not match Scout ${VERSION}`);
    expect(plain.lines.join("\n")).toContain("Next: scout web install");

    await runWebCommand(current.context, ["install", "--no-restart"], current.deps);
    current.lines.length = 0;
    await runWebCommand(current.context, ["status"], current.deps);
    expect(JSON.parse(current.lines[0]!)).toMatchObject({
      serves: "full", reason: "full-installed", installedVersions: [VERSION], nextSteps: [],
    });
  });

  test("a stalled upgrade preserves the old Full client and key after cancelling its download", async () => {
    const previousVersion = "9.8.6";
    const previous = harness({ tarball: await packClient(previousVersion), env: { SCOUT_DIST_KEY: KEY } });
    await fileDistKeyStore(support).write(KEY);
    await runWebCommand(previous.context, ["install", "--no-restart"], { ...previous.deps, version: previousVersion });
    const tarball = await packClient(VERSION);
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(tarball); }, // All bytes, but no EOF.
      cancel() { cancelled = true; },
    });
    const restarted: string[] = [];
    const current = harness({ json: true, restarted });
    // Cleanup-only EOF: without the consumer deadline this yields a normal test failure, not a hung runner.
    const watchdog = setTimeout(() => { if (!cancelled) controller.close(); }, 750);
    try { await expect(runWebCommand(current.context, ["install"], {
      ...current.deps, downloadTimeoutMs: 25,
      fetchImpl: async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(body, { headers: { "x-openscout-sha256": sha256(tarball) } });
      },
    })).rejects.toThrow(/abort/i); } finally { clearTimeout(watchdog); }
    expect(cancelled).toBe(true);
    expect(restarted).toEqual([]);
    expect(await fileDistKeyStore(support).read()).toBe(KEY);
    expect(resolveInstalledWebFullClient(previousVersion, { env: {}, supportDirectory: support })).not.toBeNull();
    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
    expect(readdirSync(join(support, "web", "full"))).toEqual([previousVersion]);
    await runWebCommand(current.context, ["status"], current.deps);
    expect(JSON.parse(current.lines[0]!)).toMatchObject({ reason: "version-mismatch", installedVersions: [previousVersion] });
  });

  test("forcing Basic preserves the installed Full path and explains the override", async () => {
    const run = harness({ tarball: await packClient(VERSION), env: { SCOUT_DIST_KEY: KEY, OPENSCOUT_WEB_CLIENT_PROFILE: " basic " }, json: true });
    await runWebCommand(run.context, ["install", "--no-restart"], run.deps);
    run.lines.length = 0;
    await runWebCommand(run.context, ["status"], run.deps);
    const status = JSON.parse(run.lines[0]!);
    expect(status).toMatchObject({
      serves: "none", reason: "basic-forced", installed: join(support, "web", "full", VERSION),
      installedVersions: [VERSION],
    });
    expect(status.nextSteps[0]).toContain("remove OPENSCOUT_WEB_CLIENT_PROFILE=basic");
    expect(run.lines[0]).not.toContain(KEY);
  });

  test("partial, hidden, and mismatched installs are not reported as another usable version", async () => {
    for (const [name, profile] of [
      [".install-in-progress", { profile: "full", version: ".install-in-progress" }],
      ["9.8.5", { profile: "basic", version: "9.8.5" }],
      ["9.8.4", { profile: "full", version: "9.8.3" }],
    ] as const) {
      const directory = join(support, "web", "full", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "index.html"), "<title>Scout</title>");
      writeFileSync(join(directory, "scout-web-profile.json"), JSON.stringify(profile));
    }
    const partial = join(support, "web", "full", "9.8.2");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "scout-web-profile.json"), JSON.stringify({ profile: "full", version: "9.8.2" }));
    const run = harness({ json: true });
    await runWebCommand(run.context, ["status"], run.deps);
    expect(JSON.parse(run.lines[0]!)).toMatchObject({ reason: "not-installed", installedVersions: [] });
  });

  test("a Basic override on a fresh install still explains that Full must be installed", async () => {
    const run = harness({ json: true, env: { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" } });
    await runWebCommand(run.context, ["status"], run.deps);
    const status = JSON.parse(run.lines[0]!);
    expect(status.reason).toBe("basic-forced");
    expect(status.nextSteps).toContain("scout auth login");
    expect(status.nextSteps).toContain("scout web install");
    expect(status.nextSteps.at(-1)).toContain("remove OPENSCOUT_WEB_CLIENT_PROFILE=basic");
  });

  test("an unpublished upgrade leaves the old Full install and saved key intact", async () => {
    const previousVersion = "9.8.6";
    const previous = harness({ tarball: await packClient(previousVersion), env: { SCOUT_DIST_KEY: KEY } });
    await fileDistKeyStore(support).write(KEY);
    await runWebCommand(previous.context, ["install", "--no-restart"], { ...previous.deps, version: previousVersion });
    const restarted: string[] = [];
    const current = harness({ json: true, restarted });
    await expect(runWebCommand(current.context, ["install"], current.deps)).rejects.toThrow(`isn't published for Scout ${VERSION}`);
    expect(restarted).toEqual([]);
    expect(await fileDistKeyStore(support).read()).toBe(KEY);
    expect(resolveInstalledWebFullClient(previousVersion, { env: {}, supportDirectory: support })).not.toBeNull();
    await runWebCommand(current.context, ["status"], current.deps);
    expect(JSON.parse(current.lines[0]!)).toMatchObject({
      serves: "none", reason: "version-mismatch", installedVersions: [previousVersion], nextSteps: ["scout web install"],
    });
  });

  test("an encrypted store wins, and the plain file is cleared once it takes the key", async () => {
    const vault = new Map<string, string>();
    const encrypted: DistKeyStore = {
      where: "test vault",
      encrypted: true,
      read: async () => vault.get("key") ?? null,
      write: async (key) => (vault.set("key", key), true),
      remove: async () => vault.delete("key"),
    };
    const file = fileDistKeyStore(support);
    await file.write("osdist_stale");

    const run = harness({ keyStores: [encrypted, file] });
    await runWebCommand(run.context, ["login", "--key", KEY], run.deps);
    expect(vault.get("key")).toBe(KEY);
    expect(existsSync(distKeyPath(support))).toBe(false);
    expect(run.lines.join("\n")).toContain("Key saved in test vault");

    run.lines.length = 0;
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("key        test vault");

    await runWebCommand(run.context, ["logout"], run.deps);
    expect(vault.size).toBe(0);
  });

  test("the Keychain store passes the key on stdin, never in argv", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const store = keychainDistKeyStore(async (command, args, input) => {
      calls.push({ command, args, input });
      return { status: 0, stdout: "" };
    });
    expect(await store.write(KEY)).toBe(true);
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.args.join(" ")).not.toContain(KEY);
    expect(calls[0]!.input).toContain(KEY);
    expect(await store.write('osdist_"; rm -rf ~')).toBe(false);
  });

  test("logout clears every store, and a store that fails to save falls through to the next", async () => {
    const removed: string[] = [];
    const failing: DistKeyStore = {
      where: "stuck vault",
      encrypted: true,
      read: async () => null,
      write: async () => false,
      remove: async () => (removed.push("stuck vault"), false),
    };
    const run = harness({ keyStores: [failing, fileDistKeyStore(support)] });
    await runWebCommand(run.context, ["login", "--key", KEY], run.deps);
    expect(run.lines.join("\n")).toContain(`Key saved in ${distKeyPath(support)}`);
    expect(removed).toEqual(["stuck vault"]);

    run.lines.length = 0;
    await runWebCommand(run.context, ["logout"], run.deps);
    expect(removed).toEqual(["stuck vault", "stuck vault"]);
    expect(existsSync(distKeyPath(support))).toBe(false);
    expect(run.lines.join("\n")).toContain("Download key removed.");
  });
});
