import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findScoutExtension, normalizeScoutExtensionDestination, scoutExtensionRoots, type ScoutExtension, type ScoutExtensionInvocation, type ScoutExtensionRefusalReason } from "@openscout/runtime/extensions";
import { resolveScoutHome } from "@openscout/runtime/config";
import { readScoutExtensionInstallReceipt } from "./extension-install.ts";
import { isScoutExtensionTreeDigest } from "./extension-tree-digest.ts";
import { ScoutCommandUnavailableError } from "./command-unavailable.ts";

export const EXTENSION_GRANT_SCHEMA = "scout.extension-grants/v1";
const LIMIT = 512 * 1024;
const DECLARATION = /^sha256:scout-extension-declaration-v1:[a-f0-9]{64}$/;
const GRANT_ID = /^sha256:scout-extension-grant-v1:[a-f0-9]{64}$/;
export type ExtensionInputBinding = {
  uid: number; home: string; instance: string; instanceRoot: string | null;
  extensionRoot: { path: string; device: string; inode: string };
  verb: string; treeDigest: string; declarationDigest: string; input: "distribution-key";
  source: { kind: "environment"; name: "SCOUT_DIST_KEY" };
  destination: { origin: string; basePath: string };
  provenance: { kind: "unknown-local"; mode: "exact-tree" };
};
export type ExtensionGrant = { id: string; binding: ExtensionInputBinding; createdAt: string };
export type ExtensionGrantPolicy = { schema: typeof EXTENSION_GRANT_SCHEMA; revision: number; grants: ExtensionGrant[];
  audit: Array<{ event: "grant" | "revoke"; grantId: string; treeDigest: string | null; revision: number; at: string }> };
