// OpenScout instance isolation: one knob, OPENSCOUT_INSTANCE, derives every
// per-install location, port, identity and service name.
//
// `prod` (the default) is exactly today's layout, so installed users see no
// change. Any other name gets its own root, port block, node identity and
// service label, and refuses to touch prod's. Individual env vars still win.
//
// This module must stay dependency-free (node: built-ins only, erasable TS
// syntax only): Node launchers such as packages/web/scripts/dev.mjs import it
// from source with type stripping, before any build exists.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Env = Record<string, string | undefined>;

export const OPENSCOUT_PROD_INSTANCE = "prod";
export const OPENSCOUT_DEV_INSTANCE = "dev";
/** Every non-prod instance lives under `~/.openscout/instances/<name>`. */
export const OPENSCOUT_INSTANCES_DIRECTORY = "instances";

/** Prod's fixed port map. Mirrors OPENSCOUT_PORTS in local-config.ts. */
export const OPENSCOUT_PROD_PORTS = {
  broker: 43110,
  roomListening: 43112,
  mcp: 43115,
  web: 43120,
  webTerminalRelay: 43121,
  vite: 43122,
  pairingBridge: 43130,
  pairingRelay: 43131,
  pairingFileServer: 43132,
  studio: 43140,
  jetstream: 43150,
  jetstreamMonitor: 43151,
} as const;

export type OpenScoutInstancePorts = { -readonly [K in keyof typeof OPENSCOUT_PROD_PORTS]: number };

/**
 * Non-prod port blocks live in 24400–30399: below both the Linux
 * (32768–60999) and macOS (49152–65535) ephemeral ranges, so an outbound
 * socket can never squat an instance's listening port, and clear of prod
 * (431xx) and the per-worktree web/vite/pairing bands (43200–45299). Blocks
 * step by 50, which holds every prod offset (0–41). `dev` owns block 0 so it
 * is easy to remember (broker 24400, web 24410, pairing 24420–24422).
 */
export const OPENSCOUT_INSTANCE_PORT_BLOCK_START = 24400;
export const OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE = 50;
export const OPENSCOUT_INSTANCE_PORT_BLOCK_COUNT = 120;

const INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class OpenScoutInstanceError extends Error {
  readonly violations: string[];
  constructor(message: string, violations: string[] = []) {
    super(message);
    this.name = "OpenScoutInstanceError";
    this.violations = violations;
  }
}

/** Lowercase, `_`/`.`/space → `-`. Throws on names that cannot be a directory/label segment. */
export function normalizeOpenScoutInstanceName(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "default" || trimmed === "production") return OPENSCOUT_PROD_INSTANCE;
  const normalized = trimmed.replace(/[\s_.]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!INSTANCE_NAME_PATTERN.test(normalized)) {
    throw new OpenScoutInstanceError(
      `Invalid OPENSCOUT_INSTANCE ${JSON.stringify(raw)}: use 1-40 characters of a-z, 0-9 and '-', `
        + "starting and ending with a letter or digit (for example `dev` or `dev-feature`).",
    );
  }
  return normalized;
}

export function resolveOpenScoutInstanceName(env: Env = process.env): string {
  return normalizeOpenScoutInstanceName(env.OPENSCOUT_INSTANCE);
}

export function isProdOpenScoutInstance(name: string): boolean {
  return name === OPENSCOUT_PROD_INSTANCE;
}

/** FNV-1a 32-bit — stable across runtimes, no crypto import. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Ports inside common local services' defaults. A block containing one is
 * skipped: Synergy/Barrier 24800, Minecraft 25565, RabbitMQ 25672,
 * CockroachDB 26257, MongoDB 27017-27019, RethinkDB 28015, 30000 (assorted
 * dev servers).
 */
export const OPENSCOUT_INSTANCE_AVOIDED_PORTS: readonly number[] = [
  24800, 25565, 25672, 26257, 27017, 27018, 27019, 28015, 30000,
];

// ── Instance registry ───────────────────────────────────────────────────────
//
// ~/.openscout/instances (OPENSCOUT_INSTANCE_REGISTRY overrides) records which
// non-prod instance owns which port block, with no shared read-modify-write:
//
//   .slots/<portBase>     created with O_EXCL; content = the owning instance.
//                         Whoever creates it owns the block, atomically.
//   .claims/<name>.json   { portBase, root?, checkout?, explicitBase, claimedAt },
//                         written via temp file + rename, after the slot.
//
// A crash between slot and claim leaves an orphan slot: one whose owner has
// no claim for that block. It becomes reclaimable after ORPHAN_SLOT_GRACE_MS,
// through rename-aside + re-check so a slow owner that writes its claim late
// keeps (or is told to retry) its block. A corrupt claim file only affects
// its own instance. A legacy `.ledger.json` is imported once and renamed.

export type OpenScoutInstanceLedgerEntry = {
  portBase: number;
  /** Instance root when relocated with OPENSCOUT_INSTANCE_ROOT. */
  root?: string;
  /** Source checkout that took this name as its default, if any. */
  checkout?: string;
  /** True when the block came from OPENSCOUT_INSTANCE_PORT_BASE. */
  explicitBase?: boolean;
  claimedAt: number;
};

/** A view of the registry: claimed instances, plus every reserved block. */
export type OpenScoutInstanceLedger = {
  version: 1;
  instances: Record<string, OpenScoutInstanceLedgerEntry>;
  /** portBase → owner, from `.slots` (includes orphans). */
  slots?: Record<number, string>;
};

const ORPHAN_SLOT_GRACE_MS = 30_000;

/** Tests shorten the orphan grace; only honoured with an explicit registry dir. */
function orphanGraceMs(env: Env): number {
  if (!env.OPENSCOUT_INSTANCE_REGISTRY?.trim()) return ORPHAN_SLOT_GRACE_MS;
  const raw = Number.parseInt(env.OPENSCOUT_INSTANCE_REGISTRY_ORPHAN_GRACE_MS ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : ORPHAN_SLOT_GRACE_MS;
}

/** Test hook: stall between reserving the slot and writing the claim (explicit registry only). */
function testStallAfterSlot(env: Env): void {
  if (!env.OPENSCOUT_INSTANCE_REGISTRY?.trim()) return;
  const ms = Number.parseInt(env.OPENSCOUT_INSTANCE_REGISTRY_TEST_STALL_MS ?? "", 10);
  if (Number.isInteger(ms) && ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const LEGACY_LEDGER_FILE = ".ledger.json";

/** `~/.openscout/instances` (OPENSCOUT_INSTANCE_REGISTRY overrides). */
export function openScoutInstanceRegistryDir(env: Env = process.env, home: string = homedir()): string {
  return env.OPENSCOUT_INSTANCE_REGISTRY?.trim()
    || join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY);
}

function slotsDir(env: Env, home: string): string {
  return join(openScoutInstanceRegistryDir(env, home), ".slots");
}

function claimsDir(env: Env, home: string): string {
  return join(openScoutInstanceRegistryDir(env, home), ".claims");
}

function slotPath(env: Env, home: string, base: number): string {
  return join(slotsDir(env, home), String(base));
}

function claimPath(env: Env, home: string, name: string): string {
  return join(claimsDir(env, home), `${name}.json`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeFileAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

type ClaimRead =
  | { state: "missing" }
  | { state: "ok"; entry: OpenScoutInstanceLedgerEntry }
  | { state: "corrupt"; path: string };

function parseClaim(raw: string): OpenScoutInstanceLedgerEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<OpenScoutInstanceLedgerEntry>;
    if (typeof parsed?.portBase !== "number" || !Number.isInteger(parsed.portBase)) return null;
    return {
      portBase: parsed.portBase,
      ...(typeof parsed.root === "string" ? { root: parsed.root } : {}),
      ...(typeof parsed.checkout === "string" ? { checkout: parsed.checkout } : {}),
      ...(parsed.explicitBase === true ? { explicitBase: true } : {}),
      claimedAt: typeof parsed.claimedAt === "number" ? parsed.claimedAt : 0,
    };
  } catch {
    return null;
  }
}

function readClaim(env: Env, home: string, name: string): ClaimRead {
  const path = claimPath(env, home, name);
  const raw = readText(path);
  if (raw === null) return { state: "missing" };
  const entry = parseClaim(raw);
  return entry ? { state: "ok", entry } : { state: "corrupt", path };
}

function writeClaim(env: Env, home: string, name: string, entry: OpenScoutInstanceLedgerEntry): void {
  writeFileAtomically(claimPath(env, home, name), `${JSON.stringify(entry, null, 2)}\n`);
}

function readSlotOwner(env: Env, home: string, base: number): string | null {
  const raw = readText(slotPath(env, home, base));
  return raw === null ? null : raw.trim();
}

function listSlots(env: Env, home: string): Record<number, string> {
  const slots: Record<number, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(slotsDir(env, home));
  } catch {
    return slots;
  }
  for (const file of names) {
    if (!/^\d+$/.test(file)) continue;
    const owner = readSlotOwner(env, home, Number(file));
    if (owner !== null) slots[Number(file)] = owner;
  }
  return slots;
}

/** Atomically take `base` for `name`. "taken" means another live owner holds it. */
function tryReserveSlot(env: Env, home: string, base: number, name: string): "reserved" | "own" | "taken" {
  const path = slotPath(env, home, base);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, `${name}\n`, { flag: "wx", mode: 0o600 });
      return "reserved";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = readSlotOwner(env, home, base);
    if (owner === null) continue; // vanished: retry the create
    if (owner === name) return "own";
    if (!reclaimOrphanSlot(env, home, base, owner)) return "taken";
  }
  return "taken";
}

