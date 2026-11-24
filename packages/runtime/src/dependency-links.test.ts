import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describeDependencyLinkReport, describeRuntimeFault, inspectDependencyLinks, resolveRuntimeCheckoutRoot } from "./dependency-links.js";
import { projectionRetryDelayMs } from "./sqlite-projection-worker.js";

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function storeEntry(root: string, entry: string, name: string): string {
  const path = join(root, "node_modules", ".bun", entry, "node_modules", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "index.js"), "export {};\n");
  return path;
}
function link(from: string, to: string): void {
  mkdirSync(dirname(from), { recursive: true });
  symlinkSync(relative(dirname(from), to), from);
}
/** A core checkout and a sibling checkout whose install relinked core's packages. */
function layout() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "dependency-links-")));
  scratch.push(parent);
  const core = join(parent, "core"), sibling = join(parent, "sibling");
  mkdirSync(join(core, "packages", "runtime"), { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  return { parent, core, sibling };
}

describe("dependency links", () => {
  test("relinks a link that points into another checkout's store to this checkout's identical entry", () => {
    const { core, sibling } = layout();
    const own = storeEntry(core, "drizzle-orm@0.45.2+abc", "drizzle-orm");
    link(join(core, "packages", "runtime", "node_modules", "drizzle-orm"), storeEntry(sibling, "drizzle-orm@0.45.2+abc", "drizzle-orm"));
    link(join(core, "packages", "runtime", "node_modules", "@scope", "pkg"), storeEntry(sibling, "@scope+pkg@1.0.0", "@scope/pkg"));
    storeEntry(core, "@scope+pkg@1.0.0", "@scope/pkg");

    const report = inspectDependencyLinks(core);
    expect(report.escaped.map(item => [relative(core, item.link), item.repaired]).sort()).toEqual([
      ["packages/runtime/node_modules/@scope/pkg", true],
      ["packages/runtime/node_modules/drizzle-orm", true],
    ]);
    expect(realpathSync(join(core, "packages", "runtime", "node_modules", "drizzle-orm"))).toBe(own);
    expect(describeDependencyLinkReport(report)).toBeNull();
    // A second pass finds nothing to do.
    expect(inspectDependencyLinks(core).escaped).toEqual([]);
  });

  test("repairs a dangling link once the other checkout is deleted", () => {
    const { core, sibling } = layout();
    storeEntry(core, "zod@4.4.3", "zod");
    const path = join(core, "packages", "runtime", "node_modules", "zod");
    link(path, storeEntry(sibling, "zod@4.4.3", "zod"));
    renameSync(sibling, `${sibling}-deleted`);

    const [item] = inspectDependencyLinks(core).escaped;
    expect(item).toMatchObject({ dangling: true, repaired: true });
    expect(existsSync(join(path, "index.js"))).toBe(true);
  });

  test("reports a link it cannot repair, and names the fix", () => {
    const { core, sibling } = layout();
    mkdirSync(join(core, "node_modules"), { recursive: true });
    const path = join(core, "packages", "runtime", "node_modules", "hono");
    link(path, storeEntry(sibling, "hono@4.12.10", "hono"));
    renameSync(sibling, `${sibling}-deleted`);

    const report = inspectDependencyLinks(core);
    expect(report.escaped).toHaveLength(1);
    expect(report.escaped[0]).toMatchObject({ dangling: true, repaired: false, reason: "this checkout has no hono@4.12.10 store entry" });
    expect(readlinkSync(path)).toContain("sibling");
    expect(describeDependencyLinkReport(report)).toBe(
      `1 dependency link points into another checkout that was deleted (packages/runtime/node_modules/hono). Run \`bun install\` in ${core}, then restart the runtime.`,
    );
  });

  test("leaves links inside the checkout and deliberate links to other trees alone", () => {
    const { parent, core } = layout();
    link(join(core, "packages", "runtime", "node_modules", "inside"), storeEntry(core, "inside@1.0.0", "inside"));
    mkdirSync(join(parent, "elsewhere"), { recursive: true });
    link(join(core, "packages", "runtime", "node_modules", "elsewhere"), join(parent, "elsewhere"));
    expect(inspectDependencyLinks(core).escaped).toEqual([]);
  });

  test("applies only to a workspace checkout that holds this runtime package", () => {
    const { core } = layout();
    mkdirSync(join(core, "node_modules"), { recursive: true });
    expect(resolveRuntimeCheckoutRoot(join(core, "packages", "runtime"))).toBe(core);
    rmSync(join(core, "package.json"));
    expect(resolveRuntimeCheckoutRoot(join(core, "packages", "runtime"))).toBeNull();
  });

  test("names the cause when dependency code went missing", () => {
    const message = 'SyntaxError: ENOENT reading "/work/sibling/node_modules/.bun/drizzle-orm@0.45.2+abc/node_modules/drizzle-orm/index.js"';
    expect(describeRuntimeFault(message, "/work/core")).toBe(
      "Runtime code is missing: drizzle-orm resolved to /work/sibling/node_modules/.bun/drizzle-orm@0.45.2+abc/node_modules/drizzle-orm/index.js, which no longer exists."
        + " That path is outside this checkout (/work/core); another checkout's install relinked it and was then deleted."
        + " Run `bun install` in /work/core and restart the runtime; a running process cannot reload a moved dependency.",
    );
    expect(describeRuntimeFault('ENOENT reading "/x/node_modules/.bun/@scope+pkg@1/node_modules/@scope/pkg/a.js"', null))
      .toStartWith("Runtime code is missing: @scope/pkg resolved to");
    expect(describeRuntimeFault("sqlite projection worker exited (1)", "/work/core")).toBe("sqlite projection worker exited (1)");
  });
});

describe("projection retry", () => {
  test("backs off from one second to one minute", () => {
    expect([0, 1, 2, 3, 6, 7, 50].map(projectionRetryDelayMs)).toEqual([1_000, 1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
  });
});