export function inputRefusal(command: string, reason: ScoutExtensionRefusalReason): never {
  throw new ScoutCommandUnavailableError(command, reason, "Inspect extension permissions for the selected tree and destination; no credential value belongs in command arguments.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function scoutExtensionDeclarationDigest(invocation: ScoutExtensionInvocation): string {
  return `sha256:scout-extension-declaration-v1:${createHash("sha256").update("scout-extension-declaration-v1\0").update(canonical(invocation)).digest("hex")}`;
}
export const scoutExtensionGrantId = (binding: ExtensionInputBinding) => `sha256:scout-extension-grant-v1:${createHash("sha256").update("scout-extension-grant-v1\0").update(canonical(binding)).digest("hex")}`;
export type ExtensionInputSelection = { uid: number; home: string; instance: string; instanceRoot: string | null; scoutHome: string; endpoint: string | undefined };
export function scoutExtensionInputBinding(extension: ScoutExtension, env: NodeJS.ProcessEnv, selection: ExtensionInputSelection): ExtensionInputBinding {
  const invocation = extension.invocation;
  if (!invocation?.credentialInputs?.length || !invocation.destinations?.length) inputRefusal(extension.name, "incompatible");
  let receipt: ReturnType<typeof readScoutExtensionInstallReceipt>;
  try { receipt = readScoutExtensionInstallReceipt(extension.name, env); } catch { inputRefusal(extension.name, "selection_changed"); }
  if (!receipt.treeDigest || receipt.status !== "installed") inputRefusal(extension.name, "selection_changed");
  const path = realpathSync(extension.root), info = lstatSync(path, { bigint: true });
  if (selection.uid !== process.getuid?.() || !info.isDirectory()) inputRefusal(extension.name, "selection_changed");
  let destination: ExtensionInputBinding["destination"];
  try { destination = normalizeScoutExtensionDestination(selection.endpoint?.trim() || invocation.destinations[0]!.defaultUrl); }
  catch { inputRefusal(extension.name, "context_invalid"); }
  return { uid: selection.uid, home: selection.home, instance: selection.instance, instanceRoot: selection.instanceRoot,
    extensionRoot: { path, device: String(info.dev), inode: String(info.ino) }, verb: extension.name, treeDigest: receipt.treeDigest,
    declarationDigest: scoutExtensionDeclarationDigest(invocation), input: "distribution-key", source: { kind: "environment", name: "SCOUT_DIST_KEY" },
    destination, provenance: { kind: "unknown-local", mode: "exact-tree" } };
}
export function selectedScoutExtensionInput(name: string, env: NodeJS.ProcessEnv, selection: ExtensionInputSelection) {
  const extension = findScoutExtension(name, env);
  if (!extension || extension.refused || extension.api !== 2) inputRefusal(name, "incompatible");
  return { extension, binding: scoutExtensionInputBinding(extension, env, selection) };
}
const contains = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
export function scoutExtensionGrantStore(env: NodeJS.ProcessEnv): string { return join(resolveScoutHome({ env }), "extension-permissions", "grants-v1.json"); }
function safeDirectory(path: string, strict: boolean) {
  const info = lstatSync(path), uid = process.getuid?.();
  if (!info.isDirectory() || uid === undefined || (strict ? info.uid !== uid : info.uid !== uid && info.uid !== 0)
    || ((info.mode & 0o022) !== 0 && (strict || !(info.mode & 0o1000))) || (strict && (info.mode & 0o077))) throw new Error();
}
function location(env: NodeJS.ProcessEnv, create: boolean): string | undefined {
  const configured = resolve(dirname(dirname(scoutExtensionGrantStore(env))));
  if (!existsSync(configured)) { if (!create) return undefined; mkdirSync(configured, { recursive: true, mode: 0o700 }); }
  const home = realpathSync(configured), root = join(home, "extension-permissions");
  // An explicit extension root must never turn policy into artifact/receipt content.
  for (const candidate of scoutExtensionRoots(env)) {
    const extensionRoot = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
    if (contains(extensionRoot, root)) throw new Error();
  }
  for (let path = home;; path = dirname(path)) { safeDirectory(path, false); if (dirname(path) === path) break; }
  if (!existsSync(root)) { if (!create) return undefined; mkdirSync(root, { mode: 0o700 }); }
  safeDirectory(root, true);
  return join(root, "grants-v1.json");
}
const exactKeys = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
function validBinding(value: unknown): value is ExtensionInputBinding {
  if (!exactKeys(value, ["uid", "home", "instance", "instanceRoot", "extensionRoot", "verb", "treeDigest", "declarationDigest", "input", "source", "destination", "provenance"])) return false;
  const b = value;
  if (!Number.isSafeInteger(b.uid) || (b.uid as number) < 0 || !text(b.home) || !isAbsolute(b.home) || !text(b.instance)
    || !(b.instanceRoot === null || text(b.instanceRoot) && isAbsolute(b.instanceRoot)) || !text(b.verb) || !/^[a-z][a-z0-9-]{0,39}$/.test(b.verb)
    || !isScoutExtensionTreeDigest(b.treeDigest) || !text(b.declarationDigest) || !DECLARATION.test(b.declarationDigest) || b.input !== "distribution-key"
    || !exactKeys(b.extensionRoot, ["path", "device", "inode"]) || !text(b.extensionRoot.path) || !isAbsolute(b.extensionRoot.path)
    || ![b.extensionRoot.device, b.extensionRoot.inode].every(item => typeof item === "string" && /^\d{1,30}$/.test(item))
    || !exactKeys(b.source, ["kind", "name"]) || b.source.kind !== "environment" || b.source.name !== "SCOUT_DIST_KEY"
    || !exactKeys(b.provenance, ["kind", "mode"]) || b.provenance.kind !== "unknown-local" || b.provenance.mode !== "exact-tree"
    || !exactKeys(b.destination, ["origin", "basePath"]) || !text(b.destination.origin) || !text(b.destination.basePath)) return false;
  try { const d = normalizeScoutExtensionDestination(b.destination.origin + b.destination.basePath); return canonical(d) === canonical(b.destination); } catch { return false; }
}
function empty(): ExtensionGrantPolicy { return { schema: EXTENSION_GRANT_SCHEMA, revision: 0, grants: [], audit: [] }; }
function readPolicy(path: string): ExtensionGrantPolicy {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > LIMIT) throw new Error();
    const bytes = Buffer.alloc(LIMIT + 1); let size = 0, n: number;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null))) size += n;
    if (size > LIMIT) throw new Error();
    const data = bytes.subarray(0, size);
    if (!Buffer.from(data.toString("utf8")).equals(data)) throw new Error();
    const policy = JSON.parse(data.toString("utf8"));
    if (!exactKeys(policy, ["schema", "revision", "grants", "audit"]) || policy.schema !== EXTENSION_GRANT_SCHEMA
      || !Number.isSafeInteger(policy.revision) || (policy.revision as number) < 0 || !Array.isArray(policy.grants) || policy.grants.length > 256
      || !Array.isArray(policy.audit) || policy.audit.length + policy.grants.length > 1024) throw new Error();
    const ids = new Set<string>();
    for (const grant of policy.grants) {
      if (!exactKeys(grant, ["id", "binding", "createdAt"]) || !text(grant.id) || !GRANT_ID.test(grant.id) || !validBinding(grant.binding)
        || grant.id !== scoutExtensionGrantId(grant.binding) || ids.has(grant.id) || !text(grant.createdAt) || !Number.isFinite(Date.parse(grant.createdAt))) throw new Error();
      ids.add(grant.id);
    }
    let revision = 0; const active = new Map<string, { treeDigest: unknown; at: unknown }>();
    for (const audit of policy.audit) {
      if (!exactKeys(audit, ["event", "grantId", "treeDigest", "revision", "at"]) || !["grant", "revoke"].includes(audit.event as string)
        || !text(audit.grantId) || !GRANT_ID.test(audit.grantId) || !(audit.treeDigest === null || isScoutExtensionTreeDigest(audit.treeDigest))
        || audit.revision !== ++revision || !text(audit.at) || !Number.isFinite(Date.parse(audit.at))) throw new Error();
      if (audit.event === "grant") active.set(audit.grantId, { treeDigest: audit.treeDigest, at: audit.at }); else active.delete(audit.grantId);
    }
    if (revision !== policy.revision || active.size !== policy.grants.length
      || policy.grants.some(grant => active.get(grant.id)?.treeDigest !== grant.binding.treeDigest || active.get(grant.id)?.at !== grant.createdAt)) throw new Error();
    return policy as ExtensionGrantPolicy;
  } finally { closeSync(fd); }
}
function replacePolicy(path: string, policy: ExtensionGrantPolicy) {
  const bytes = Buffer.from(JSON.stringify(policy) + "\n");
  if (bytes.length > LIMIT || policy.audit.length > 1024 || policy.grants.length > 256) throw new Error();
  const stage = join(dirname(path), `.grants-${randomUUID()}`);
  try {
    const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(stage, path);
    const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { rmSync(stage, { force: true }); }
}
function underPolicyLock<T>(env: NodeJS.ProcessEnv, create: boolean, command: string, action: (policy: ExtensionGrantPolicy, path: string | undefined) => T): T {
  let path: string | undefined;
  try { path = location(env, create); } catch { inputRefusal(command, "input_policy_invalid"); }
  if (!path) return action(empty(), undefined);
  const lock = join(dirname(path), ".lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    inputRefusal(command, (error as NodeJS.ErrnoException).code === "EEXIST" ? "input_policy_busy" : "input_policy_invalid");
  }
  try { return action(readPolicy(path), path); }
  catch (error) { if (error instanceof ScoutCommandUnavailableError) throw error; inputRefusal(command, "input_policy_invalid"); }
  finally { rmdirSync(lock); }
}
export function listScoutExtensionInputGrants(env: NodeJS.ProcessEnv): ExtensionGrantPolicy { return underPolicyLock(env, false, "extensions", policy => policy); }
export function assertScoutExtensionInputGrant(env: NodeJS.ProcessEnv, binding: ExtensionInputBinding, revalidate: () => void = () => {}): void {
  underPolicyLock(env, false, binding.verb, policy => {
    revalidate();
    if (!policy.grants.some(grant => grant.id === scoutExtensionGrantId(binding) && canonical(grant.binding) === canonical(binding))) inputRefusal(binding.verb, "input_not_authorized");
  });
}
export function grantScoutExtensionInput(env: NodeJS.ProcessEnv, binding: ExtensionInputBinding, revalidate: () => ExtensionInputBinding = () => binding): ExtensionGrant {
  if (!validBinding(binding)) inputRefusal("extensions", "input_policy_invalid");
  return underPolicyLock(env, true, binding.verb, (policy, path) => {
    if (canonical(revalidate()) !== canonical(binding)) inputRefusal(binding.verb, "selection_changed");
    const grant = { id: scoutExtensionGrantId(binding), binding, createdAt: new Date().toISOString() };
    const nextGrants = [...policy.grants.filter(item => item.id !== grant.id), grant];
    // Reserve one audit position per active grant so capacity cannot prevent revocation.
    if (policy.audit.length + 1 + nextGrants.length > 1024) inputRefusal(binding.verb, "input_policy_invalid");
    policy.grants = nextGrants;
    policy.audit.push({ event: "grant", grantId: grant.id, treeDigest: binding.treeDigest, revision: ++policy.revision, at: grant.createdAt });
    replacePolicy(path!, policy); return grant;
  });
}
export function revokeScoutExtensionInputGrant(env: NodeJS.ProcessEnv, id: string): { id: string; revoked: boolean } {
  if (!GRANT_ID.test(id)) inputRefusal("extensions", "input_policy_invalid");
  return underPolicyLock(env, true, "extensions", (policy, path) => {
    const grant = policy.grants.find(item => item.id === id);
    if (!grant) return { id, revoked: false };
    policy.grants = policy.grants.filter(item => item.id !== id);
    policy.audit.push({ event: "revoke", grantId: id, treeDigest: grant?.binding.treeDigest ?? null, revision: ++policy.revision, at: new Date().toISOString() });
    replacePolicy(path!, policy); return { id, revoked: !!grant };
  });
}