/**
 * An orphan slot (owner has no claim for this block, slot older than the
 * grace period) is reclaimed by renaming it aside, then re-checking the
 * owner's claim: if a late owner wrote it meanwhile, the slot is put back.
 * Returns true when the slot is now free.
 */
function reclaimOrphanSlot(env: Env, home: string, base: number, owner: string): boolean {
  const path = slotPath(env, home, base);
  const ownedHere = () => {
    const claim = readClaim(env, home, owner);
    return claim.state !== "ok" || claim.entry.portBase === base;
  };
  const claim = readClaim(env, home, owner);
  if (claim.state === "ok" && claim.entry.portBase === base) return false;
  if (claim.state === "corrupt") return false; // repair decides, not a racing claimer
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return true;
  }
  if (ageMs < orphanGraceMs(env)) return false;
  const aside = `${path}.reclaim-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // someone else is reclaiming or released it; retry the create
  }
  if (readText(aside)?.trim() !== owner) {
    // We moved a slot someone re-created in between: put it back.
    try {
      linkSync(aside, path);
    } catch {
      // a newer slot exists; leave it
    }
    rmSync(aside, { force: true });
    return false;
  }
  const late = readClaim(env, home, owner);
  if (late.state === "ok" && late.entry.portBase === base && ownedHere()) {
    try {
      linkSync(aside, path);
    } catch {
      // cannot restore over a newer slot
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

/** Remove `name`'s slot for `base` only while it is still `name`'s (rename-aside + verify). */
function releaseSlot(env: Env, home: string, base: number, name: string): void {
  const path = slotPath(env, home, base);
  if (readSlotOwner(env, home, base) !== name) return;
  const aside = `${path}.release-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  if (readText(aside)?.trim() !== name) {
    try {
      linkSync(aside, path);
    } catch {
      // a newer slot exists
    }
  }
  rmSync(aside, { force: true });
}

function legacyLedgerPath(env: Env, home: string): string {
  return join(openScoutInstanceRegistryDir(env, home), LEGACY_LEDGER_FILE);
}

/**
 * Import a legacy `.ledger.json` once into slots + claims, then rename it to
 * `.ledger.json.migrated`. An unreadable one is moved aside as
 * `.ledger.json.corrupt-<hash>` (repair recovers instances from their roots).
 * Idempotent and safe to run concurrently.
 */
export function migrateLegacyOpenScoutInstanceLedger(env: Env = process.env, home: string = homedir()): {
  imported: string[];
  conflicts: string[];
  corrupt: string | null;
} {
  const path = legacyLedgerPath(env, home);
  const raw = readText(path);
  const imported: string[] = [];
  const conflicts: string[] = [];
  if (raw === null) return { imported, conflicts, corrupt: null };
  let instances: Record<string, OpenScoutInstanceLedgerEntry> | null = null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; instances?: Record<string, unknown> };
    if (parsed?.version === 1 && parsed.instances && typeof parsed.instances === "object") {
      instances = {};
      for (const [name, value] of Object.entries(parsed.instances)) {
        const entry = parseClaim(JSON.stringify(value));
        if (entry && safeNormalize(name) === name) instances[name] = entry;
      }
    }
  } catch {
    instances = null;
  }
  if (instances === null) {
    const aside = `${path}.corrupt-${fnv1a(raw).toString(16).padStart(8, "0")}`;
    try {
      renameSync(path, aside);
    } catch {
      // already moved by a concurrent migrator
    }
    return { imported, conflicts, corrupt: aside };
  }
  for (const [name, entry] of Object.entries(instances)) {
    const reserved = tryReserveSlot(env, home, entry.portBase, name);
    if (reserved === "taken") {
      conflicts.push(name);
      continue;
    }
    if (readClaim(env, home, name).state === "missing") writeClaim(env, home, name, entry);
    imported.push(name);
  }
  try {
    renameSync(path, `${path}.migrated`);
  } catch {
    // a concurrent migrator renamed it
  }
  return { imported, conflicts, corrupt: null };
}

/**
 * A read-only view for derivation: this instance's claim (when readable) and
 * every reserved block. Includes an unmigrated legacy ledger's entries. Throws
 * only when `name` needs the registry and its own claim file is unreadable.
 */
function registryView(env: Env, home: string, name: string): OpenScoutInstanceLedger {
  const instances: Record<string, OpenScoutInstanceLedgerEntry> = {};
  const legacy = readText(legacyLedgerPath(env, home));
  if (legacy !== null) {
    try {
      const parsed = JSON.parse(legacy) as { instances?: Record<string, unknown> };
      for (const [other, value] of Object.entries(parsed?.instances ?? {})) {
        const entry = parseClaim(JSON.stringify(value));
        if (entry) instances[other] = entry;
      }
    } catch {
      // migration moves it aside; derivation ignores it
    }
  }
  const own = readClaim(env, home, name);
  if (own.state === "ok") instances[name] = own.entry;
  else if (own.state === "corrupt" && openScoutInstanceNeedsLedger(name, env)) {
    throw corruptClaimError(name, own.path);
  }
  return { version: 1, instances, slots: listSlots(env, home) };
}

function corruptClaimError(name: string, path: string): OpenScoutInstanceError {
  return new OpenScoutInstanceError(
    `The registry claim for OpenScout instance "${name}" (${path}) is unreadable. `
      + "Run `scout instance repair` (it rebuilds the claim from the instance's slot and root), "
      + "or set OPENSCOUT_INSTANCE_PORT_BASE meanwhile.",
  );
}

/** Read the whole registry (claims + slots). Corrupt claim files are listed, not thrown. */
export function readOpenScoutInstanceLedger(env: Env = process.env, home: string = homedir()): OpenScoutInstanceLedger & {
  corruptClaims: string[];
} {
  const instances: Record<string, OpenScoutInstanceLedgerEntry> = {};
  const corruptClaims: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(claimsDir(env, home));
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    if (safeNormalize(name) !== name) continue;
    const claim = readClaim(env, home, name);
    if (claim.state === "ok") instances[name] = claim.entry;
    else if (claim.state === "corrupt") corruptClaims.push(name);
  }
  return { version: 1, instances, slots: listSlots(env, home), corruptClaims };
}

function blockIsAvoided(base: number): boolean {
  return OPENSCOUT_INSTANCE_AVOIDED_PORTS.some(
    (port) => port >= base && port < base + OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE,
  );
}

function slotBase(slot: number): number {
  return OPENSCOUT_INSTANCE_PORT_BLOCK_START + slot * OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE;
}

/**
 * A base a registered block may have: aligned to a block of 24400–30399,
 * clear of the avoided ports, and no prod port inside the block.
 */
function isValidInstanceBlockBase(base: number): boolean {
  if (!Number.isInteger(base)) return false;
  const offset = base - OPENSCOUT_INSTANCE_PORT_BLOCK_START;
  if (offset < 0 || offset % OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE !== 0) return false;
  if (offset / OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE >= OPENSCOUT_INSTANCE_PORT_BLOCK_COUNT) return false;
  if (blockIsAvoided(base)) return false;
  return !Object.values(OPENSCOUT_PROD_PORTS).some(
    (port) => port >= base && port < base + OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE,
  );
}

/** Default root of a non-prod instance (OPENSCOUT_INSTANCE_ROOT may move it). */
function defaultInstanceRoot(home: string, name: string): string {
  return join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY, name);
}

/**
 * `<root>/.released`: written when an instance is released (without
 * --purge) or pruned, so `scout instance repair` does not resurrect the
 * root left behind. A new claim of the name removes it.
 */
export const OPENSCOUT_INSTANCE_RELEASED_MARKER = ".released";

function rootIsReleased(root: string): boolean {
  return existsSync(join(root, OPENSCOUT_INSTANCE_RELEASED_MARKER));
}

/** Candidate blocks for `name` in probe order: its hashed slot first. */
function candidateBases(name: string): number[] {
  const slots = OPENSCOUT_INSTANCE_PORT_BLOCK_COUNT - 1;
  const start = fnv1a(name) % slots;
  const bases: number[] = [];
  for (let offset = 0; offset < slots; offset += 1) {
    const base = slotBase(1 + ((start + offset) % slots));
    if (!blockIsAvoided(base)) bases.push(base);
  }
  return bases;
}

/**
 * A non-prod instance's port block: an explicit OPENSCOUT_INSTANCE_PORT_BASE,
 * else its claim, else (preview) the first block in its probe order that no
 * other instance holds. `dev` always owns block 0. Pure over `ledger`.
 */
export function openScoutInstancePortBase(
  name: string,
  env: Env = process.env,
  ledger: OpenScoutInstanceLedger = { version: 1, instances: {} },
): number {
  if (isProdOpenScoutInstance(name)) return OPENSCOUT_PROD_PORTS.broker;
  const explicit = parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE);
  if (explicit !== undefined) return explicit;
  if (name === OPENSCOUT_DEV_INSTANCE) return slotBase(0);
  const recorded = ledger.instances[name]?.portBase;
  if (typeof recorded === "number" && Number.isInteger(recorded)) return recorded;
  const taken = new Set<number>([slotBase(0)]);
  for (const [other, entry] of Object.entries(ledger.instances)) {
    if (other !== name) taken.add(entry.portBase);
  }
  for (const [base, owner] of Object.entries(ledger.slots ?? {})) {
    if (owner !== name) taken.add(Number(base));
  }
  const free = candidateBases(name).find((base) => !taken.has(base));
  if (free === undefined) throw noFreeBlockError(name);
  return free;
}

function noFreeBlockError(name: string): OpenScoutInstanceError {
  return new OpenScoutInstanceError(
    `No free OpenScout instance port block for "${name}": every block is claimed. `
      + "See `scout instance list` (it prunes dead instances) and free one with "
      + "`scout instance release <name>`, or set OPENSCOUT_INSTANCE_PORT_BASE.",
  );
}

