import { expect, test, spyOn } from "bun:test";

import { meshBridgeHelp, meshBridgeSecretDefaults, runMeshBridgeLaunchctl, runMeshBridgeCommand } from "./mesh-bridge.ts";
import type { ScoutCommandContext } from "../context.ts";

test("Linux self-service commands stop before authentication or macOS utilities", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected spawn"); });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("unexpected spawnSync"); });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("unexpected authentication"); }) as unknown as typeof fetch);
  const previousExit = process.exitCode;
  const errors: string[] = [];
  try {
    await withPlatform("linux", async () => {
      for (const command of ["connect", "disconnect", "token"]) {
        await runMeshBridgeCommand({ stderr: (value: string) => errors.push(value), stdout: () => {} } as unknown as ScoutCommandContext, [command]);
        expect(process.exitCode).toBe(1);
      }
    });
    expect(errors).toHaveLength(3);
    expect(errors.every(value => value.includes("token-file"))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore(); spawnSync.mockRestore(); fetchSpy.mockRestore(); process.exitCode = previousExit ?? 0;
  }
});

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restore = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("linux mesh-bridge defaults use a mode-0600 token file and do not call launchctl", () => {
  withPlatform("linux", () => {
    expect(meshBridgeSecretDefaults({
      explicitToken: false,
      supportDirectory: "/var/lib/openscout",
    })).toEqual({ tokenFile: "/var/lib/openscout/mcp-bridge.token" });
    expect(meshBridgeSecretDefaults({
      explicitToken: true,
      supportDirectory: "/var/lib/openscout",
    })).toEqual({});
    let spawned = false;
    const result = runMeshBridgeLaunchctl(["print", "gui/1/app.openscout.mcp-bridge"], () => {
      spawned = true;
      throw new Error("launchctl spawned");
    });
    expect(spawned).toBe(false);
    expect(result).toEqual({ ok: false, output: "launchctl is not applicable off darwin" });
    expect(meshBridgeHelp()).toContain("mode-0600 file");
    expect(meshBridgeHelp()).not.toContain("--token-keychain");
  });
});

test("darwin mesh-bridge defaults stay on the keychain service", () => {
  withPlatform("darwin", () => {
    expect(meshBridgeSecretDefaults({
      explicitToken: false,
      supportDirectory: "/Users/you/Library/Application Support/OpenScout",
    })).toEqual({ tokenKeychainService: "OPENSCOUT_MCP_BRIDGE_TOKEN" });
    expect(meshBridgeSecretDefaults({
      explicitToken: true,
      supportDirectory: "/Users/you/Library/Application Support/OpenScout",
    })).toEqual({});
    expect(meshBridgeHelp()).toContain("--token-keychain <service>");
    expect(meshBridgeHelp()).toContain("OPENSCOUT_MCP_BRIDGE_TOKEN");
  });
});
