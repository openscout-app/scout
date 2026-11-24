import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A package link in this checkout that resolves outside it.
 *
 * A sibling repository whose workspaces list this checkout's packages (for
 * example `../scout/packages/*`) rewrites their `node_modules` links into its
 * own install store on every install. When that sibling checkout is deleted,
 * the links dangle, and a long-lived runtime keeps reading the deleted path:
 * Bun caches a resolved real path for the life of the process.
 */
export type EscapedDependencyLink = {
  link: string;
  target: string;
  /** The target no longer exists. */
  dangling: boolean;
  /** Relinked to this checkout's own store entry. */
  repaired: boolean;
  /** Why it could not be repaired. */
  reason?: string;
};

export type DependencyLinkReport = {
  root: string;
  checkedAt: number;
  links: number;
  escaped: EscapedDependencyLink[];
};

const STORE_ENTRY = /[\\/]node_modules[\\/]\.bun[\\/]([^\\/]+)[\\/]node_modules[\\/](.+)$/;
const REPORT_KEY = Symbol.for("openscout.dependencyLinks");

/** The workspace checkout that holds this runtime package, or null for an installed package. */
export function resolveRuntimeCheckoutRoot(packageDir: string): string | null {
  const root = resolve(packageDir, "..", "..");
  try {
    if (realpathSync(join(root, "packages", "runtime")) !== realpathSync(packageDir)) return null;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: unknown };
    if (!manifest.workspaces) return null;
    return existsSync(join(root, "node_modules")) ? root : null;
  } catch {
    return null;
  }
}

let ownRoot: string | null | undefined;
/** The checkout this runtime runs from (src/ or dist/ sit one level under the package). */
export function runtimeCheckoutRoot(): string | null {
  if (ownRoot === undefined) ownRoot = resolveRuntimeCheckoutRoot(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  return ownRoot;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function linkDirectories(root: string): string[] {
  const directories = [join(root, "node_modules")];
  try {
    for (const name of readdirSync(join(root, "packages"))) directories.push(join(root, "packages", name, "node_modules"));
  } catch { /* No packages directory. */ }
  return directories.filter(directory => existsSync(directory));
}

function linksIn(directory: string): string[] {
  const links: string[] = [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return links; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(directory, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink()) links.push(path);
    else if (name.startsWith("@") && stat.isDirectory()) links.push(...linksIn(path));
  }
  return links;
}

/**
 * Find links that resolve into another checkout's install store, and point
 * each one back at this checkout's identical store entry when it has one.
 * Bun names a store entry by package, version and resolved peers, so the
 * same entry name is the same install.
 */
export function inspectDependencyLinks(root: string, options: { repair?: boolean; now?: () => number } = {}): DependencyLinkReport {
  const realRoot = realpathSync(root);
  const escaped: EscapedDependencyLink[] = [];
  let count = 0;
  for (const directory of linkDirectories(root)) {
    for (const link of linksIn(directory)) {
      count++;
      let raw: string;
      try { raw = readlinkSync(link); } catch { continue; }
      const target = resolve(dirname(link), raw);
      // Compare the target as written: a realpath of a deleted target fails.
      let realTarget = target;
      try { realTarget = realpathSync(target); } catch { /* Dangling. */ }
      if (within(root, target) || within(realRoot, realTarget)) continue;
      const entry = STORE_ENTRY.exec(target);
      if (!entry) continue; // A deliberate link to another tree, not an install store.
      const dangling = !existsSync(target);
      const local = join(root, "node_modules", ".bun", entry[1]!, "node_modules", entry[2]!);
      const item: EscapedDependencyLink = { link, target, dangling, repaired: false };
      if (!existsSync(local)) {
        item.reason = `this checkout has no ${entry[1]} store entry`;
      } else if (options.repair !== false) {
        const temporary = `${link}.openscout-relink-${process.pid}`;
        try {
          symlinkSync(relative(dirname(link), local), temporary);
          renameSync(temporary, link);
          item.repaired = true;
        } catch (error) {
          try { unlinkSync(temporary); } catch { /* Not created. */ }
          item.reason = error instanceof Error ? error.message : String(error);
        }
      }
      escaped.push(item);
    }
  }
  return { root, checkedAt: (options.now ?? Date.now)(), links: count, escaped };
}

/** Launcher and runtime share the last report through the process. */
export function recordDependencyLinkReport(report: DependencyLinkReport): void {
  (globalThis as Record<symbol, unknown>)[REPORT_KEY] = report;
}
export function lastDependencyLinkReport(): DependencyLinkReport | null {
  return ((globalThis as Record<symbol, unknown>)[REPORT_KEY] as DependencyLinkReport | undefined) ?? null;
}

/** Plain words for a health flag, or null when every link stays inside the checkout. */
export function describeDependencyLinkReport(report: DependencyLinkReport): string | null {
  const open = report.escaped.filter(item => !item.repaired);
  if (!open.length) return null;
  const names = open.slice(0, 3).map(item => relative(report.root, item.link)).join(", ");
  const more = open.length > 3 ? ` and ${open.length - 3} more` : "";
  const dangling = open.some(item => item.dangling);
  return `${open.length} dependency link${open.length === 1 ? "" : "s"} point${open.length === 1 ? "s" : ""} into another checkout`
    + `${dangling ? " that was deleted" : ""} (${names}${more}). Run \`bun install\` in ${report.root}, then restart the runtime.`;
}

const MISSING_CODE = /ENOENT[^"]*"([^"]*[\\/]node_modules[\\/][^"]+)"/;

/**
 * Name the cause when a lazy load fails because dependency code vanished.
 * Returns the input unchanged for any other error.
 */
export function describeRuntimeFault(message: string, root: string | null = runtimeCheckoutRoot()): string {
  const match = MISSING_CODE.exec(message);
  if (!match) return message;
  const path = match[1]!;
  const entry = STORE_ENTRY.exec(path);
  const name = entry ? entry[2]!.split(/[\\/]/).slice(0, entry[2]!.startsWith("@") ? 2 : 1).join("/") : "a dependency";
  const outside = root !== null && !within(root, path);
  return `Runtime code is missing: ${name} resolved to ${path}, which no longer exists.`
    + (outside ? ` That path is outside this checkout (${root}); another checkout's install relinked it and was then deleted.` : "")
    + ` Run \`bun install\`${root ? ` in ${root}` : ""} and restart the runtime; a running process cannot reload a moved dependency.`;
}