/**
 * Claim (or confirm) this instance: reserve its block's slot first (an
 * explicit OPENSCOUT_INSTANCE_PORT_BASE too, refused when another instance
 * holds it; `dev` reserves block 0), then write its claim file, then verify
 * the slot is still its own (a reclaim may have raced a stalled claimer).
 * Returns the entry, or null when skipped (prod, or a test runner without
 * OPENSCOUT_INSTANCE_REGISTRY).
 */
export function claimOpenScoutInstance(
  name: string,
  env: Env = process.env,
  home: string = homedir(),
  checkout?: string,
): OpenScoutInstanceLedgerEntry | null {
  if (isProdOpenScoutInstance(name)) return null;
  if (isTestRunner(env) && !env.OPENSCOUT_INSTANCE_REGISTRY?.trim()) return null;
  // Never record knobs the rails will refuse (a port base on prod's ports, a
  // root inside prod's directories): the refusal must not outlive the run.
  if (explicitInstanceKnobsHitProd(name, env, home)) return null;
  migrateLegacyOpenScoutInstanceLedger(env, home);

  const explicitBase = parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE);
  const explicitRoot = env.OPENSCOUT_INSTANCE_ROOT?.trim();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existingRead = readClaim(env, home, name);
    const existing = existingRead.state === "ok" ? existingRead.entry : null;
    if (existingRead.state === "corrupt" && openScoutInstanceNeedsLedger(name, env)) {
      throw corruptClaimError(name, existingRead.path);
    }

    let base: number | null = null;
    const wanted = explicitBase ?? (name === OPENSCOUT_DEV_INSTANCE ? slotBase(0) : existing?.portBase);
    if (wanted !== undefined) {
      const reserved = tryReserveSlot(env, home, wanted, name);
      if (reserved === "taken") {
        if (explicitBase !== undefined || name === OPENSCOUT_DEV_INSTANCE) {
          const owner = readSlotOwner(env, home, wanted);
          // The holder released (or lost) it as we looked: try again.
          if (owner === null || owner === name) continue;
          throw new OpenScoutInstanceError(
            `Port block ${wanted} is held by OpenScout instance "${owner}"; `
              + `"${name}" cannot use it. Pick another OPENSCOUT_INSTANCE_PORT_BASE or release that instance.`,
          );
        }
        // A recorded block lost to another owner (should not happen): re-probe.
      } else {
        base = wanted;
      }
    }
    if (base === null) {
      for (const candidate of candidateBases(name)) {
        if (candidate === slotBase(0)) continue;
        const reserved = tryReserveSlot(env, home, candidate, name);
        if (reserved !== "taken") {
          base = candidate;
          break;
        }
      }
      if (base === null) throw noFreeBlockError(name);
    }

    testStallAfterSlot(env);
    const entry: OpenScoutInstanceLedgerEntry = {
      portBase: base,
      ...(explicitRoot ? { root: resolve(expandHome(explicitRoot, home)) } : existing?.root ? { root: existing.root } : {}),
      ...(checkout ?? existing?.checkout ? { checkout: checkout ?? existing?.checkout } : {}),
      ...(explicitBase !== undefined ? { explicitBase: true } : {}),
      claimedAt: existing?.claimedAt ?? Date.now(),
    };
    rmSync(join(entry.root ?? defaultInstanceRoot(home, name), OPENSCOUT_INSTANCE_RELEASED_MARKER), { force: true });
    if (JSON.stringify(existing) !== JSON.stringify(entry)) writeClaim(env, home, name, entry);
    if (readSlotOwner(env, home, base) !== name) {
      // Our slot was reclaimed while we were stalled: never keep a claim on
      // a block someone else now owns. Retry from scratch.
      continue;
    }
    if (existing && existing.portBase !== base) releaseSlot(env, home, existing.portBase, name);
    return entry;
  }
  throw new OpenScoutInstanceError(`Could not claim a port block for OpenScout instance "${name}" (contention).`);
}

/** `dev` and an explicit OPENSCOUT_INSTANCE_PORT_BASE need no registry to derive their ports. */
export function openScoutInstanceNeedsLedger(name: string, env: Env = process.env): boolean {
  if (isProdOpenScoutInstance(name)) return false;
  if (name === OPENSCOUT_DEV_INSTANCE) return false;
  return parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE) === undefined;
}

function explicitInstanceKnobsHitProd(name: string, env: Env, home: string): boolean {
  const base = parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE);
  if (base !== undefined) {
    const prodPorts = new Set<number>(Object.values(OPENSCOUT_PROD_PORTS));
    const offsets = Object.values(OPENSCOUT_PROD_PORTS).map((port) => port - OPENSCOUT_PROD_PORTS.broker);
    if (offsets.some((offset) => prodPorts.has(base + offset))) return true;
  }
  const root = env.OPENSCOUT_INSTANCE_ROOT?.trim();
  if (root) {
    const violations = findOpenScoutInstanceIsolationViolations({
      env: { OPENSCOUT_INSTANCE: name },
      home,
      extraPaths: [{ label: "OPENSCOUT_INSTANCE_ROOT", value: root }],
    });
    if (violations.length > 0) return true;
  }
  return false;
}

/** Ports and pids an instance would hold while running (for liveness checks). */
export function openScoutInstanceLivenessProbes(
  name: string,
  entry: OpenScoutInstanceLedgerEntry,
  home: string = homedir(),
): { root: string; ports: number[]; pids: number[] } {
  const root = entry.root ?? join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY, name);
  const ports = new Set<number>(
    Object.values(deriveOpenScoutInstancePorts(name, { OPENSCOUT_INSTANCE_PORT_BASE: String(entry.portBase) })),
  );
  const config = readText(join(root, "config.json"));
  if (config) {
    try {
      for (const value of Object.values((JSON.parse(config) as { ports?: Record<string, unknown> }).ports ?? {})) {
        if (typeof value === "number" && Number.isInteger(value)) ports.add(value);
      }
    } catch {
      // no usable instance config
    }
  }
  const pids: number[] = [];
  const pid = (text: string | null, pick: (raw: string) => unknown) => {
    if (text === null) return;
    try {
      const value = Number(pick(text));
      if (Number.isInteger(value) && value > 0) pids.push(value);
    } catch {
      // unreadable
    }
  };
  pid(readText(join(root, "pairing", "runtime.pid")), (raw) => raw.trim());
  pid(readText(join(root, "pairing", "runtime.json")), (raw) => (JSON.parse(raw) as { pid?: unknown }).pid);
  pid(readText(join(root, "support", "runtime", "broker-heartbeat.json")), (raw) => (JSON.parse(raw) as { pid?: unknown }).pid);
  return { root, ports: [...ports].sort((a, b) => a - b), pids };
}

