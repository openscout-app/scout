import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScoutCommandContext } from "../context.ts";
import { runInstanceCommand } from "./instance.ts";

/** A registry with one claimed instance whose root lives at `root`. */
function registryFixture(portBase: number, root?: string) {
  const dir = mkdtempSync(join(tmpdir(), "openscout-instance-cli-"));
  const registry = join(dir, "registry");
  const instanceRoot = root ?? join(dir, "dev-live");
  mkdirSync(instanceRoot, { recursive: true });
  mkdirSync(join(registry, ".slots"), { recursive: true });
  mkdirSync(join(registry, ".claims"), { recursive: true });
  writeFileSync(join(registry, ".slots", String(portBase)), "dev-live\n");
  writeFileSync(join(registry, ".claims", "dev-live.json"), JSON.stringify({ portBase, root: instanceRoot, claimedAt: Date.now() }));
  return { dir, registry, root: instanceRoot, // HOME keeps repair off the developer's own instance roots.
    env: { ...process.env, HOME: dir, OPENSCOUT_INSTANCE_REGISTRY: registry } };
}

/**
 * A listener inside the instance port range (24400–30399): the block probed
 * around it (base … base+49) can never contain a prod port or an ephemeral one.
 */
function listenInInstanceRange(): { server: ReturnType<typeof Bun.serve>; portBase: number } {
  for (let base = 30350; base >= 24400; base -= 50) {
    try {
      const server = Bun.serve({ port: base + 10, hostname: "127.0.0.1", fetch: () => new Response("web") });
      return { server, portBase: base };
    } catch {
      // taken; try another block
    }
  }
  throw new Error("no free block in the instance range");
}

describe("scout instance release", () => {
  test("M5: refused while any port of the block answers, not only the broker", async () => {
    // Web (offset 10) is up while the broker port is down.
    const { server, portBase } = listenInInstanceRange();
    const fixture = registryFixture(portBase);
    try {
      const context = createScoutCommandContext({ env: fixture.env, stdout: () => {} });
      await expect(runInstanceCommand(context, ["release", "Dev_Live"])).rejects.toThrow(`port ${portBase + 10}`);
    } finally {
      server.stop(true);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("refused while a recorded pid is alive; released (normalized name) once nothing runs", async () => {
    const fixture = registryFixture(29950);
    try {
      mkdirSync(join(fixture.root, "pairing"), { recursive: true });
      writeFileSync(join(fixture.root, "pairing", "runtime.pid"), `${process.pid}\n`);
      const context = createScoutCommandContext({ env: fixture.env, stdout: () => {} });
      await expect(runInstanceCommand(context, ["release", "dev-live"])).rejects.toThrow(`pid ${process.pid}`);
      rmSync(join(fixture.root, "pairing", "runtime.pid"));
      const lines: string[] = [];
      await runInstanceCommand(createScoutCommandContext({ env: fixture.env, stdout: (line) => lines.push(line) }), ["release", "Dev_Live"]);
      expect(lines.join("\n")).toContain("Released dev-live");
      expect(existsSync(join(fixture.registry, ".slots", "29950"))).toBe(false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("R4: --purge refuses a root reached through an intermediate symlink that escapes the instances tree", async () => {
    // The instances tree is injected (OPENSCOUT_INSTANCE_REGISTRY); a root
    // under a symlinked directory inside it that points elsewhere must not be
    // deleted, even though it is lexically inside the tree.
    const outside = mkdtempSync(join(tmpdir(), "openscout-purge-outside-"));
    const victim = join(outside, "x");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "important");
    const fakeHome = mkdtempSync(join(tmpdir(), "openscout-purge-home-"));
    const instances = join(fakeHome, ".openscout", "instances");
    mkdirSync(join(instances, ".slots"), { recursive: true });
    mkdirSync(join(instances, ".claims"), { recursive: true });
    symlinkSync(outside, join(instances, "link"));
    const root = join(instances, "link", "x");
    writeFileSync(join(instances, ".slots", "29900"), "dev-live\n");
    writeFileSync(join(instances, ".claims", "dev-live.json"), JSON.stringify({ portBase: 29900, root, claimedAt: Date.now() }));
    try {
      const context = createScoutCommandContext({ env: { ...process.env, OPENSCOUT_INSTANCE_REGISTRY: instances }, stdout: () => {} });
      await expect(runInstanceCommand(context, ["release", "dev-live", "--purge"])).rejects.toThrow("refusing to purge");
      expect(existsSync(join(victim, "keep.txt"))).toBe(true);
      expect(existsSync(join(instances, ".claims", "dev-live.json"))).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("--purge deletes a root that really is inside the instances tree", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "openscout-purge-home-"));
    const instances = join(fakeHome, ".openscout", "instances");
    const root = join(instances, "dev-live");
    mkdirSync(join(instances, ".slots"), { recursive: true });
    mkdirSync(join(instances, ".claims"), { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(instances, ".slots", "29800"), "dev-live\n");
    writeFileSync(join(instances, ".claims", "dev-live.json"), JSON.stringify({ portBase: 29800, root, claimedAt: Date.now() }));
    try {
      const context = createScoutCommandContext({ env: { ...process.env, OPENSCOUT_INSTANCE_REGISTRY: instances }, stdout: () => {} });
      await runInstanceCommand(context, ["release", "dev-live", "--purge"]);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(join(instances, ".claims", "dev-live.json"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("release without --purge marks the root released", async () => {
    const fixture = registryFixture(29750);
    try {
      await runInstanceCommand(createScoutCommandContext({ env: fixture.env, stdout: () => {} }), ["release", "dev-live"]);
      expect(existsSync(join(fixture.root, ".released"))).toBe(true);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an unreadable claim is reported with the repair command; repair is refused on a healthy registry", async () => {
    const fixture = registryFixture(29850);
    // Repair also scans <home>/.openscout/instances for instance roots. Give
    // it a home of its own so other instances on this host stay out of view.
    const home = join(fixture.dir, "home");
    mkdirSync(join(home, ".openscout", "instances"), { recursive: true });
    try {
      const lines: string[] = [];
      const context = createScoutCommandContext({ env: { ...fixture.env, HOME: home }, stdout: (line) => lines.push(line) });
      await runInstanceCommand(context, ["repair"]);
      expect(lines.join("\n")).toContain("healthy; nothing to repair");
      writeFileSync(join(fixture.registry, ".claims", "dev-live.json"), "{ broken");
      lines.length = 0;
      await runInstanceCommand(context, ["list"]);
      expect(lines.join("\n")).toContain("unreadable claim for dev-live: run `scout instance repair`");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
