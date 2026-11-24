import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { untrustedPathMetadata } from "@openscout/runtime/config";
import { scoutExtensionDirectoryProblem } from "@openscout/runtime/extensions";

export const SCOUT_EXTENSION_TREE_DIGEST_SCHEME = "sha256:scout-extension-tree-v1";
export const SCOUT_EXTENSION_TREE_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, entries: 1024, depth: 16 });
export type ScoutExtensionTreeDigest = `${typeof SCOUT_EXTENSION_TREE_DIGEST_SCHEME}:${string}`;
export function isScoutExtensionTreeDigest(value: unknown): value is ScoutExtensionTreeDigest {
  return typeof value === "string" && /^sha256:scout-extension-tree-v1:[a-f0-9]{64}(?![\s\S])/.test(value);
}
const { bytes: MAX_BYTES, entries: MAX_ENTRIES, depth: MAX_DEPTH } = SCOUT_EXTENSION_TREE_LIMITS;
const changed = () => new Error("extension tree changed during digest; retry only after the artifact is quiescent");
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Canonical identity of a quiescent, normalized artifact. No paths, metadata or receipts outside it are hashed. */
export function scoutExtensionTreeDigest(directory: string): ScoutExtensionTreeDigest {
  const input = resolve(directory);
  const selectedRoot = lstatSync(input, { bigint: true });
  if (!selectedRoot.isDirectory()) throw new Error("extension tree root must be a directory, not a symlink");
  const root = realpathSync(input);
  if (!same(selectedRoot, lstatSync(root, { bigint: true })) || !same(selectedRoot, lstatSync(input, { bigint: true }))) throw changed();
  const problem = scoutExtensionDirectoryProblem(root);
  if (problem) throw new Error(`unsafe extension tree: ${problem}`);
  const hash = createHash("sha256").update("scout-extension-tree-v1\0");
  let entries = 0, bytes = 0;
  const number = (n: number) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(n)); hash.update(buffer); };
  const pathFrame = (path: string) => { const data = Buffer.from(path, "utf8"); number(data.length); hash.update(data); };
  const names = (path: string) => {
    const result = readdirSync(path, { encoding: "buffer" }).map(name => Buffer.from(name)).sort(Buffer.compare);
    if (result.length > MAX_ENTRIES) throw new Error("extension tree exceeds 1024 entries");
    for (const name of result) {
      if (!Buffer.from(name.toString("utf8"), "utf8").equals(name)) throw new Error("extension tree paths must be valid UTF-8");
    }
    return result;
  };
  const stablePath = (path: string, before: BigIntStats) => {
    // Recheck containment and object identity; this detects observed concurrent edits, not a filesystem snapshot.
    const rel = relative(root, realpathSync(path));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !same(before, lstatSync(path, { bigint: true }))) throw changed();
  };
  const visit = (path: string, relativePath: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error("extension tree exceeds depth 16");
    if (++entries > MAX_ENTRIES) throw new Error("extension tree exceeds 1024 entries");
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() && !before.isFile()) throw new Error("extension tree accepts only regular files and directories, not symlinks or special files");
    const unsafe = untrustedPathMetadata(path, { uid: Number(before.uid), mode: Number(before.mode) });
    if (unsafe) throw new Error(`unsafe extension tree: ${unsafe}`);
    if (before.isFile() && before.nlink !== 1n) throw new Error("extension tree refuses hard-linked files; use a detached installed copy");
    stablePath(path, before);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(before, fstatSync(fd, { bigint: true }))) throw changed();
      stablePath(path, before);
      if (before.isDirectory()) {
        const children = names(path);
        hash.update("D"); pathFrame(relativePath);
        for (const nameBytes of children) {
          const name = nameBytes.toString("utf8");
          stablePath(path, before);
          visit(join(path, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
          stablePath(path, before);
        }
        const after = names(path);
        if (after.length !== children.length || after.some((name, i) => !name.equals(children[i]!))) throw changed();
      } else {
        if (before.size > BigInt(MAX_BYTES - bytes)) throw new Error("extension tree exceeds 32 MiB");
        const size = Number(before.size);
        hash.update("F"); pathFrame(relativePath); hash.update(Buffer.from([(before.mode & 0o111n) ? 1 : 0])); number(size);
        const buffer = Buffer.alloc(64 * 1024); let read = 0;
        for (;;) {
          const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - read + 1), null);
          if (!n) break;
          read += n; bytes += n;
          if (read > size || bytes > MAX_BYTES) throw changed();
          hash.update(buffer.subarray(0, n));
        }
        if (read !== size) throw changed();
      }
      if (!same(before, fstatSync(fd, { bigint: true }))) throw changed();
      stablePath(path, before);
    } finally { closeSync(fd); }
  };
  visit(root, "", 0);
  if (realpathSync(input) !== root || !same(selectedRoot, lstatSync(input, { bigint: true }))) throw changed();
  return `${SCOUT_EXTENSION_TREE_DIGEST_SCHEME}:${hash.digest("hex")}`;
}