export function openScoutPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tcpPortAnswers(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** What still runs for an instance: answering ports of its block/config and live recorded pids. */
export async function openScoutInstanceLiveness(
  name: string,
  entry: OpenScoutInstanceLedgerEntry,
  home: string = homedir(),
): Promise<string[]> {
  const probes = openScoutInstanceLivenessProbes(name, entry, home);
  const live: string[] = [];
  for (const port of probes.ports) {
    if (await tcpPortAnswers(port)) live.push(`port ${port}`);
  }
  for (const pid of probes.pids) {
    if (openScoutPidAlive(pid)) live.push(`pid ${pid}`);
  }
  return live;
}

const PRUNE_GRACE_MS = 60 * 60_000;

/**
 * Prune instances whose checkout is gone, or whose root vanished an hour
 * after the claim, and only when nothing of theirs still runs (a checkout
 * moved while its instance runs keeps its block). Paths whose parent is
 * missing too (an unmounted volume) are left alone.
 */
async function pruneRegistry(env: Env, home: string): Promise<string[]> {
  const pruned: string[] = [];
  const gone = (path: string) => !existsSync(path) && existsSync(dirname(path));
  const view = readOpenScoutInstanceLedger(env, home);
  for (const [name, entry] of Object.entries(view.instances)) {
    const root = entry.root ?? defaultInstanceRoot(home, name);
    const checkoutGone = entry.checkout !== undefined && gone(entry.checkout);
    const rootGone = gone(root) && Date.now() - entry.claimedAt > PRUNE_GRACE_MS;
    if (!checkoutGone && !rootGone) continue;
    if ((await openScoutInstanceLiveness(name, entry, home)).length > 0) continue;
    releaseOpenScoutInstance(name, env, home);
    pruned.push(name);
  }
  return pruned;
}

/** `scout instance list`: migrate, prune dead instances, return the registry. */
export async function listOpenScoutInstances(env: Env = process.env, home: string = homedir()): Promise<
  OpenScoutInstanceLedger & { corruptClaims: string[]; pruned: string[] }
> {
  migrateLegacyOpenScoutInstanceLedger(env, home);
  const pruned = await pruneRegistry(env, home);
  return { ...readOpenScoutInstanceLedger(env, home), pruned };
}

/**
 * `scout instance release <name>` (and prune): delete the instance's slot
 * (only while it is still its own), then its claim, and mark the root it
 * leaves behind as released so repair does not resurrect it. Returns the
 * released entry.
 */
export function releaseOpenScoutInstance(
  name: string,
  env: Env = process.env,
  home: string = homedir(),
): OpenScoutInstanceLedgerEntry | null {
  const normalized = normalizeOpenScoutInstanceName(name);
  if (isProdOpenScoutInstance(normalized)) {
    throw new OpenScoutInstanceError("prod is not a registered instance and cannot be released.");
  }
  const claim = readClaim(env, home, normalized);
  const slots = listSlots(env, home);
  const ownSlots = Object.entries(slots).filter(([, owner]) => owner === normalized).map(([base]) => Number(base));
  const root = claim.state === "ok" ? claim.entry.root ?? defaultInstanceRoot(home, normalized)
    : claim.state === "corrupt" ? recoverClaimPaths(readText(claim.path) ?? "").root ?? defaultInstanceRoot(home, normalized)
    : defaultInstanceRoot(home, normalized);
  const markReleased = () => {
    if (!existsSync(root)) return;
    try {
      writeFileSync(join(root, OPENSCOUT_INSTANCE_RELEASED_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch {
      // an unwritable root: repair may list it, it never gets a block back silently
    }
  };
  if (claim.state !== "ok" && ownSlots.length === 0) {
    markReleased();
    if (claim.state === "corrupt") rmSync(claim.path, { force: true });
    return null;
  }
  markReleased();
  for (const base of ownSlots) releaseSlot(env, home, base, normalized);
  rmSync(claimPath(env, home, normalized), { force: true });
  return claim.state === "ok" ? claim.entry : { portBase: ownSlots[0]!, claimedAt: 0 };
}

/** Best-effort `root` / `checkout` from an unparseable claim file. */
function recoverClaimPaths(raw: string): { root?: string; checkout?: string } {
  const field = (key: string): string | undefined => {
    const match = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(raw);
    if (!match) return undefined;
    try {
      const value = JSON.parse(match[1]!) as unknown;
      return typeof value === "string" && isAbsolute(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const root = field("root");
  const checkout = field("checkout");
  return { ...(root ? { root } : {}), ...(checkout ? { checkout } : {}) };
}

export type OpenScoutInstanceRepairReport = {
  migrated: ReturnType<typeof migrateLegacyOpenScoutInstanceLedger>;
  /** Claims rebuilt from their slot (corrupt or missing claim files). */
  rebuilt: Array<{ name: string; portBase: number; source: string }>;
  /** Slots re-created for valid claims that lost theirs. */
  reslotted: Array<{ name: string; portBase: number }>;
  /** Problems left for the operator (block held by someone else, unrecoverable roots). */
  unresolved: string[];
  /** True when nothing needed repair (and --force was not given). */
  healthy: boolean;
};

/**
 * `scout instance repair`: reconcile slots and claims without moving any
 * healthy instance's block.
 * - migrates a legacy ledger (an unreadable one is moved aside);
 * - rebuilds a corrupt or missing claim from the instance's slot, else from
 *   its root's evidence (`support/.host-info` ports, `config.json` ports) when
 *   that is a valid instance block (aligned, in 24400–30399, clear of prod
 *   and the avoided ports) and free, else leaves it unresolved; a rebuilt
 *   claim keeps the `root`/`checkout` still readable in the broken file;
 * - skips roots marked released (`<root>/.released`);
 * - re-creates a valid claim's missing slot;
 * - leaves running instances untouched apart from re-slotting.
 * Refuses when nothing is broken, unless `force`.
 */
export function repairOpenScoutInstanceRegistry(
  env: Env = process.env,
  home: string = homedir(),
  options: { force?: boolean } = {},
): OpenScoutInstanceRepairReport {
  const migrated = migrateLegacyOpenScoutInstanceLedger(env, home);
  const view = readOpenScoutInstanceLedger(env, home);
  const rebuilt: OpenScoutInstanceRepairReport["rebuilt"] = [];
  const reslotted: OpenScoutInstanceRepairReport["reslotted"] = [];
  const unresolved: string[] = [];

  const rootsOnDisk = (() => {
    try {
      return readdirSync(join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && safeNormalize(entry.name) === entry.name)
        .map((entry) => entry.name);
    } catch {
      return [] as string[];
    }
  })();
  const slotOwners = new Map<string, number[]>();
  for (const [base, owner] of Object.entries(view.slots ?? {})) {
    slotOwners.set(owner, [...(slotOwners.get(owner) ?? []), Number(base)]);
  }
  const needsClaim = new Set<string>([
    ...view.corruptClaims,
    ...[...slotOwners.keys()].filter((name) => !view.instances[name] && safeNormalize(name) === name),
    ...rootsOnDisk.filter((name) =>
      !view.instances[name]
      && !isProdOpenScoutInstance(name)
      && !rootIsReleased(defaultInstanceRoot(home, name))),
  ]);
  const missingSlots = Object.entries(view.instances).filter(([name, entry]) => view.slots?.[entry.portBase] !== name);
  const broken = needsClaim.size > 0 || missingSlots.length > 0 || migrated.corrupt !== null || migrated.conflicts.length > 0;
  if (!broken && !options.force) {
    return { migrated, rebuilt, reslotted, unresolved, healthy: true };
  }

  for (const [name, entry] of missingSlots) {
    const reserved = tryReserveSlot(env, home, entry.portBase, name);
    if (reserved === "taken") {
      unresolved.push(`${name}: block ${entry.portBase} is held by "${readSlotOwner(env, home, entry.portBase)}"`);
    } else {
      reslotted.push({ name, portBase: entry.portBase });
    }
  }

  for (const name of needsClaim) {
    const corruptPath = claimPath(env, home, name);
    let kept: { root?: string; checkout?: string } = {};
    if (view.corruptClaims.includes(name)) {
      const raw = readText(corruptPath);
      if (raw !== null) {
        writeFileAtomically(`${corruptPath}.corrupt-${fnv1a(raw).toString(16).padStart(8, "0")}`, raw);
        kept = recoverClaimPaths(raw);
      }
    }
    const own = slotOwners.get(name)?.sort((a, b) => a - b)[0];
    let base: number | undefined = own;
    let source = own !== undefined ? "slot" : "";
    if (base === undefined) {
      const root = kept.root ?? defaultInstanceRoot(home, name);
      const evidence = [
        () => (JSON.parse(readText(join(root, "support", ".host-info")) ?? "null") as { ports?: { broker?: unknown } } | null)?.ports?.broker,
        () => (JSON.parse(readText(join(root, "config.json")) ?? "null") as { ports?: { broker?: unknown } } | null)?.ports?.broker,
      ];
      let invalid: string | null = null;
      for (const [index, read] of evidence.entries()) {
        try {
          const value = read();
          if (value === undefined || value === null) continue;
          const label = index === 0 ? "root .host-info" : "root config.json";
          if (typeof value !== "number" || !isValidInstanceBlockBase(value)) {
            invalid = `${label} names ${JSON.stringify(value)}, not a valid instance block`;
            continue;
          }
          base = value;
          source = label;
          break;
        } catch {
          // no evidence there
        }
      }
      if (base === undefined && invalid !== null) {
        unresolved.push(`${name}: ${invalid}; it gets a new block on its next start`);
        rmSync(corruptPath, { force: true });
        continue;
      }
      if (base !== undefined && tryReserveSlot(env, home, base, name) === "taken") {
        unresolved.push(`${name}: its last block ${base} is held by "${readSlotOwner(env, home, base)}"`);
        continue;
      }
    }
    if (base === undefined) {
      if (name === OPENSCOUT_DEV_INSTANCE) {
        base = slotBase(0);
        source = "dev block";
        tryReserveSlot(env, home, base, name);
      } else {
        unresolved.push(`${name}: no slot or root evidence of its block; it gets a new block on its next start`);
        rmSync(corruptPath, { force: true });
        continue;
      }
    }
    writeClaim(env, home, name, { portBase: base, ...kept, claimedAt: Date.now() });
    rebuilt.push({ name, portBase: base, source });
  }
  return { migrated, rebuilt, reslotted, unresolved, healthy: false };
}

function isTestRunner(env: Env): boolean {
  if (env.NODE_ENV === "test") return true;
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  const entry = bun?.main ?? process.argv[1] ?? "";
  return /[._](test|spec)\.[cm]?[jt]sx?$/.test(entry);
}

export function deriveOpenScoutInstancePorts(
  name: string,
  env: Env = process.env,
  ledger?: OpenScoutInstanceLedger,
): OpenScoutInstancePorts {
  const base = openScoutInstancePortBase(name, env, ledger);
  const ports = {} as OpenScoutInstancePorts;
  for (const [key, prodPort] of Object.entries(OPENSCOUT_PROD_PORTS) as Array<[keyof OpenScoutInstancePorts, number]>) {
    ports[key] = base + (prodPort - OPENSCOUT_PROD_PORTS.broker);
  }
  return ports;
}

export function normalizeOpenScoutHostLabel(value: string | undefined): string {
  const firstLabel = (value ?? "")
    .trim()
    .replace(/\.local\.?$/i, "")
    .split(".")
    .find((part) => part.trim().length > 0) ?? "";
  const normalized = firstLabel
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "localhost";
}

export type OpenScoutInstanceLayout = {
  name: string;
  isProd: boolean;
  /** Root holding everything this instance owns; null for prod (scattered legacy layout). */
  root: string | null;
  /** OPENSCOUT_HOME: config.json, user.json, run/ sockets, zellij sockets, chat. */
  openscoutHome: string;
  /** OPENSCOUT_CONTROL_HOME: control-plane.sqlite, broker journal, knowledge. */
  controlHome: string;
  /** OPENSCOUT_SUPPORT_DIRECTORY: settings, node identity, runtime/, logs/. */
  supportDirectory: string;
  runtimeDirectory: string;
  /** OPENSCOUT_RELAY_HUB. */
  relayHub: string;
  /** OPENSCOUT_SCOUT_HOME: the `~/.scout` class of state (local edge, CLI logs). */
  scoutHome: string;
  /** OPENSCOUT_PAIRING_HOME: pairing bridge keys, trusted peers, runtime.json. */
  pairingHome: string;
  localEdgeDirectory: string;
  brokerSocketPath: string;
  appSocketPath: string;
  probesSocketPath: string;
  ports: OpenScoutInstancePorts;
  hostLabel: string;
  /** OPENSCOUT_NODE_NAME / OPENSCOUT_NODE_QUALIFIER (`<host>-<instance>` off prod). */
  nodeName: string;
  nodeQualifier: string;
  /** OPENSCOUT_NODE_ID (`<qualifier>-<meshId>`), null for prod (persisted identity decides). */
  nodeId: string | null;
  /** macOS launchd label / OPENSCOUT_SERVICE_LABEL. */
  serviceLabel: string;
  /** Linux systemd --user unit name. */
  systemdUnitName: string;
  /** Mesh participation: prod always; others only with OPENSCOUT_INSTANCE_MESH=1. */
  meshAllowed: boolean;
};

export type OpenScoutInstanceLayoutOptions = {
  env?: Env;
  home?: string;
  platform?: string;
  hostname?: string;
  /** Force a name instead of reading OPENSCOUT_INSTANCE. */
  name?: string;
  /** This process's parent pid (tests); defaults to process.ppid. */
  parentPid?: number;
};

/** Prod's support directory: the pre-instance default. */
export function prodOpenScoutSupportDirectory(home: string, platform: string, env: Env): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "OpenScout");
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(xdgDataHome || join(home, ".local", "share"), "openscout");
}

/**
 * The defaults an instance would use with no per-path env overrides. Reads
 * only OPENSCOUT_INSTANCE, OPENSCOUT_INSTANCE_ROOT, OPENSCOUT_INSTANCE_PORT_BASE,
 * OPENSCOUT_INSTANCE_MESH, OPENSCOUT_INSTANCE_HOST_LABEL, OPENSCOUT_MESH_ID and
 * XDG_DATA_HOME from `env`, plus
 * (read-only, non-prod only) the instance ledger for the port block and a
 * relocated root. Writes nothing. Throws only when a non-prod instance needs
 * the ledger and it is unreadable.
 */
export function deriveOpenScoutInstanceLayout(options: OpenScoutInstanceLayoutOptions = {}): OpenScoutInstanceLayout {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const name = options.name !== undefined
    ? normalizeOpenScoutInstanceName(options.name)
    : resolveOpenScoutInstanceName(env);
  const isProd = isProdOpenScoutInstance(name);
  const osHostLabel = normalizeOpenScoutHostLabel(options.hostname ?? osHostname());
  // A non-prod instance may stand in for another host name (films, demos, tests):
  // it renames the node, its agents and its service, and nothing else.
  const hostLabelOverride = isProd ? "" : env.OPENSCOUT_INSTANCE_HOST_LABEL?.trim() ?? "";
  const hostLabel = hostLabelOverride ? normalizeOpenScoutHostLabel(hostLabelOverride) : osHostLabel;
  const ledger = isProd ? undefined : registryView(env, home, name);
  const ports = deriveOpenScoutInstancePorts(name, env, ledger);
  const meshId = env.OPENSCOUT_MESH_ID?.trim() || "openscout";

  if (isProd) {
    const openscoutHome = join(home, ".openscout");
    const supportDirectory = prodOpenScoutSupportDirectory(home, platform, env);
    const scoutHome = join(home, ".scout");
    const runtimeDirectory = join(supportDirectory, "runtime");
    return {
      name,
      isProd,
      root: null,
      openscoutHome,
      controlHome: join(openscoutHome, "control-plane"),
      supportDirectory,
      runtimeDirectory,
      relayHub: join(openscoutHome, "relay"),
      scoutHome,
      pairingHome: join(scoutHome, "pairing"),
      localEdgeDirectory: join(scoutHome, "local-edge"),
      brokerSocketPath: join(runtimeDirectory, "broker.sock"),
      appSocketPath: join(openscoutHome, "run", "scout-app.sock"),
      probesSocketPath: join(openscoutHome, "run", "scoutd-probes.sock"),
      ports,
      hostLabel,
      nodeName: options.hostname ?? osHostname(),
      nodeQualifier: hostLabel,
      nodeId: null,
      serviceLabel: "app.openscout",
      systemdUnitName: "scout.service",
      meshAllowed: true,
    };
  }

  const explicitRoot = env.OPENSCOUT_INSTANCE_ROOT?.trim();
  const root = explicitRoot
    ? resolve(expandHome(explicitRoot, home))
    : ledger?.instances[name]?.root ?? join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY, name);
  const supportDirectory = join(root, "support");
  const runtimeDirectory = join(supportDirectory, "runtime");
  const nodeQualifier = `${hostLabel}-${name}`;
  return {
    name,
    isProd,
    root,
    openscoutHome: root,
    controlHome: join(root, "control-plane"),
    supportDirectory,
    runtimeDirectory,
    relayHub: join(root, "relay"),
    scoutHome: root,
    pairingHome: join(root, "pairing"),
    localEdgeDirectory: join(root, "local-edge"),
    brokerSocketPath: join(runtimeDirectory, "broker.sock"),
    appSocketPath: join(root, "run", "scout-app.sock"),
    probesSocketPath: join(root, "run", "scoutd-probes.sock"),
    ports,
    hostLabel,
    nodeName: nodeQualifier,
    nodeQualifier,
    nodeId: `${nodeQualifier}-${normalizeOpenScoutHostLabel(meshId)}`,
    serviceLabel: `app.openscout.${name}`,
    systemdUnitName: `scout-${name}.service`,
    meshAllowed: readBoolean(env.OPENSCOUT_INSTANCE_MESH) === true,
  };
}

/** Env var → layout value, in the order applyOpenScoutInstanceEnvironment fills them. */
function instanceEnvDefaults(layout: OpenScoutInstanceLayout): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["OPENSCOUT_HOME", layout.openscoutHome],
    ["OPENSCOUT_CONTROL_HOME", layout.controlHome],
    ["OPENSCOUT_SUPPORT_DIRECTORY", layout.supportDirectory],
    ["OPENSCOUT_RELAY_HUB", layout.relayHub],
    ["OPENSCOUT_SCOUT_HOME", layout.scoutHome],
    ["OPENSCOUT_PAIRING_HOME", layout.pairingHome],
    ["OPENSCOUT_BROKER_SOCKET_PATH", layout.brokerSocketPath],
    ["OPENSCOUT_APP_SOCKET", layout.appSocketPath],
    ["OPENSCOUT_PROBES_SOCKET", layout.probesSocketPath],
    ["OPENSCOUT_BROKER_PORT", String(layout.ports.broker)],
    ["OPENSCOUT_LISTENING_PORT", String(layout.ports.roomListening)],
    ["OPENSCOUT_WEB_PORT", String(layout.ports.web)],
    ["OPENSCOUT_WEB_TERMINAL_RELAY_PORT", String(layout.ports.webTerminalRelay)],
    ["OPENSCOUT_PAIRING_PORT", String(layout.ports.pairingBridge)],
    ["OPENSCOUT_JETSTREAM_PORT", String(layout.ports.jetstream)],
    ["OPENSCOUT_JETSTREAM_MONITOR_PORT", String(layout.ports.jetstreamMonitor)],
    ["OPENSCOUT_NODE_NAME", layout.nodeName],
    ["OPENSCOUT_NODE_QUALIFIER", layout.nodeQualifier],
    ["OPENSCOUT_SERVICE_LABEL", layout.serviceLabel],
    ["OPENSCOUT_BROKER_SERVICE_LABEL", layout.serviceLabel],
  ];
  if (layout.nodeId) entries.push(["OPENSCOUT_NODE_ID", layout.nodeId]);
  return entries;
}

/** Mesh env forced (not defaulted) on a non-prod instance without OPENSCOUT_INSTANCE_MESH=1. */
const MESH_OFF_ENV: Array<[string, string]> = [
  ["OPENSCOUT_ADVERTISE_SCOPE", "local"],
  ["OPENSCOUT_NETWORK_DISCOVERY_ENABLED", "0"],
  ["OPENSCOUT_MESH_RENDEZVOUS_URL", "false"],
  ["OPENSCOUT_MESH_SEEDS", ""],
  ["OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS", "0"],
];
const MESH_SECRET_ENV_KEYS = [
  "OPENSCOUT_MESH_SHARED_TOKEN",
  "OPENSCOUT_MESH_RENDEZVOUS_TOKEN",
  "OPENSCOUT_MESH_RENDEZVOUS_SESSION",
  "OPENSCOUT_MESH_RENDEZVOUS_ALLOW_ANONYMOUS",
  "OPENSCOUT_PAIRING_RELAY_URL",
  "OPENSCOUT_MOBILE_PAIRING_RELAY_URL",
];
/**
 * The push relay session is the operator's oscout.net identity for APNs.
 * A non-prod instance never inherits it, even with mesh opted in: a dev
 * broker must not notify the phones paired to prod.
 */
const PUSH_RELAY_ENV_KEYS = [
  "OPENSCOUT_PUSH_RELAY_SESSION",
  "OPENSCOUT_PUSH_RELAY_URL",
  "OPENSCOUT_PUSH_RELAY_MESH_ID",
];

export type ApplyOpenScoutInstanceResult = {
  layout: OpenScoutInstanceLayout;
  /** Keys this call wrote (a non-prod instance overwrites every derived key). */
  applied: string[];
  /** Keys this call overwrote or removed to keep a non-prod instance off the mesh. */
  meshFenced: string[];
};

const BROKER_URL_ENV_KEYS = ["OPENSCOUT_BROKER_URL", "OPENSCOUT_BROKER_INTERNAL_URL"] as const;

/** Ports the instance's own config.json (`<OPENSCOUT_HOME>/config.json`) sets. */
function instanceConfigPorts(openscoutHome: string): { broker?: number; web?: number; pairing?: number } {
  try {
    const parsed = JSON.parse(readFileSync(join(openscoutHome, "config.json"), "utf8")) as { ports?: Record<string, unknown> };
    const ports = parsed?.ports ?? {};
    const pick = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined);
    return { broker: pick(ports.broker), web: pick(ports.web), pairing: pick(ports.pairing) };
  } catch {
    return {};
  }
}

/**
 * Materialize the instance into `env` (normally process.env) so every reader
 * of an individual OPENSCOUT_* variable, and every child service, sees it.
 *
 * - OPENSCOUT_INSTANCE is always pinned explicitly (prod included), so
 *   service children inherit an explicit choice and never take a checkout
 *   default.
 * - prod keeps honouring today's env overrides: nothing else changes.
 * - a non-prod instance OVERWRITES every derived value (homes, dirs, sockets,
 *   ports, node identity, labels) from its layout, and drops broker URLs that
 *   do not target its own broker. Ambient values from a parent shell never
 *   override it; non-prod customization goes through OPENSCOUT_INSTANCE_*
 *   (root, port base, mesh) or the instance's own config.json ports.
 * - client pointers (OPENSCOUT_CLIENT_INSTANCE) are never read here.
 */
export function applyOpenScoutInstanceEnvironment(
  env: Env = process.env,
  options: Omit<OpenScoutInstanceLayoutOptions, "env"> = {},
): ApplyOpenScoutInstanceResult {
  const name = options.name !== undefined
    ? normalizeOpenScoutInstanceName(options.name)
    : resolveOpenScoutInstanceName(env);
  const home = options.home ?? homedir();
  // Claim before deriving, so exported ports come from the recorded claim.
  if (!isProdOpenScoutInstance(name)) claimOpenScoutInstance(name, env, home);
  const layout = deriveOpenScoutInstanceLayout({ ...options, env, name });
  const applied: string[] = [];
  const meshFenced: string[] = [];
  // Consumed here: the explicit-flag marker must not leak to children.
  delete env.OPENSCOUT_INSTANCE_EXPLICIT;
  env.OPENSCOUT_INSTANCE = layout.name;
  if (layout.isProd) return { layout, applied, meshFenced };

  const configPorts = instanceConfigPorts(layout.openscoutHome);
  const values = new Map(instanceEnvDefaults(layout));
  if (configPorts.broker) values.set("OPENSCOUT_BROKER_PORT", String(configPorts.broker));
  if (configPorts.web) values.set("OPENSCOUT_WEB_PORT", String(configPorts.web));
  if (configPorts.pairing) values.set("OPENSCOUT_PAIRING_PORT", String(configPorts.pairing));
  for (const [key, value] of values) {
    if (env[key] === value) continue;
    env[key] = value;
    applied.push(key);
  }
  // Legacy pairing spellings would shadow OPENSCOUT_PAIRING_HOME.
  for (const key of ["OPENSCOUT_PAIRING_DIR", "SCOUT_PAIRING_HOME", "SCOUT_WEB_PORT", "SCOUT_PAIRING_PORT"] as const) {
    if (env[key] !== undefined) {
      delete env[key];
      applied.push(key);
    }
  }
  const brokerPort = values.get("OPENSCOUT_BROKER_PORT")!;
  for (const key of BROKER_URL_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    let ownBroker = false;
    try {
      const url = new URL(value);
      ownBroker = url.port === brokerPort && isLoopbackHostname(url.hostname);
    } catch {
      ownBroker = false;
    }
    if (!ownBroker) {
      delete env[key];
      applied.push(key);
    }
  }
  // The rest of the overwrite rule: these default under the instance's own
  // homes once unset (chat, zellij sockets, JetStream, pairing runtime.json),
  // and the broker binds loopback.
  for (const key of [
    "OPENSCOUT_BROKER_HOST",
    // Inherited from a prod parent it would run prod's installed runtime code;
    // a non-prod service resolves its own (bundled or checkout) runtime.
    "OPENSCOUT_RUNTIME_PACKAGE_DIR",
    "OPENSCOUT_CHAT_HOME",
    "OPENSCOUT_ZELLIJ_SOCKET_DIR",
    "OPENSCOUT_JETSTREAM_HOME",
    "OPENSCOUT_PAIRING_RUNTIME_STATE_PATH",
  ] as const) {
    if (env[key] === undefined) continue;
    delete env[key];
    applied.push(key);
  }
  if (!layout.meshAllowed) {
    for (const [key, value] of MESH_OFF_ENV) {
      if (env[key] === value) continue;
      env[key] = value;
      meshFenced.push(key);
    }
    for (const key of MESH_SECRET_ENV_KEYS) {
      if (env[key] === undefined) continue;
      delete env[key];
      meshFenced.push(key);
    }
  }
  // Never push to prod's phones from a non-prod instance, mesh opt-in or not.
  for (const key of PUSH_RELAY_ENV_KEYS) {
    if (env[key] === undefined) continue;
    delete env[key];
    meshFenced.push(key);
  }
  return { layout, applied, meshFenced };
}

// ── User-facing spawns (terminals, agents) ──────────────────────────────────

/**
 * Everything instance-derived a service holds in its env. Terminals and agents
 * a service launches must not inherit any of it: a shell starts clean (the
 * checkout default applies inside a checkout, prod elsewhere), and only the
 * client pointer below says which broker its `scout` commands reach.
 * Keep in sync with packages/agent-sessions/src/scout-state-paths.ts.
 */
export const OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS: readonly string[] = [
  "OPENSCOUT_INSTANCE",
  "OPENSCOUT_INSTANCE_EXPLICIT",
  "OPENSCOUT_INSTANCE_ROOT",
  "OPENSCOUT_INSTANCE_PORT_BASE",
  "OPENSCOUT_INSTANCE_MESH",
  "OPENSCOUT_INSTANCE_HOST_LABEL",
  "OPENSCOUT_HOME",
  "OPENSCOUT_CONTROL_HOME",
  "OPENSCOUT_SUPPORT_DIRECTORY",
  "OPENSCOUT_RELAY_HUB",
  "OPENSCOUT_SCOUT_HOME",
  "OPENSCOUT_PAIRING_HOME",
  "OPENSCOUT_PAIRING_DIR",
  "SCOUT_PAIRING_HOME",
  "OPENSCOUT_BROKER_SOCKET_PATH",
  "OPENSCOUT_APP_SOCKET",
  "OPENSCOUT_PROBES_SOCKET",
  "OPENSCOUT_BROKER_PORT",
  "OPENSCOUT_LISTENING_PORT",
  "OPENSCOUT_WEB_PORT",
  "SCOUT_WEB_PORT",
  "OPENSCOUT_WEB_TERMINAL_RELAY_PORT",
  "OPENSCOUT_PAIRING_PORT",
  "SCOUT_PAIRING_PORT",
  "OPENSCOUT_JETSTREAM_PORT",
  "OPENSCOUT_JETSTREAM_MONITOR_PORT",
  "OPENSCOUT_NODE_NAME",
  "OPENSCOUT_NODE_QUALIFIER",
  "OPENSCOUT_NODE_ID",
  "OPENSCOUT_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_MODE",
  "OPENSCOUT_PARENT_PID",
  "OPENSCOUT_BROKER_HOST",
  "OPENSCOUT_BROKER_URL",
  "OPENSCOUT_BROKER_INTERNAL_URL",
  "OPENSCOUT_ADVERTISE_SCOPE",
  "OPENSCOUT_NETWORK_DISCOVERY_ENABLED",
  "OPENSCOUT_MESH_RENDEZVOUS_URL",
  "OPENSCOUT_MESH_SEEDS",
  "OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS",
  "OPENSCOUT_RUNTIME_PACKAGE_DIR",
  "OPENSCOUT_CHAT_HOME",
  "OPENSCOUT_ZELLIJ_SOCKET_DIR",
  "OPENSCOUT_JETSTREAM_HOME",
  "OPENSCOUT_PAIRING_RUNTIME_STATE_PATH",
  "OPENSCOUT_CLIENT_INSTANCE",
];

/** Client-only pointer: which instance's broker a terminal or agent's `scout` reaches. */
export const OPENSCOUT_CLIENT_INSTANCE_ENV_KEY = "OPENSCOUT_CLIENT_INSTANCE";

/** Markers that describe the spawning service's role, never a child's. */
const OPENSCOUT_SPAWN_MARKER_ENV_KEYS = [
  "OPENSCOUT_INSTANCE",
  "OPENSCOUT_INSTANCE_EXPLICIT",
  "OPENSCOUT_PARENT_PID",
  "OPENSCOUT_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_LABEL",
  "OPENSCOUT_BROKER_SERVICE_MODE",
  "OPENSCOUT_CLIENT_INSTANCE",
  // Which code the service runs and how its instance is shaped describe the
  // service, not a child: inherited, a checkout's `bun run dev` would run
  // prod's installed runtime (OPENSCOUT_RUNTIME_PACKAGE_DIR wins in
  // runtimePackageDir()) or reshape its own instance.
  "OPENSCOUT_RUNTIME_PACKAGE_DIR",
  "OPENSCOUT_INSTANCE_ROOT",
  "OPENSCOUT_INSTANCE_PORT_BASE",
  "OPENSCOUT_INSTANCE_MESH",
  "OPENSCOUT_INSTANCE_HOST_LABEL",
] as const;

/** The spawner's instance, or null (with a warning) when its name is invalid. */
function spawnerInstance(base: Env): string | null {
  const raw = base.OPENSCOUT_INSTANCE ?? "";
  const normalized = safeNormalize(raw);
  if (normalized === null) {
    console.warn(`[openscout] invalid OPENSCOUT_INSTANCE ${JSON.stringify(raw)} in a spawning service; children get no instance env and the prod client pointer`);
  }
  return normalized;
}

/**
 * Env for a terminal or agent a service launches. Always drops OPENSCOUT_INSTANCE
 * and the spawner's markers and sets OPENSCOUT_CLIENT_INSTANCE=<its instance>
 * (only CLI/client code reads it; service bootstraps never do).
 * - prod: every other OPENSCOUT_* value is kept. prod's apply() derives
 *   nothing, so they are the operator's genuine overrides (a prod broker on
 *   OPENSCOUT_BROKER_PORT=45555 must keep its agents on 45555).
 * - non-prod: every instance-derived key is dropped too; a child that wants
 *   that broker follows the pointer, and a checkout's `bun run dev` overwrites
 *   whatever it inherited anyway.
 */
export function buildUserSpawnEnvironment(base: Env = process.env): Env {
  const instance = spawnerInstance(base);
  const env: Env = { ...base };
  // Fail safe: an invalid spawner name strips everything, like non-prod.
  const keepOverrides = instance !== null && isProdOpenScoutInstance(instance);
  const keys = keepOverrides ? OPENSCOUT_SPAWN_MARKER_ENV_KEYS : OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS;
  for (const key of keys) delete env[key];
  delete env.OPENSCOUT_ATTRIBUTION_KEY_FILE;
  delete env.OPENSCOUT_OPERATOR_ATTRIBUTION_HANDOFF_FILE;
  env[OPENSCOUT_CLIENT_INSTANCE_ENV_KEY] = instance ?? OPENSCOUT_PROD_INSTANCE;
  return env;
}

/**
 * Env for starting a terminal multiplexer server (tmux, and anything whose
 * env outlives the pane that created it): no instance key at all, not even
 * the client pointer. Every later pane inherits the server's global env, so
 * per-pane values (pointer, prod overrides) go in the pane command instead.
 */
export function buildMultiplexerServerEnvironment(base: Env = process.env): Env {
  const env: Env = { ...base };
  for (const key of OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS) delete env[key];
  delete env.OPENSCOUT_ATTRIBUTION_KEY_FILE;
  delete env.OPENSCOUT_OPERATOR_ATTRIBUTION_HANDOFF_FILE;
  return env;
}

/** The OPENSCOUT_* assignments a pane command must set (pointer + kept prod overrides). */
export function userSpawnPaneAssignments(base: Env = process.env): Array<[string, string]> {
  const spawn = buildUserSpawnEnvironment(base);
  return OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS
    .filter((key) => spawn[key] !== undefined)
    .map((key) => [key, spawn[key]!] as [string, string]);
}

/**
 * The CLI's instance: an explicit OPENSCOUT_INSTANCE (or --instance), else the
 * client pointer a Scout terminal/agent was launched with, else prod. Sets
 * OPENSCOUT_INSTANCE accordingly and returns the name.
 */
export function selectCliOpenScoutInstance(env: Env = process.env): string {
  const explicit = env.OPENSCOUT_INSTANCE?.trim();
  if (explicit) return normalizeOpenScoutInstanceName(explicit);
  const client = env[OPENSCOUT_CLIENT_INSTANCE_ENV_KEY]?.trim();
  const name = client ? normalizeOpenScoutInstanceName(client) : OPENSCOUT_PROD_INSTANCE;
  env.OPENSCOUT_INSTANCE = name;
  return name;
}

/**
 * The Claude statusline is wired once per login (~/.claude/settings.json) and
 * runs inside every Claude session, including ones a dev broker launched. It
 * targets prod unless asked otherwise: an explicit `scout --instance <name>`
 * flag, or OPENSCOUT_STATUSLINE_INSTANCE=<name>. Client pointers and any
 * inherited instance env are dropped. Returns the instance it will use.
 */
export function selectStatuslineOpenScoutInstance(env: Env = process.env): string {
  if (env.OPENSCOUT_INSTANCE_EXPLICIT === "1") {
    delete env.OPENSCOUT_INSTANCE_EXPLICIT;
    return resolveOpenScoutInstanceName(env);
  }
  const requestedRaw = env.OPENSCOUT_STATUSLINE_INSTANCE?.trim();
  const requested = requestedRaw ? normalizeOpenScoutInstanceName(requestedRaw) : OPENSCOUT_PROD_INSTANCE;
  const pointer = safeNormalize(env[OPENSCOUT_CLIENT_INSTANCE_ENV_KEY] ?? "");
  const current = safeNormalize(env.OPENSCOUT_INSTANCE ?? "") ?? pointer ?? OPENSCOUT_PROD_INSTANCE;
  // Same instance: keep its env (prod's overrides are genuine). Another one:
  // drop everything that belonged to it.
  const keys = current === requested ? OPENSCOUT_SPAWN_MARKER_ENV_KEYS : OPENSCOUT_USER_SPAWN_STRIPPED_ENV_KEYS;
  for (const key of keys) delete env[key];
  env.OPENSCOUT_INSTANCE = requested;
  return requested;
}

/** Why mesh participation is refused for this process, or null when allowed. */
export function openScoutInstanceMeshRefusal(env: Env = process.env): string | null {
  const name = resolveOpenScoutInstanceName(env);
  if (isProdOpenScoutInstance(name)) return null;
  if (readBoolean(env.OPENSCOUT_INSTANCE_MESH) === true) return null;
  return `OpenScout instance "${name}" does not join the mesh by default. `
    + "It has its own node identity and never uses prod's mesh keys. "
    + "Set OPENSCOUT_INSTANCE_MESH=1 to opt this instance in.";
}

type IsolationCheck = {
  label: string;
  value: string;
};

const PATH_ENV_KEYS = [
  "OPENSCOUT_HOME",
  "OPENSCOUT_CONTROL_HOME",
  "OPENSCOUT_SUPPORT_DIRECTORY",
  "OPENSCOUT_RELAY_HUB",
  "OPENSCOUT_SCOUT_HOME",
  "OPENSCOUT_PAIRING_HOME",
  "OPENSCOUT_PAIRING_DIR",
  "SCOUT_PAIRING_HOME",
  "OPENSCOUT_BROKER_SOCKET_PATH",
  "OPENSCOUT_APP_SOCKET",
  "OPENSCOUT_PROBES_SOCKET",
  "OPENSCOUT_CHAT_HOME",
  "OPENSCOUT_ZELLIJ_SOCKET_DIR",
  "OPENSCOUT_JETSTREAM_HOME",
  "OPENSCOUT_PAIRING_RUNTIME_STATE_PATH",
] as const;

const PORT_ENV_KEYS = [
  "OPENSCOUT_BROKER_PORT",
  "OPENSCOUT_LISTENING_PORT",
  "OPENSCOUT_WEB_PORT",
  "SCOUT_WEB_PORT",
  "OPENSCOUT_WEB_TERMINAL_RELAY_PORT",
  "OPENSCOUT_PAIRING_PORT",
  "SCOUT_PAIRING_PORT",
  "OPENSCOUT_JETSTREAM_PORT",
  "OPENSCOUT_JETSTREAM_MONITOR_PORT",
] as const;

const URL_ENV_KEYS = [
  "OPENSCOUT_BROKER_URL",
  "OPENSCOUT_BROKER_INTERNAL_URL",
] as const;

/**
 * Every way a non-prod instance's effective configuration would land on prod:
 * a directory equal to or inside one of prod's, a prod port, a broker URL on
 * a prod port, prod's service label/unit, or prod's node identity. Empty for
 * prod and for a clean instance.
 */
export function findOpenScoutInstanceIsolationViolations(
  options: OpenScoutInstanceLayoutOptions & { extraPaths?: IsolationCheck[]; extraPorts?: Array<{ label: string; port: number }> } = {},
): string[] {
  const env = options.env ?? process.env;
  const layout = deriveOpenScoutInstanceLayout(options);
  if (layout.isProd) return [];
  const prod = deriveOpenScoutInstanceLayout({ ...options, name: OPENSCOUT_PROD_INSTANCE });
  const violations: string[] = [];

  const prodRoots = [
    prod.openscoutHome,
    prod.scoutHome,
    prod.supportDirectory,
    prod.controlHome,
    prod.pairingHome,
    prod.relayHub,
  ].map(canonicalPath);
  // Instance roots live under ~/.openscout/instances; that subtree is the only
  // part of prod's homes an instance may write.
  const carveOuts = [join(prod.openscoutHome, OPENSCOUT_INSTANCES_DIRECTORY)].map(canonicalPath);

  const paths: IsolationCheck[] = [
    ...PATH_ENV_KEYS
      .map((key) => ({ label: key, value: env[key]?.trim() ?? "" }))
      .filter((entry) => entry.value.length > 0),
    ...(options.extraPaths ?? []),
  ];
  for (const { label, value } of paths) {
    const candidate = canonicalPath(resolve(expandHome(value, options.home ?? homedir())));
    const insideCarveOut = carveOuts.some((root) => isPathInside(candidate, root));
    if (insideCarveOut) continue;
    const hit = prodRoots.find((root) => isPathInside(candidate, root));
    if (hit) {
      violations.push(`${label}=${value} is prod's directory (${hit})`);
    }
  }

  const prodPorts = new Set<number>(Object.values(OPENSCOUT_PROD_PORTS));
  const ports: Array<{ label: string; port: number }> = [
    ...PORT_ENV_KEYS.flatMap((key) => {
      const port = parsePort(env[key]);
      return port === undefined ? [] : [{ label: key, port }];
    }),
    ...(options.extraPorts ?? []),
  ];
  const pairing = parsePort(env.OPENSCOUT_PAIRING_PORT);
  if (pairing !== undefined) {
    ports.push({ label: "pairing relay (OPENSCOUT_PAIRING_PORT+1)", port: pairing + 1 });
    ports.push({ label: "pairing file server (OPENSCOUT_PAIRING_PORT+2)", port: pairing + 2 });
  }
  for (const { label, port } of ports) {
    if (prodPorts.has(port)) violations.push(`${label}=${port} is one of prod's ports`);
  }

  for (const key of URL_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      const port = Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
      if (isLoopbackHostname(url.hostname) && prodPorts.has(port)) {
        violations.push(`${key}=${value} targets prod's broker`);
      }
    } catch {
      // Unparseable URLs fail later with their own error.
    }
  }

  for (const key of ["OPENSCOUT_SERVICE_LABEL", "OPENSCOUT_BROKER_SERVICE_LABEL"] as const) {
    const value = env[key]?.trim();
    if (value && (value === prod.serviceLabel || value === prod.systemdUnitName.replace(/\.service$/, ""))) {
      violations.push(`${key}=${value} is prod's service`);
    }
  }
  const unit = env.OPENSCOUT_SYSTEMD_UNIT?.trim();
  if (unit && (unit === prod.systemdUnitName || `${unit}.service` === prod.systemdUnitName)) {
    violations.push(`OPENSCOUT_SYSTEMD_UNIT=${unit} is prod's service`);
  }

  const prodQualifier = prod.nodeQualifier;
  for (const key of ["OPENSCOUT_NODE_QUALIFIER", "OPENSCOUT_NODE_NAME"] as const) {
    const value = env[key]?.trim();
    if (value && normalizeOpenScoutHostLabel(value) === prodQualifier) {
      violations.push(`${key}=${value} is prod's node identity`);
    }
  }
  const nodeId = env.OPENSCOUT_NODE_ID?.trim();
  const meshId = normalizeOpenScoutHostLabel(env.OPENSCOUT_MESH_ID?.trim() || "openscout");
  if (nodeId && nodeId === `${prodQualifier}-${meshId}`) {
    violations.push(`OPENSCOUT_NODE_ID=${nodeId} is prod's node identity`);
  }

  return violations;
}

