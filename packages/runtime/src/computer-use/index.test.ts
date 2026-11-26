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
      const client = createScoutComputerClient({
        binaryPath,
        agentPort: 1, // guaranteed unreachable port for fast probe
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
    } finally {
      cleanup();
    }
  });
});
