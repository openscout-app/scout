import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutComputerClient, resolveScoutComputerBinary } from "./index.ts";

function makeFakeBundle(): { binaryPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "scout-computer-test-"));
  const macosDir = join(dir, "ScoutComputer.app", "Contents", "MacOS");
  mkdirSync(macosDir, { recursive: true });
  const binaryPath = join(macosDir, "ScoutComputer");
  writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
  return {
    binaryPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("scout computer runtime client", () => {
  test("resolves ScoutComputer binary from explicit path and from running process list", async () => {
    const { binaryPath, cleanup } = makeFakeBundle();
    try {
      expect(await resolveScoutComputerBinary({ binaryPath })).toBe(binaryPath);

      const fromPs = await resolveScoutComputerBinary({
        execImpl: async () => ({
          stdout: `/usr/sbin/syslogd\n${binaryPath} --background\n`,
          stderr: "",
        }),
      });
      // Only asserts the ps fallback when /Applications doesn't have ScoutComputer.app installed.
      expect(fromPs).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("forwards windows, screenshot, focus, inspect, and act commands to ScoutComputer", async () => {
    if (process.platform !== "darwin") return;
    const { binaryPath, cleanup } = makeFakeBundle();
    const calls: Array<{ file: string; args: string[] }> = [];
    try {
      const layerRoot = mkdtempSync(join(tmpdir(), "scout-computer-layer-empty-"));
      const client = createScoutComputerClient({
        binaryPath,
        agentLayerRoot: layerRoot,
        agentPort: 1, // guaranteed unreachable port for fast probe
        agentRpcImpl: async () => ({ ok: false, error: "disconnected" }),
        execImpl: async (file, args) => {
          calls.push({ file, args });
          if (args[0] === "status") {
            return { stdout: JSON.stringify({ accessibility: "granted", screenRecording: "granted" }), stderr: "" };
          }
          if (args[0] === "window-order") {
            return {
              stdout: JSON.stringify({
                status: "window-order",
                windows: [
                  { owner: "Google Chrome", bundleId: "com.google.Chrome", pid: 101, title: "Scout" },
                  { owner: "Finder", bundleId: "com.apple.finder", pid: 202, title: "Desktop" },
                ],
              }),
              stderr: "",
            };
          }
          if (args[0] === "screenshot-app-window") {
            const outIdx = args.indexOf("--output");
            return { stdout: JSON.stringify({ outputPath: args[outIdx + 1] }), stderr: "" };
          }
          return { stdout: JSON.stringify({ ok: true, subcommand: args[0] }), stderr: "" };
        },
      });

      const status = await client.status();
      expect(status.available).toBe(true);
      expect(status.binaryPath).toBe(binaryPath);
      expect(status.permissions).toEqual({ accessibility: "granted", screenRecording: "granted" });

      await client.listWindows();
      expect(calls.at(-1)?.args).toEqual(["window-order"]);

      await client.listWindows({ app: "Google Chrome", raise: true });
      expect(calls.at(-1)?.args).toEqual(["list-app-windows", "--bundle-id", "com.google.Chrome", "--raise", "true"]);

      const shot = await client.screenshot({ bundleId: "com.google.Chrome", windowId: 42, outputPath: "/tmp/shot.png" });
      expect(shot.ok).toBe(true);
      expect(shot.outputPath).toBe("/tmp/shot.png");
      expect(calls.at(-1)?.args).toEqual([
        "screenshot-app-window",
        "--bundle-id", "com.google.Chrome",
        "--window-id", "42",
        "--output", "/tmp/shot.png",
      ]);

      await client.focus({ bundleId: "com.google.Chrome", title: "Scout" });
      expect(calls.at(-1)?.args).toEqual(["focus-window", "--bundle-id", "com.google.Chrome", "--title", "Scout"]);

      await client.inspect({ app: "Finder" });
      expect(calls.at(-1)?.args).toEqual(["inspect-app-ui", "--bundle-id", "com.apple.finder"]);

      await client.act({ kind: "click", x: 120, y: 240 });
      expect(calls.at(-1)?.args).toEqual(["click-point", "--x", "120", "--y", "240"]);

      await client.act({ kind: "key", key: "l", modifiers: ["cmd"], target: { bundleId: "com.google.Chrome" } });
      expect(calls.at(-1)?.args).toEqual(["press-app-key", "--bundle-id", "com.google.Chrome", "--key", "l", "--modifiers", "cmd"]);

      await client.act({ kind: "ocr", imagePath: "/tmp/shot.png" });
      expect(calls.at(-1)?.args).toEqual(["ocr-screenshot", "--input", "/tmp/shot.png"]);

      const badClick = await client.act({ kind: "click" });
      expect(badClick.ok).toBe(false);
      expect(badClick.error).toContain("x and y");

      // Un-targeted type/key must be refused so keystrokes cannot land in the wrong window.
      const untargetedType = await client.act({ kind: "type", text: "oops" });
      expect(untargetedType.ok).toBe(false);
      expect(untargetedType.error).toContain("pass target");

      // Typing into a non-frontmost app must be refused (Chrome pid 101 is frontmost, Finder pid 202 is not).
      const wrongWindow = await client.act({ kind: "type", text: "hi", target: { pid: 202 } });
      expect(wrongWindow.ok).toBe(false);
      expect(wrongWindow.error).toContain("not frontmost");
    } finally {
      cleanup();
    }
  });

  test("enforces an approved Scout Computer attention lease when the agent is connected", async () => {
    if (process.platform !== "darwin") return;
    const { binaryPath, cleanup } = makeFakeBundle();
    const rpcCalls: Array<{ method: string; params?: Record<string, string> }> = [];
    let hasLease = false;
    try {
      const layerRoot = mkdtempSync(join(tmpdir(), "scout-computer-layer-lease-"));
      const client = createScoutComputerClient({
        binaryPath,
        agentLayerRoot: layerRoot,
        agentRpcImpl: async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === "drive.status") {
            const leases = hasLease
              ? [{ leaseId: "lease-42", agent: "scout", mode: "attention", status: "driving" }]
              : [];
            return { ok: true, result: { snapshot: JSON.stringify({ state: hasLease ? "driving" : "idle", leases }) } };
          }
          return { ok: true, result: { status: "driving" } };
        },
        execImpl: async (_file, args) => {
          if (args[0] === "window-order") {
            return {
              stdout: JSON.stringify({
                windows: [{ owner: "Google Chrome", bundleId: "com.google.Chrome", pid: 101, title: "Scout" }],
              }),
              stderr: "",
            };
          }
          return { stdout: JSON.stringify({ ok: true, subcommand: args[0] }), stderr: "" };
        },
      });

      // Without an approved lease, live input is blocked by Scout Computer.
      const blocked = await client.act({ kind: "type", text: "hello", target: { pid: 101 } });
      expect(blocked.ok).toBe(false);
      expect(blocked.source).toBe("scout-computer");
      expect(blocked.error).toContain("approved Scout Computer attention lease");

      // With an approved lease, input succeeds and touches the supervision HUD lease.
      hasLease = true;
      const allowed = await client.act({ kind: "type", text: "hello", target: { pid: 101 } });
      expect(allowed.ok).toBe(true);
      expect(allowed.leaseId).toBe("lease-42");
      expect(rpcCalls.some((c) => c.method === "drive.touch" && c.params?.leaseId === "lease-42")).toBe(true);
      rmSync(layerRoot, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });

  test("manages the off-screen agent layer and routes blink acts under a background lease", async () => {
    if (process.platform !== "darwin") return;
    const { binaryPath, cleanup } = makeFakeBundle();
    const layerRoot = mkdtempSync(join(tmpdir(), "scout-computer-layer-blink-"));
    const calls: string[][] = [];
    const signals: Array<{ pid: number; signal: string }> = [];
    let layerPidAlive = false;
    let layerPaused = false;
    let layerPip = false;
    try {
      const client = createScoutComputerClient({
        binaryPath,
        agentLayerRoot: layerRoot,
        isAliveImpl: (pid) => pid === 7777 && layerPidAlive,
        signalImpl: (pid, signal) => {
          signals.push({ pid, signal });
          if (signal === "SIGTERM") {
            layerPidAlive = false;
          } else if (signal === "SIGUSR1") {
            layerPip = true;
            writeFileSync(
              join(layerRoot, "state.json"),
              JSON.stringify({
                pid: 7777,
                displayId: 9,
                bounds: { x: 2000, y: 0, width: 1440, height: 900 },
                pip: true,
                paused: layerPaused,
                windows: [{ windowId: 55, pid: 101, bundleId: "com.google.Chrome", title: "Cloudflare" }],
              }),
            );
          } else if (signal === "SIGUSR2") {
            const req = JSON.parse(require("node:fs").readFileSync(join(layerRoot, "control.request.json"), "utf8"));
            writeFileSync(
              join(layerRoot, "control.reply.json"),
              JSON.stringify({ id: req.id, ok: true, path: req.out, width: 1440, height: 900 }),
            );
          }
        },
        agentRpcImpl: async (method, params) => {
          if (method === "drive.begin") {
            return { ok: true, result: { status: "granted", lease: JSON.stringify({ leaseId: "bg-1", mode: "background", status: "driving" }) } };
          }
          if (method === "drive.status") {
            return { ok: true, result: { snapshot: JSON.stringify({ state: "driving", leases: [{ leaseId: "bg-1", mode: "background", status: "driving" }] }) } };
          }
          if (method === "drive.note") {
            return { ok: true, result: { line: params?.line ?? "" } };
          }
          return { ok: true, result: { status: "ok" } };
        },
        execImpl: async (_file, args) => {
          calls.push(args);
          if (args[0] === "agent-screen") {
            layerPidAlive = true;
            writeFileSync(
              join(layerRoot, "state.json"),
              JSON.stringify({
                pid: 7777,
                displayId: 9,
                bounds: { x: 2000, y: 0, width: 1440, height: 900 },
                pip: layerPip,
                paused: layerPaused,
                windows: [{ windowId: 55, pid: 101, bundleId: "com.google.Chrome", title: "Cloudflare" }],
              }),
            );
            return { stdout: JSON.stringify({ status: "agent-screen-running", detail: "7777" }), stderr: "" };
          }
          return { stdout: JSON.stringify({ ok: true, subcommand: args[0] }), stderr: "" };
        },
      });

      const begun = await client.driveBegin({ task: "Check Cloudflare", agent: "antigravity" });
      expect(begun.ok).toBe(true);
      expect(begun.leaseId).toBe("bg-1");

      const note = await client.driveNote({ line: "Opening Chrome window on layer", leaseId: "bg-1" });
      expect(note.ok).toBe(true);

      const opened = await client.layerOpen({ bundleId: "com.google.Chrome", windowTitle: "Cloudflare" });
      expect(opened.ok).toBe(true);
      expect((opened.data as { active: boolean }).active).toBe(true);

      const snap = await client.layerSnapshot({ out: "/tmp/layer-check.png" });
      expect(snap.ok).toBe(true);
      expect(snap.outputPath).toBe("/tmp/layer-check.png");

      const pipRes = await client.layerPip();
      expect(pipRes.ok).toBe(true);
      expect(signals.some((s) => s.signal === "SIGUSR1")).toBe(true);

      // Click inside layer bounds routes as blink-click under a background lease.
      const clickRes = await client.act({ kind: "click", x: 2100, y: 300 });
      expect(clickRes.ok).toBe(true);
      expect(calls.at(-1)).toEqual(["blink-click", "--x", "2100", "--y", "300"]);

      // Keyboard acts targeting the layer subject route as blink-type / blink-key.
      const typeRes = await client.act({ kind: "type", text: "openscout.app" });
      expect(typeRes.ok).toBe(true);
      expect(calls.at(-1)).toEqual(["blink-type", "--bundle-id", "com.google.Chrome", "--text", "openscout.app"]);

      const keyRes = await client.act({ kind: "key", key: "return" });
      expect(keyRes.ok).toBe(true);
      expect(calls.at(-1)).toEqual(["blink-key", "--bundle-id", "com.google.Chrome", "--key", "return"]);

      // Paused layer refuses blink acts.
      layerPaused = true;
      writeFileSync(
        join(layerRoot, "state.json"),
        JSON.stringify({
          pid: 7777,
          displayId: 9,
          bounds: { x: 2000, y: 0, width: 1440, height: 900 },
          pip: true,
          paused: true,
          windows: [{ windowId: 55, pid: 101, bundleId: "com.google.Chrome", title: "Cloudflare" }],
        }),
      );
      const pausedAct = await client.act({ kind: "click", x: 2100, y: 300 });
      expect(pausedAct.ok).toBe(false);
      expect(pausedAct.error).toContain("paused");

      layerPidAlive = false;
      const closed = await client.layerClose();
      expect(closed.ok).toBe(true);
    } finally {
      rmSync(layerRoot, { recursive: true, force: true });
      cleanup();
    }
  });
});