/**
 * Throw a clear error when a non-prod instance would bind prod's ports, write
 * prod's directories, repoint prod's service or reuse prod's identity.
 * `surface` names the caller (broker, web, pairing, service install).
 */
export function assertOpenScoutInstanceIsolation(
  surface: string,
  options: Parameters<typeof findOpenScoutInstanceIsolationViolations>[0] = {},
): void {
  const violations = findOpenScoutInstanceIsolationViolations(options);
  if (violations.length === 0) return;
  const name = resolveOpenScoutInstanceName(options.env ?? process.env);
  throw new OpenScoutInstanceError(
    [
      `Refusing to start ${surface} for OpenScout instance "${name}": it would touch the prod instance.`,
      ...violations.map((violation) => `  - ${violation}`),
      `A non-prod instance keeps its own directories (under ~/.openscout/instances/${name}), its own port block`,
      "and its own service. Unset the overrides above, or run without OPENSCOUT_INSTANCE to act on prod.",
    ].join("\n"),
    violations,
  );
}

/**
 * Entrypoint form of assertOpenScoutInstanceIsolation: print the refusal
 * (no stack trace) and exit non-zero before the process touches anything.
 */
export function enforceOpenScoutInstanceIsolation(
  surface: string,
  options: Parameters<typeof findOpenScoutInstanceIsolationViolations>[0] = {},
): void {
  try {
    assertOpenScoutInstanceIsolation(surface, options);
  } catch (error) {
    if (!(error instanceof OpenScoutInstanceError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

/** One-line description for logs, doctor and status. */
export function describeOpenScoutInstance(
  layout: OpenScoutInstanceLayout = deriveOpenScoutInstanceLayout(),
  env: Env = process.env,
): string {
  if (layout.isProd) return "prod (default layout)";
  const brokerPort = parsePort(env.OPENSCOUT_BROKER_PORT) ?? layout.ports.broker;
  return `${layout.name} (root ${layout.root}, broker port ${brokerPort}, mesh ${layout.meshAllowed ? "opted in" : "off"})`;
}

// ── Source-checkout defaults ────────────────────────────────────────────────

export type OpenScoutCheckout = {
  /** Worktree root (the directory holding `.git`). */
  root: string;
  /** True for a linked `git worktree`, false for the main checkout. */
  isLinkedWorktree: boolean;
};

/** Walk up from `start` to the nearest Scout checkout. An optional inclusive
 * ancestor bounds discovery without changing the default filesystem-root walk. */
export function findOpenScoutCheckout(start: string, searchRoot?: string): OpenScoutCheckout | null {
  let current = resolve(start);
  const boundary = searchRoot === undefined ? undefined : resolve(searchRoot);
  if (boundary !== undefined) {
    const path = relative(boundary, current);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error("Checkout search root must contain the starting directory");
    }
  }
  for (;;) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath) && existsSync(join(current, "packages", "runtime", "src", "instance.ts"))) {
      let isLinkedWorktree = false;
      try {
        isLinkedWorktree = statSync(gitPath).isFile();
      } catch {
        isLinkedWorktree = false;
      }
      return { root: current, isLinkedWorktree };
    }
    if (current === boundary) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `dev` for the main checkout, `dev-<folder>` for a linked worktree. */
export function checkoutOpenScoutInstanceName(checkout: OpenScoutCheckout): string {
  if (!checkout.isLinkedWorktree) return OPENSCOUT_DEV_INSTANCE;
  const folder = basename(checkout.root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!folder) return `dev-${checkoutHash(checkout.root)}`;
  // A worktree folder named `dev` must not alias the main checkout's `dev`.
  const name = folder.startsWith("dev-") ? folder : `dev-${folder}`;
  return name.slice(0, 40).replace(/-+$/g, "");
}

/** 4 hex chars of the checkout path: disambiguates clones and truncated names. */
function checkoutHash(root: string): string {
  return fnv1a(canonicalPath(root)).toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * The checkout's instance name, unique per checkout: the preferred name
 * (`dev`, `dev-<folder>`) unless the ledger shows another, still-existing
 * checkout owns it, in which case `<name>-<hash>` (a second clone, or two
 * folders whose names truncate alike).
 */
export function resolveCheckoutOpenScoutInstanceName(
  checkout: OpenScoutCheckout,
  ledger: OpenScoutInstanceLedger,
): string {
  const preferred = checkoutOpenScoutInstanceName(checkout);
  const owner = ledger.instances[preferred]?.checkout;
  const root = canonicalPath(checkout.root);
  if (!owner || canonicalPath(owner) === root || !existsSync(owner)) return preferred;
  return `${preferred.slice(0, 35).replace(/-+$/g, "")}-${checkoutHash(checkout.root)}`;
}

/**
 * Default OPENSCOUT_INSTANCE for a process run straight from a source
 * checkout (`bun packages/runtime/src/broker-daemon.ts`, `bun run dev`, the
 * pairing controllers): `dev`, or `dev-<worktree>`. Applies only when
 * OPENSCOUT_INSTANCE is unset: an explicit value always wins, and every
 * supervisor pins one on what it launches (systemd units, scoutd/launchd,
 * base, broker, web, the macOS app), so services never take this default.
 * Returns the name it set, or null.
 */
export function applyCheckoutOpenScoutInstanceDefault(
  moduleDirectory: string,
  env: Env = process.env,
  home: string = homedir(),
  /** Optional inclusive ancestor for bounded checkout discovery. */
  checkoutSearchRoot?: string,
): string | null {
  if (env.OPENSCOUT_INSTANCE?.trim()) return null;
  const checkout = findOpenScoutCheckout(moduleDirectory, checkoutSearchRoot);
  if (!checkout) return null;
  const name = resolveCheckoutOpenScoutInstanceName(checkout, readOpenScoutInstanceLedger(env, home));
  env.OPENSCOUT_INSTANCE = name;
  claimOpenScoutInstance(name, env, home, canonicalPath(checkout.root));
  return name;
}

// ── Entrypoint selection ────────────────────────────────────────────────────

/** A string every build that carries instance support contains. */
const INSTANCE_SUPPORT_MARKER = "OPENSCOUT_INSTANCE_MESH";

/**
 * True when `path` can honour OPENSCOUT_INSTANCE: TypeScript source (always
 * current), or a bundle built after instance support landed. A stale
 * pre-instance build would silently use prod's ~/.scout/pairing and ports.
 */
export function entrypointSupportsOpenScoutInstances(path: string): boolean {
  if (/\.[cm]?tsx?$/.test(path)) return true;
  try {
    return readFileSync(path, "utf8").includes(INSTANCE_SUPPORT_MARKER);
  } catch {
    return false;
  }
}

/**
 * First existing candidate. A non-prod instance skips builds without
 * instance support (it falls through to source or a fresh build) and gets
 * null when none qualifies, so callers can say why instead of starting a
 * process that would touch prod.
 */
export function selectInstanceAwareEntrypoint(
  candidates: Array<string | null | undefined>,
  env: Env = process.env,
): string | null {
  const existing = candidates.filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!));
  if (isProdOpenScoutInstance(resolveOpenScoutInstanceName(env))) return existing[0] ?? null;
  return existing.find((candidate) => entrypointSupportsOpenScoutInstances(candidate)) ?? null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function safeNormalize(value: string): string | null {
  try {
    return normalizeOpenScoutInstanceName(value);
  } catch {
    return null;
  }
}

function parsePort(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}

function readBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function isLoopbackHostname(host: string): boolean {
  const trimmed = host.replace(/^\[|\]$/g, "");
  return trimmed === "127.0.0.1" || trimmed === "::1" || trimmed === "localhost" || trimmed === "0.0.0.0" || trimmed === "::";
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
export function canonicalPath(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
