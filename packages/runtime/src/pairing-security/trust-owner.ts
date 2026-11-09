/** Canonical pairing trust persistence. No I/O or adapter installation on import.
 * See docs/pairing-trust-owner.md for the on-disk and interruption contract. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, hkdfSync, randomUUID, randomFillSync } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  unlinkSync, writeFileSync, rmdirSync, ftruncateSync, type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveOpenScoutPairingHome } from "../support-paths.js";
import { CAPSULE_PREFIX, CUTOVER, CHUNK_TARGET, SLOT_LIMIT, commitName, doneName, dataName, slotName, stageName,
  pack, unpack, hex, integer, token, same, policyValid, markerValid, partValid, rowValid, outcome,
  logicalHead, legacyCharge, type CapsuleBarrier, type CapsuleHead, type CapsuleDecoded,
  type CapsuleSlot, type CapsuleRow, type CapsulePart, type ManagedPolicy, type RetiredFile } from "./trust-capsule.js";
import { CUT_DIRECTORY, RESERVATION_FILES, RESERVATION_BYTES, reserveName, cutChild, cutName, cutBodies,
  type CutClaim, type CutPlan, type CutFile, type CutRetired, type CutResult } from "./trust-cutover.js";

import {reclaimCapsuleStaging, type CapsuleReclamationReceipt} from "./trust-reclamation.js";
export type {CapsuleReclamationReceipt} from "./trust-reclamation.js";

export type TrustedPeer = { publicKey: string; name?: string; pairedAt: string; lastSeen?: string };
/** `id` is the persisted root id (`r2:<hmac>`), bound to the host identity.
 * It is derived lazily, because it needs the root key; reading `id` without
 * one refuses with root_key_unavailable. */
export type PairingRootIdentity = Readonly<{ path: string; id: string }>;
/** Returns the host-held secret that keys persisted root and object ids. The
 * default reads the private key from `identity.json` in the trust root. */
export type PairingRootKeySource = (rootPath: string) => Uint8Array;
export type PairingTrustOwnerOptions = Readonly<{ rootKey?: PairingRootKeySource }>;
/** In-process view of the root. `fs` (dev:ino) is valid only for this boot:
 * the device number is assigned at mount time. It is never persisted. */
type Root = PairingRootIdentity & Readonly<{ fs: string; ino: number }>;
declare const contextBrand: unique symbol;
export type PairingTrustContext = { readonly [contextBrand]: true };
/** Trusted bootstrap only. No loader, environment selector or remote installer.
 * withGate MUST retain native ownership until body settles (including Promise
 * results), and release on all exits. currentHolder checks actual ownership.
 * A synchronous legacy writer requires a synchronous gate adapter. This seam
 * does not certify native deadlines, full-key session authority or host policy. */
export interface PairingTrustAdapter {
  readonly id: string;
  withGate<T>(root: PairingRootIdentity, body: (holder: object) => T): T;
  currentHolder(root: PairingRootIdentity): object | null;
}
export type TrustMutation =
  | { type: "grant"; peer: TrustedPeer }
  | { type: "revoke"; publicKey: string }
  | { type: "manage" };
export type TrustOutcome = Readonly<{
  mutationId: string; revision: number; type: TrustMutation["type"];
  publicKey: string | null; changed: boolean;
}>;
type SavedOutcome = { request: string; outcome: TrustOutcome };
type Marker = { schema: "scout.pairing-trust-managed/v1"; rootId: string; adapterId: string };
type ProjectionAdoption = { fromProjectionHash: string; toProjectionHash: string };
type Generation = {
  schema: "scout.pairing-trust-owner/v1"; rootId: string; revision: number;
  previousHash: string; peersHash: string; peers: TrustedPeer[];
  managed: Marker | null; mutation: SavedOutcome; adoption?: ProjectionAdoption | null;
  projectionStage?: string;
};
/** A local, single-use pairing opportunity. Never accepted from request data. */
export interface PairingOpportunity {
  readonly id: string;
  readonly expiresAt: number;
  cancel(): void;
  isOpen(): boolean;
  admit(publicKey: string, room: string, isLive: () => boolean): boolean;
}
export type TrustSnapshot = Readonly<{ revision: number; peers: readonly TrustedPeer[] }>;
/** One coherent authority read. Advisory lastSeen is deliberately excluded. */
export type PairingAuthorityView = TrustSnapshot & Readonly<{stamp: string}>;
type State = { revision: number; peers: TrustedPeer[]; hash: string; peersHash: string;
  managed: Marker | null; outcomes: Record<string, SavedOutcome>; bytes: number;
  projectionHash: string; adoption: ProjectionAdoption | null; pendingStage: string | null; projectionStage: string | null;
  capsule?: CapsuleDecoded };
type Invocation = { owner: PairingTrustOwner; root: Root; adapter: PairingTrustAdapter;
  holder: object; active: boolean; used: boolean };
const invocations = new AsyncLocalStorage<Invocation>();
const liveInvocations = new Set<Invocation>();
const contexts = new WeakMap<object, Invocation>();
const adapters = new Map<string, PairingTrustAdapter>();
const owners = new Map<string, PairingTrustOwner>();
// Reentrant local observers see publication_incomplete, never recursively help.
const completing = new Set<string>();
const PEERS = "trusted-peers.json", MARKER = "trusted-peers.managed.json";
const PREFIX = "trusted-peers.owner.";
const LAST_SEEN = "trusted-peers.last-seen.json";
type LastSeenEntry = { publicKey: string; lastSeen: string };
const FILE_LIMIT = 1024 * 1024, TOTAL_LIMIT = 128 * 1024 * 1024, REVISION_LIMIT = 65_536;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const encodePeers = (peers: readonly TrustedPeer[]) => JSON.stringify(peers, null, 2);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function refuse(code: string): never { throw new PairingTrustError(code); }
export class PairingTrustError extends Error {
  constructor(readonly code: string) { super(`pairing_trust_${code}`); }
}
function owned(stat: Stats, directory = false, legacyProjection = false, stagedGeneration = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
    || (!directory && ((stat.nlink !== 1 && !(stagedGeneration && stat.nlink === 2)) || (!legacyProjection && (stat.mode & 0o077) !== 0)))) refuse("unsafe_path");
}
/** Same-boot object identity for TOCTOU checks. Never persist it: st_dev can
 * change across a reboot when the volume mount order changes. */
function id(stat: Stats) { return `${stat.dev}:${stat.ino}`; }
const LEGACY_ID = /^(\d+):(\d+)$/, ROOT_ID = /^r2:[a-f0-9]{64}$/, OBJECT_ID = /^o2:[a-f0-9]{64}$/;
/** Persisted object identity format: the keyed v2 form, or a legacy dev:ino. */
const identityFormat = (value: unknown) => typeof value === "string" && (OBJECT_ID.test(value) || LEGACY_ID.test(value));
/** A legacy dev:ino record matches by inode only. The device part may come
 * from an earlier boot. A replaced object has a new inode and still fails. */
function legacyMatches(value: string, ino: number) { const m = LEGACY_ID.exec(value); return !!m && m[2] === String(ino); }
/** Object ids only. Birth time is stable across reboots and renames on APFS
 * and HFS+. Other platforms can report ctime in its place, so leave it out. */
function birth(stat: Stats) { return process.platform === "darwin" && stat.birthtimeMs > 0 ? String(stat.birthtimeMs) : ""; }
const ROOT_KEY_INFO = "scout.pairing-trust-root-key/v1";
/** The host pairing identity is the only host-held secret in core. It lives
 * in the same directory as the trust store, so each pairing home keys itself. */
function identityRootKey(rootPath: string): Uint8Array {
  const path = join(rootPath, "identity.json");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") refuse("root_key_unavailable"); throw e; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 64 * 1024) refuse("root_key_unsafe");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (!record(value) || typeof value.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(value.privateKey)) refuse("root_key_unavailable");
    return Buffer.from(value.privateKey, "hex");
  } catch (e) { if (e instanceof PairingTrustError) throw e; return refuse("root_key_unavailable"); }
  finally { closeSync(fd); }
}
const mac = (key: Buffer, parts: readonly string[]) => createHmac("sha256", key).update(JSON.stringify(parts)).digest("hex");
const deriveRootKey = (secret: Uint8Array) => {
  if (!(secret instanceof Uint8Array) || secret.length < 32) refuse("root_key_unavailable");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), ROOT_KEY_INFO, 32));
};
const rootIdFor = (key: Buffer) => `r2:${createHmac("sha256", key).update("scout.pairing-trust-root/v2").digest("hex")}`;
/** Persisted root id: bound to the host pairing identity alone. It survives
 * reboots, device renumbering and moves, and reveals nothing in plain text.
 * A new host identity yields a new id, so the old store is refused: paired
 * peers pinned the old key. `secret` is what the root key source returns. */
export function pairingRootId(secret: Uint8Array): string { return rootIdFor(deriveRootKey(secret)); }
/** Ancestor aliases (e.g. the system temporary directory) normalize; a final
 * symlink root is rejected. A spelling must never choose a second owner. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try { const stat = lstatSync(absolute); owned(stat, true); return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalAncestor(dirname(absolute)), basename(absolute));
  }
}
function canonicalAncestor(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalAncestor(dirname(path)), basename(path));
}
function peersOf(value: unknown): TrustedPeer[] {
  if (!Array.isArray(value) || value.length > 4096) refuse("invalid_peers");
  const keys = new Set<string>();
  return value.map(peer => {
    if (!record(peer) || typeof peer.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(peer.publicKey)
      || typeof peer.pairedAt !== "string" || peer.pairedAt.length > 128
      || (peer.name !== undefined && (typeof peer.name !== "string" || peer.name.length > 1024))
      || (peer.lastSeen !== undefined && (typeof peer.lastSeen !== "string" || peer.lastSeen.length > 128))
      || keys.has(peer.publicKey)) refuse("invalid_peers");
    keys.add(peer.publicKey);
    return { publicKey: peer.publicKey, pairedAt: peer.pairedAt,
      ...(peer.name === undefined ? {} : {name: peer.name}), ...(peer.lastSeen === undefined ? {} : {lastSeen: peer.lastSeen}) };
  });
}
function fullKey(key: string) { if (!/^[0-9a-f]{64}$/.test(key)) refuse("full_key_required"); }

export class PairingTrustOwner {
  readonly path: string;
  private fsId: string | null = null;
  private stableId: string | null = null;
  private key: Buffer | null = null;
  private readonly rootKeySource: PairingRootKeySource;
  constructor(path: string, options: PairingTrustOwnerOptions = {}) {
    this.path = canonical(path);
    this.rootKeySource = options.rootKey ?? identityRootKey;
  }
  private rootKey(): Buffer {
    return this.key ??= deriveRootKey(this.rootKeySource(this.path));
  }
  private stableRootId(): string { return this.stableId ??= rootIdFor(this.rootKey()); }
  /** Accept a persisted root id: the current keyed id, or a legacy dev:ino
   * with this root's inode. Legacy ids are checked first and need no key. */
  private rootIs(root: Root, value: unknown): boolean {
    if (typeof value !== "string") return false;
    if (LEGACY_ID.test(value)) return legacyMatches(value, root.ino);
    return ROOT_ID.test(value) && value === root.id;
  }
  /** Persisted identity of a file or directory inside this root: keyed by the
   * host identity, with no device number and no plain-text inode. Claim,
   * slot and retirement records use it to detect a replaced object. */
  private objectId(root: Root, stat: Stats): string {
    return `o2:${mac(this.rootKey(), ["scout.pairing-trust-object-id/v2", root.id, String(stat.ino), birth(stat)])}`;
  }
  private objectIs(root: Root, value: unknown, stat: Stats): boolean {
    if (typeof value !== "string") return false;
    if (LEGACY_ID.test(value)) return legacyMatches(value, stat.ino);
    return OBJECT_ID.test(value) && value === this.objectId(root, stat);
  }
  /** Validate a managed marker and rewrite its root id to the current form,
   * so a legacy-to-v2 transition compares equal and is never a downgrade. */
  private normMarker(root: Root, value: unknown, code: string): Marker {
    if (!markerValid(value, v => this.rootIs(root, v))) refuse(code);
    return {schema: "scout.pairing-trust-managed/v1", rootId: root.id, adapterId: value.adapterId};
  }
  private normPolicy(root: Root, value: ManagedPolicy | null, code: string): ManagedPolicy | null {
    return value === null ? null : {revision: value.revision, marker: this.normMarker(root, value.marker, code)};
  }
  private root(create = false): Root | null {
    if (create) {
      const missing: string[] = []; let directory = this.path;
      while (!existsSync(directory)) { missing.push(directory); directory = dirname(directory); }
      for (const path of missing.reverse()) {
        try { mkdirSync(path, {mode: 0o700}); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        owned(lstatSync(path), true);
        const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
    }
    let stat;
    try { stat = lstatSync(this.path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && this.fsId === null) return null;
      throw e;
    }
    owned(stat, true);
    if (this.fsId !== null && id(stat) !== this.fsId) refuse("root_replaced");
    this.fsId ??= id(stat);
    const owner = this;
    return Object.freeze({path: this.path, fs: this.fsId, ino: stat.ino, get id() { return owner.stableRootId(); }});
  }
  private check(root: Root) { if (this.root()?.fs !== root.fs) refuse("root_replaced"); }
  private readFile(root: Root, name: string, stagedGeneration = name.startsWith(PREFIX)): Buffer | null {
    this.check(root); const path = join(root.path, name);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    try {
      const stat = fstatSync(fd); owned(stat, false, name === PEERS, stagedGeneration);
      if (stat.size > FILE_LIMIT || id(lstatSync(path)) !== id(stat)) refuse("unsafe_path");
      const data = readFileSync(fd);
      if (data.length > FILE_LIMIT || id(lstatSync(path)) !== id(stat)) refuse("unsafe_path");
      this.check(root); return data;
    } finally { closeSync(fd); }
  }
  /** The CAS staging hard link stays live until projection rename. Its presence
   * distinguishes an in-flight owner publication from an unmanaged old writer.
   * Any owner operation can help finish a verified head publication. */
  private pendingStage(root: Root, revision: number): string | null {
    const target = lstatSync(join(root.path, `${PREFIX}${revision}.json`));
    if (target.nlink === 1) return null;
    owned(target, false, false, true);
    const matches = readdirSync(root.path).filter(name => /^\.pairing-owner-[a-f0-9-]{36}\.tmp$/.test(name))
      .map(name => join(root.path, name)).filter(path => {
        let stat;
        try { stat = lstatSync(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        if (id(stat) !== id(target)) return false;
        owned(stat, false, false, true); return true;
      });
    const now = lstatSync(join(root.path, `${PREFIX}${revision}.json`)); owned(now, false, false, true);
    if (id(now) !== id(target)) refuse("unsafe_path");
    if (now.nlink === 1) return null; // Another helper removed the witness.
    if (matches.length !== 1) refuse("unsafe_path");
    this.check(root); return matches[0]!;
  }
  private syncDirectory(root: Root) {
    this.check(root);
    const fd = openSync(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (id(fstatSync(fd)) !== root.fs) refuse("root_replaced"); fsyncSync(fd); this.check(root); }
    finally { closeSync(fd); }
  }
  private stage(root: Root, bytes: string, prefix = ".pairing-owner"): string {
    const name = `${prefix}-${randomUUID()}.tmp`, path = join(root.path, name);
    this.writeNew(root, name, bytes);
    return path;
  }
  private writeNew(root: Root, name: string, bytes: string | Buffer) {
    this.check(root);
    if ((name.includes("/") && !/^\.pairing-v2-slot-[0-7]\/[a-f0-9-]{36}\.json$/.test(name)
      && !/^\.pairing-claim-[a-f0-9-]{36}\/[a-f0-9-]{36}\.json$/.test(name)
      && !(name.startsWith(`${CUT_DIRECTORY}/`) && cutName(name.slice(CUT_DIRECTORY.length + 1))))
      || name === "." || name === "..") refuse("unsafe_path");
    if (Buffer.byteLength(bytes) > FILE_LIMIT) refuse("capacity");
    const path = join(root.path, name);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { owned(fstatSync(fd)); writeFileSync(fd, bytes); fsyncSync(fd); this.check(root); }
    catch (e) { try { unlinkSync(path); } catch {} throw e; }
    finally { closeSync(fd); }
  }
  /** Display-only data. Broken/unsafe advisory files never affect authority.
   * O_NONBLOCK also prevents a raced-in FIFO from blocking an advisory read. */
  private lastSeen(root: Root): Map<string, string> {
    let fd: number | undefined;
    try {
      this.check(root);
      const path = join(root.path, LAST_SEEN);
      owned(lstatSync(path));
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd); owned(stat);
      if (stat.size > FILE_LIMIT || id(lstatSync(path)) !== id(stat)) return new Map();
      const bytes = readFileSync(fd);
      if (bytes.length > FILE_LIMIT || id(lstatSync(path)) !== id(stat)) return new Map();
      this.check(root);
      const value = JSON.parse(bytes.toString());
      if (!record(value) || value.schema !== "scout.pairing-last-seen/v1"
        || !Array.isArray(value.entries) || value.entries.length > 4096) return new Map();
      const entries = new Map<string, string>();
      for (const entry of value.entries) {
        if (!record(entry) || typeof entry.publicKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.publicKey)
          || typeof entry.lastSeen !== "string" || entry.lastSeen.length > 128
          || !Number.isFinite(Date.parse(entry.lastSeen)) || entries.has(entry.publicKey)) return new Map();
        entries.set(entry.publicKey, entry.lastSeen);
      }
      return entries;
    } catch { return new Map(); }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  }
  private laterSeen(peer: TrustedPeer, advisory: string): string {
    // Grant time is the floor; an old binary's newer projection value wins too.
    let latest = advisory;
    for (const value of [peer.pairedAt, peer.lastSeen]) {
      if (value !== undefined && Date.parse(value) > Date.parse(latest)) latest = value;
    }
    return latest;
  }
  private recordLastSeen(root: Root, peers: readonly TrustedPeer[], publicKey: string, lastSeen: string) {
    let staged: string | null = null;
    try {
      if (!Number.isFinite(Date.parse(lastSeen))) return;
      const previous = this.lastSeen(root), entries: LastSeenEntry[] = [];
      for (const peer of peers) {
        const existing = previous.get(peer.publicKey);
        const candidate = peer.publicKey === publicKey && (!existing || Date.parse(lastSeen) > Date.parse(existing)) ? lastSeen : existing;
        if (candidate) entries.push({publicKey: peer.publicKey, lastSeen: this.laterSeen(peer, candidate)});
      }
      // Only current members survive. No advisory value enters state()/mutate().
      const bytes = JSON.stringify({schema: "scout.pairing-last-seen/v1", entries});
      staged = this.stage(root, bytes, ".pairing-last-seen");
      this.check(root); renameSync(staged, join(root.path, LAST_SEEN));
      // No directory durability barrier: advisory updates can be lost.
    } catch { /* Best effort: metadata failure must not fail a handshake. */ }
    finally { if (staged) { try { unlinkSync(staged); } catch {} } }
  }
  private marker(root: Root): Marker | null {
    const bytes = this.readFile(root, MARKER); if (!bytes) return null;
    return this.normMarker(root, JSON.parse(bytes.toString()), "managed_marker_invalid");
  }
  private state(root: Root, allowPending = false, materialize = true): State {
    this.check(root);
    const inventory = readdirSync(root.path);
    if (inventory.some(n => n.startsWith(CAPSULE_PREFIX) || n.startsWith(".pairing-v2"))) return this.capsuleState(root, allowPending, inventory, materialize);
    const marker = this.marker(root);
    const names = readdirSync(root.path).filter(n => n.startsWith(PREFIX));
    if (names.length > REVISION_LIMIT) refuse("capacity");
    const revisions = names.map(n => {
      const match = /^trusted-peers\.owner\.([1-9][0-9]*)\.json$/.exec(n);
      if (!match || !Number.isSafeInteger(Number(match[1]))) refuse("generation_invalid");
      return Number(match[1]);
    }).sort((a,b) => a-b);
    const projection = this.readFile(root, PEERS);
    // Parse the legacy projection only after classifying a pending owner head.
    // A pending head determines its own peers, even after an outside write.
    const projectionHash = hash(projection ?? Buffer.alloc(0));
    let current: State = {revision: 0, peers: [], hash: projectionHash, peersHash: projectionHash,
      managed: null, outcomes: {}, bytes: 0, projectionHash, adoption: null, pendingStage: null, projectionStage: null};
    for (const revision of revisions) {
      if (revision !== current.revision + 1) refuse("generation_gap");
      const bytes = this.readFile(root, `${PREFIX}${revision}.json`); if (!bytes) refuse("generation_missing");
      current.bytes += bytes.length; if (current.bytes > TOTAL_LIMIT) refuse("capacity");
      const envelope = JSON.parse(bytes.toString()), value: Generation = envelope.generation;
      if (!record(value) || envelope.sha256 !== hash(JSON.stringify(value))) refuse("generation_checksum");
      if (value.schema !== "scout.pairing-trust-owner/v1" || !this.rootIs(root, value.rootId) || value.revision !== revision
        || !/^[a-f0-9]{64}$/.test(value.previousHash) || (revision > 1 && value.previousHash !== current.hash)
        || !record(value.mutation)) refuse("generation_invalid");
      const peers = peersOf(value.peers);
      if (value.peersHash !== hash(encodePeers(peers))) refuse("generation_invalid");
      const saved = value.mutation, outcome = saved.outcome;
      if (typeof saved.request !== "string" || !record(outcome)
        || !/^[a-zA-Z0-9._:-]{1,128}$/.test(outcome.mutationId) || outcome.revision !== revision
        // Historical draft refresh outcomes remain readable; no new refresh
        // mutation is accepted or persisted by this owner.
        || !["grant","refresh","revoke","manage"].includes(outcome.type) || typeof outcome.changed !== "boolean"
        || (outcome.type === "manage" ? outcome.publicKey !== null : typeof outcome.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(outcome.publicKey))
        || Object.hasOwn(current.outcomes, outcome.mutationId)) refuse("generation_invalid");
      const outcomes = current.outcomes;
      Object.defineProperty(outcomes, outcome.mutationId, {value: saved, enumerable: true});
      // Compare normalized markers: the same marker under a legacy and a v2 root id is not a downgrade.
      const managed = value.managed == null ? value.managed : this.normMarker(root, value.managed, "generation_invalid");
      if (current.managed && JSON.stringify(managed) !== JSON.stringify(current.managed)) refuse("managed_downgrade");
      if (value.adoption != null && (!record(value.adoption)
        || !/^[a-f0-9]{64}$/.test(value.adoption.fromProjectionHash) || !/^[a-f0-9]{64}$/.test(value.adoption.toProjectionHash))) refuse("generation_invalid");
      if (value.projectionStage !== undefined && !/^\.pairing-owner-[a-f0-9-]{36}\.tmp$/.test(value.projectionStage)) refuse("generation_invalid");
      const pendingStage = this.pendingStage(root, revision);
      if (pendingStage && revision !== revisions.at(-1)) refuse("publication_incomplete");
      current = {...value, managed, peers, outcomes, hash: hash(bytes), bytes: current.bytes,
        projectionHash, adoption: null, pendingStage, projectionStage: value.projectionStage ?? null};
    }
    if (JSON.stringify(current.managed) !== JSON.stringify(marker)) refuse("managed_marker_mismatch");
    if (marker) {
      const adapter = adapters.get(root.fs);
      if (!adapter || adapter.id !== marker.adapterId) refuse("managed_adapter_required");
      const active = invocations.getStore();
      if (!active || active.owner !== this) refuse("managed_context_required");
      this.validateInvocation(active, root);
    }
    if (JSON.stringify(readdirSync(root.path).filter(n => n.startsWith(PREFIX)).sort()) !== JSON.stringify(names.sort())) refuse("revision_conflict");
    this.check(root);
    if (current.pendingStage) {
      if (!allowPending) refuse("publication_incomplete");
      return current;
    }
    const changedProjection = current.revision > 0 && projectionHash !== current.peersHash;
    if (marker && changedProjection) refuse("external_change_or_incomplete");
    if (!marker) {
      // Mixed-version standalone operation: outside writers are not serialized
      // by our CAS. Adopt their validated array without rewriting our ledger.
      current.peers = projection ? peersOf(JSON.parse(projection.toString())) : [];
      if (changedProjection) current.adoption = {fromProjectionHash: current.peersHash, toProjectionHash: projectionHash};
    }
    return current;
  }
  private retainedStage(root: Root, name: string, generationAlias = false): Buffer | null {
    try { return this.readFile(root, name, generationAlias); }
    catch (error) {
      // The shared source can be consumed while its fd is being inspected.
      // Absence is verified below against the ledger/projection, never guessed.
      try { lstatSync(join(root.path, name)); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null; }
      throw error;
    }
  }
  /** Publish from ONE consumable source, shared by the reserving writer and all
   * helpers. Never recreate it: a delayed rename then gets ENOENT instead of
   * overwriting a newer revision. This is not a liveness/age-based lock. */
  private completePublication(root: Root, state: State) {
    if (completing.has(root.fs)) refuse("publication_incomplete");
    completing.add(root.fs);
    try {
      const bytes = encodePeers(state.peers);
      if (hash(bytes) !== state.peersHash) refuse("publication_incomplete");
      const current = this.state(root, true);
      if (current.revision !== state.revision || current.hash !== state.hash || !current.pendingStage) {
        this.syncDirectory(root); return;
      }
      let source = state.projectionStage;
      if (!source) {
        // Older envelopes did not name the projection stage. A real crash
        // retains it; ambiguity or absence with an old projection stays closed.
        const matches = readdirSync(root.path).filter(name => /^\.pairing-owner-[a-f0-9-]{36}\.tmp$/.test(name))
          .filter(name => { const data = this.retainedStage(root, name, true); return data && hash(data) === state.peersHash; });
        if (matches.length > 1) refuse("publication_incomplete");
        source = matches[0] ?? null;
      }
      const staged = source ? this.retainedStage(root, source) : null;
      if (staged) {
        if (hash(staged) !== state.peersHash) refuse("publication_incomplete");
        this.check(root);
        try { renameSync(join(root.path, source!), join(root.path, PEERS)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      // Missing source is either a helper's atomic rename or damaged evidence.
      // Verify the current ledger before removing the witness or claiming ACK.
      const after = this.state(root, true);
      if (after.revision === state.revision && after.pendingStage) {
        if (after.projectionHash !== state.peersHash) refuse("publication_incomplete");
        try { unlinkSync(after.pendingStage); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      this.syncDirectory(root);
    } catch (error) {
      // Structural integrity/marker/context refusals keep their precise codes.
      if (error instanceof PairingTrustError) throw error;
      refuse("publication_incomplete");
    } finally { completing.delete(root.fs); }
  }
  private readyState(root: Root, materialize = true): State {
    this.finishPendingCutover(root);
    const state = this.state(root, true, materialize);
    if (state.capsule) {
      // Recovery consumes the full retry rows/buffers. A view never enters it
      // with a partial build; completion precedes the final exhaustive view.
      if (state.capsule.needsRecovery) this.completeCapsule(root, materialize ? state : this.state(root, true));
      return state.capsule.needsRecovery ? this.state(root, false, materialize) : state;
    }
    if (state.pendingStage) this.completePublication(root, state);
    return state.pendingStage ? this.state(root) : state;
  }
  private cutDirectory(root: Root, claim: CutClaim) {
    this.check(root);
    const stat = lstatSync(join(root.path, CUT_DIRECTORY));
    owned(stat, true);
    if (!this.rootIs(root, claim.rootId) || !this.objectIs(root, claim.identity, stat)) refuse("migration_claim_changed");
  }
  private syncCutDirectory(root: Root, claim: CutClaim) {
    this.cutDirectory(root, claim);
    const fd = openSync(join(root.path, CUT_DIRECTORY), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!this.objectIs(root, claim.identity, fstatSync(fd))) refuse("migration_claim_changed");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.cutDirectory(root, claim);
  }
  private cutSource(root: Root, claim: CutClaim, name: string) {
    if (!cutName(name)) refuse("migration_plan_invalid");
    this.cutDirectory(root, claim);
    const bytes = this.retainedStage(root, cutChild(name), name === "barrier.json");
    this.cutDirectory(root, claim);
    return bytes;
  }
  private cutReceipt(root: Root, barrier: CapsuleBarrier, cutHash: string) {
    const bytes = this.readFile(root, CUTOVER, false);
    if (!bytes) return false;
    const receipt = unpack<Record<string, unknown>>(bytes, "receipt", refuse);
    if (receipt.schema !== "scout.pairing-cutover-done/v2" || !this.rootIs(root, receipt.rootId)
      || receipt.cutHash !== cutHash || receipt.migrationId !== barrier.migration?.migrationId) refuse("migration_receipt_invalid");
    return true;
  }
  /** Only the creator before CAS, or a barrier/receipt-authorized helper after
   * CAS, owns this exact directory inode. No recursive or age-based cleanup. */
  private removeCutFiles(root: Root, claim: CutClaim) {
    let stat;
    try { stat = lstatSync(join(root.path, CUT_DIRECTORY)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    owned(stat, true);
    if (!this.objectIs(root, claim.identity, stat)) refuse("migration_claim_changed");
    const names = readdirSync(join(root.path, CUT_DIRECTORY));
    if (names.length > RESERVATION_FILES || names.some(name => !cutName(name))) refuse("migration_claim_changed");
    // Keep the claim until all payloads are gone, including when helpers race.
    names.sort((a, b) => Number(a === "claim.json") - Number(b === "claim.json") || a.localeCompare(b));
    for (const name of names) {
      this.cutDirectory(root, claim);
      const bytes = this.cutSource(root, claim, name);
      if (bytes) {
        try { unlinkSync(join(root.path, cutChild(name))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    this.syncCutDirectory(root, claim);
    try { rmdirSync(join(root.path, CUT_DIRECTORY)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.syncDirectory(root);
  }
  /** Materialize 320 MiB, not a sparse truncate or free-space observation.
   * Later sources reuse these allocated files; no second bulk allocation. */
  private reserveCutover(root: Root, claim: CutClaim) {
    const buffer = Buffer.alloc(FILE_LIMIT);
    let allocated = 0;
    for (let index = 0; index < RESERVATION_FILES; index++) {
      this.cutDirectory(root, claim);
      randomFillSync(buffer);
      const name = cutChild(reserveName(index));
      this.writeNew(root, name, buffer);
      const stat = lstatSync(join(root.path, name)); owned(stat);
      if (stat.size !== FILE_LIMIT || stat.blocks * 512 < FILE_LIMIT) refuse("migration_reservation_unavailable");
      allocated += stat.size;
    }
    if (allocated !== RESERVATION_BYTES) refuse("migration_reservation_unavailable");
    this.syncCutDirectory(root, claim);
    this.syncDirectory(root);
  }
  private fillCutReservation(root: Root, claim: CutClaim, index: number, name: string, bytes: string) {
    if (index >= RESERVATION_FILES || !cutName(name) || Buffer.byteLength(bytes) > FILE_LIMIT) refuse("capacity");
    this.cutDirectory(root, claim);
    const source = join(root.path, cutChild(reserveName(index))), target = join(root.path, cutChild(name));
    if (existsSync(target)) refuse("migration_claim_changed");
    const fd = openSync(source, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd); owned(stat);
      if (stat.size !== FILE_LIMIT || stat.blocks * 512 < FILE_LIMIT || id(lstatSync(source)) !== id(stat)) refuse("migration_reservation_unavailable");
      writeFileSync(fd, bytes);
      ftruncateSync(fd, Buffer.byteLength(bytes));
      fsyncSync(fd);
      this.cutDirectory(root, claim);
      if (id(lstatSync(source)) !== id(stat)) refuse("migration_claim_changed");
      renameSync(source, target);
    } finally { closeSync(fd); }
  }
  private finishPendingCutover(root: Root) {
    if (!existsSync(join(root.path, CUT_DIRECTORY))) return;
    // Private pre-CAS staging is deliberately invisible to v1 authority.
    const names = readdirSync(root.path).filter(name => /^trusted-peers\.owner\.[1-9][0-9]*\.json$/.test(name));
    if (!names.length) return;
    const name = names.sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2])).at(-1)!;
    const bytes = this.readFile(root, name, true);
    if (!bytes) refuse("revision_conflict");
    if (!record(JSON.parse(bytes.toString()).barrier)) return;
    const barrier = unpack<CapsuleBarrier>(bytes, "barrier", refuse);
    const m = barrier.migration;
    if (barrier.schema !== "scout.pairing-cut/v2" || !this.rootIs(root, barrier.rootId)
      || !integer(barrier.revision, 0, REVISION_LIMIT) || name !== `${PREFIX}${barrier.revision + 1}.json`
      || !m || !token(m.token) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(m.migrationId)
      || !identityFormat(m.identity) || !hex(m.planHash)
      || !hex(barrier.logicalHead) || !hex(barrier.logicalPeersHash) || !hex(barrier.checkpointPeersHash)
      || !hex(barrier.projectionHash) || !hex(barrier.outcomesDigest) || !integer(barrier.chargedBytes, 0, TOTAL_LIMIT)
      || !policyValid(barrier.policy, v => this.rootIs(root, v), barrier.revision)) refuse("migration_barrier_invalid");
    this.completeCutover(root, barrier, bytes);
  }
  private completeCutover(root: Root, barrier: CapsuleBarrier, barrierBytes: Buffer) {
    // The claim is the persisted one, possibly written before a reboot with a legacy id.
    const m = barrier.migration!, claim: CutClaim = {rootId: barrier.rootId, token: m.token, identity: m.identity, migrationId: m.migrationId};
    const cutHash = hash(barrierBytes);
    if ([...liveInvocations].some(active => active.active && active.root.fs === root.fs
      && active !== invocations.getStore())) refuse("migration_holder_active");
    this.capsulePolicy(root, barrier.policy);
    const barrierPolicy = this.normPolicy(root, barrier.policy, "migration_barrier_invalid");
    if (!same(this.marker(root), barrierPolicy?.marker ?? null)) refuse("managed_marker_mismatch");
    try {
      if (!this.cutReceipt(root, barrier, cutHash)) {
        const barrierPath = join(root.path, `${PREFIX}${barrier.revision + 1}.json`);
        const target = lstatSync(barrierPath), witness = lstatSync(join(root.path, cutChild("barrier.json")));
        owned(target, false, false, true); owned(witness, false, false, true);
        if (target.nlink !== 2 || id(target) !== id(witness)) refuse("migration_witness_invalid");
        const planBytes = this.cutSource(root, claim, "plan.json");
        if (!planBytes || hash(planBytes) !== m.planHash) refuse("migration_plan_invalid");
        const plan = unpack<CutPlan>(planBytes, "plan", refuse);
        if (plan.schema !== "scout.pairing-cutover-plan/v2" || !same({rootId: plan.rootId, token: plan.token,
          identity: plan.identity, migrationId: plan.migrationId}, claim)
          || !Array.isArray(plan.parts) || plan.parts.length > 256 || !plan.parts.every(partValid)
          || !Array.isArray(plan.inventories) || plan.inventories.length > 64) refuse("migration_plan_invalid");
        const bodies = cutBodies(plan, m.planHash);
        if (bodies.barrierBytes !== barrierBytes.toString() || hash(encodePeers(peersOf(plan.peers))) !== plan.checkpointPeersHash) refuse("migration_plan_invalid");
        if (plan.adoption !== null && (!record(plan.adoption) || !hex(plan.adoption.fromProjectionHash)
          || !hex(plan.adoption.toProjectionHash))) refuse("migration_plan_invalid");
        const authorityBytes = plan.parts.reduce((sum, part) => sum + part.bytes, 0) + barrierBytes.length
          + bodies.files.reduce((sum, [, bytes]) => sum + Buffer.byteLength(bytes), 0);
        if (authorityBytes > TOTAL_LIMIT || plan.parts.length + plan.inventories.length + 6 > RESERVATION_FILES
          || bodies.files.some(([, bytes]) => Buffer.byteLength(bytes) > FILE_LIMIT)) refuse("capacity");
        const savedClaim = this.cutSource(root, claim, "claim.json");
        if (!savedClaim || !same(unpack<CutClaim>(savedClaim, "claim", refuse), claim)) refuse("migration_claim_changed");
        // Validate ALL retained rows and retirement evidence before publication
        // or deletion. Neither a partial old prefix nor membership is a shortcut.
        const rows: CapsuleRow[] = [], ids = new Set<string>();
        let charge = 0, policy: ManagedPolicy | null = null;
        for (const part of plan.parts) {
          const bytes = this.cutSource(root, claim, part.name) ?? this.readFile(root, part.name, false);
          if (!bytes || bytes.length !== part.bytes || hash(bytes) !== part.sha256) refuse("migration_chunk_invalid");
          const values = JSON.parse(bytes.toString());
          if (!Array.isArray(values) || values.length !== part.count) refuse("migration_chunk_invalid");
          for (const row of values) {
            if (!rowValid(row, rows.length + 1, v => this.rootIs(root, v)) || ids.has(row[0])) refuse("migration_outcome_invalid");
            ids.add(row[0]); rows.push(row); charge += row[6];
            if (row[2] === "manage") {
              if (policy) refuse("managed_downgrade");
              policy = {revision: row[1], marker: this.normMarker(root, row[7], "migration_outcome_invalid")};
            }
          }
        }
        if (rows.length !== plan.revision || hash(JSON.stringify(rows)) !== plan.outcomesDigest
          || charge !== plan.chargedBytes || charge > TOTAL_LIMIT
          || !same(policy, this.normPolicy(root, plan.policy, "migration_outcome_invalid"))) refuse("migration_outcome_invalid");
        this.capsulePolicy(root, policy);
        const retired: CutRetired[] = [];
        let retiredBytes = 0;
        for (const part of plan.inventories) {
          if (!/^retire\.[a-f0-9-]{36}\.json$/.test(part.name) || !hex(part.sha256)
            || !integer(part.bytes, 2, FILE_LIMIT) || !integer(part.count, 1, REVISION_LIMIT)) refuse("migration_inventory_invalid");
          const bytes = this.cutSource(root, claim, part.name);
          if (!bytes || bytes.length !== part.bytes || hash(bytes) !== part.sha256) refuse("migration_inventory_invalid");
          const values = JSON.parse(bytes.toString());
          if (!Array.isArray(values) || values.length !== part.count) refuse("migration_inventory_invalid");
          for (const item of values) {
            if (!record(item) || item.name !== `${PREFIX}${retired.length + 1}.json` || !hex(item.sha256)
              || !integer(item.bytes, 1, FILE_LIMIT) || typeof item.identity !== "string"
              || !identityFormat(item.identity)) refuse("migration_inventory_invalid");
            retired.push(item as CutRetired); retiredBytes += item.bytes;
          }
        }
        if (retired.length !== plan.revision || retiredBytes !== plan.chargedBytes) refuse("migration_inventory_invalid");
        // Establish the barrier before any root publication or retirement.
        this.syncDirectory(root);
        const publish = (name: string, expectedHash: string) => {
          this.capsulePolicy(root, plan.policy);
          if (this.cutReceipt(root, barrier, cutHash)) return;
          const source = this.cutSource(root, claim, name);
          if (source) {
            if (hash(source) !== expectedHash) refuse("migration_candidate_invalid");
            try { renameSync(join(root.path, cutChild(name)), join(root.path, name)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          if (this.cutReceipt(root, barrier, cutHash)) return;
          const target = this.readFile(root, name, false);
          if (!target || hash(target) !== expectedHash) refuse("migration_candidate_invalid");
        };
        for (const part of plan.parts) publish(part.name, part.sha256);
        for (const [name, bytes] of bodies.files.filter(([name]) => name !== CUTOVER)) publish(name, hash(bytes));
        this.syncDirectory(root);
        for (const item of retired) {
          this.capsulePolicy(root, plan.policy);
          if (this.cutReceipt(root, barrier, cutHash)) break;
          const bytes = this.readFile(root, item.name, false);
          if (!bytes) continue;
          const stat = lstatSync(join(root.path, item.name)); owned(stat);
          if (!this.objectIs(root, item.identity, stat) || bytes.length !== item.bytes || hash(bytes) !== item.sha256) refuse("migration_retirement_changed");
          this.check(root);
          try { unlinkSync(join(root.path, item.name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        this.syncDirectory(root);
        // One prewritten, consumable receipt. Never reconstruct it after ENOENT.
        const receipt = bodies.files.find(([name]) => name === CUTOVER)![1];
        publish(CUTOVER, hash(receipt));
        this.syncDirectory(root);
      }
      if (!this.cutReceipt(root, barrier, cutHash)) refuse("migration_incomplete");
      // The durable receipt authorizes deleting transition evidence, not vice versa.
      this.syncDirectory(root);
      this.removeCutFiles(root, claim);
      this.state(root); // Full current capsule verification, including later heads.
    } catch (error) {
      // A helper may have completed AND a later writer collected serial 1.
      // Return only after verifying the receipt and current authority afresh.
      if (!existsSync(join(root.path, CUT_DIRECTORY)) && this.cutReceipt(root, barrier, cutHash)) {
        try { this.syncDirectory(root); this.state(root); return; } catch { /* unavailable, not an old positive */ }
      }
      if (error instanceof PairingTrustError) throw error;
      refuse("migration_incomplete");
    }
  }
  /** Trusted local maintenance only. Drain all store users before calling.
   * No remote route, automatic startup upgrade or environment selector. */
  migrateToCapsule(migrationId: string, context?: PairingTrustContext): CutResult {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(migrationId)) refuse("invalid_mutation");
    // Refuse a visible older holder BEFORE attempting a potentially blocking
    // acquisition. This cannot discover an unobservable foreign process.
    const observed = this.root(), adapter = observed ? adapters.get(observed.fs) : undefined;
    const held = observed && adapter?.currentHolder(observed);
    const captured = context === undefined ? undefined : contexts.get(context as object);
    if (held && (!captured || captured !== invocations.getStore() || !captured.active
      || captured.owner !== this || captured.root.fs !== observed!.fs || captured.holder !== held)) refuse("migration_holder_active");
    return this.operation(context, (root, invocation) => {
      if (!root) refuse("migration_missing_root");
      if ([...liveInvocations].some(active => active.active && active.root.fs === root.fs && active !== invocation)) refuse("migration_holder_active");
      const state = this.readyState(root);
      if (state.capsule) {
        const b = state.capsule.barrier;
        if (b.migration?.migrationId !== migrationId || !this.cutReceipt(root, b, state.capsule.cutHash)) refuse("migration_id_reused");
        this.syncDirectory(root);
        const verified = this.state(root);
        if (verified.capsule?.cutHash !== state.capsule.cutHash) refuse("migration_receipt_invalid");
        if (invocation) this.validateInvocation(invocation, root);
        return {migrationId, revision: b.revision, logicalHead: b.logicalHead};
      }
      if (invocation?.used) refuse("context_already_used");
      let stat;
      try { mkdirSync(join(root.path, CUT_DIRECTORY), {mode: 0o700}); stat = lstatSync(join(root.path, CUT_DIRECTORY)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("migration_busy"); throw error; }
      owned(stat, true);
      const claim: CutClaim = {rootId: root.id, token: randomUUID(), identity: this.objectId(root, stat), migrationId};
      let reserved = false, uncertain = false;
      try {
        this.syncCutDirectory(root, claim); this.syncDirectory(root);
        this.reserveCutover(root, claim);
        const rows: CapsuleRow[] = [], retired: CutRetired[] = [];
        let policy: ManagedPolicy | null = null;
        for (let revision = 1; revision <= state.revision; revision++) {
          const name = `${PREFIX}${revision}.json`, bytes = this.readFile(root, name, false);
          if (!bytes) refuse("revision_conflict");
          const generation = JSON.parse(bytes.toString()).generation as Generation;
          const saved = generation.mutation, o = saved.outcome;
          if (!same(saved, state.outcomes[o.mutationId])) refuse("revision_conflict");
          // New capsule records carry the current root id, never a legacy one.
          const managed = o.type === "manage" ? this.normMarker(root, generation.managed, "migration_outcome_invalid") : null;
          rows.push([o.mutationId, o.revision, o.type, o.publicKey, o.changed, saved.request, bytes.length, managed]);
          if (managed) policy = {revision, marker: managed};
          retired.push({name, sha256: hash(bytes), bytes: bytes.length, identity: this.objectId(root, lstatSync(join(root.path, name)))});
        }
        if (rows.length !== state.revision || !rows.every((row, index) => rowValid(row, index + 1, v => this.rootIs(root, v)))
          || rows.reduce((sum, row) => sum + row[6], 0) !== state.bytes
          || !same(policy?.marker ?? null, state.managed)) refuse("migration_outcome_invalid");
        const payloads: [string, string][] = [];
        const group = <T>(values: T[], name: () => string): CutFile[] => {
          const parts: CutFile[] = []; let batch: string[] = [], size = 2;
          const flush = () => {
            if (!batch.length) return;
            const bytes = `[${batch.join(",")}]`, filename = name();
            if (Buffer.byteLength(bytes) > FILE_LIMIT) refuse("capacity");
            parts.push({name: filename, sha256: hash(bytes), bytes: Buffer.byteLength(bytes), count: batch.length});
            payloads.push([filename, bytes]); batch = []; size = 2;
          };
          for (const value of values) {
            const row = JSON.stringify(value);
            if (size + Buffer.byteLength(row) + 1 > CHUNK_TARGET) flush();
            batch.push(row); size += Buffer.byteLength(row) + 1;
          }
          flush(); return parts;
        };
        const parts = group(rows, () => dataName(randomUUID()));
        const inventories = group(retired, () => `retire.${randomUUID()}.json`);
        const plan: CutPlan = {...claim, schema: "scout.pairing-cutover-plan/v2", revision: state.revision,
          logicalHead: state.hash, logicalPeersHash: state.peersHash, checkpointPeersHash: hash(encodePeers(state.peers)),
          projectionHash: state.projectionHash, peers: state.peers, outcomesDigest: hash(JSON.stringify(rows)),
          chargedBytes: state.bytes, policy, parts, inventories, adoption: state.adoption};
        const planBytes = pack("plan", plan), planHash = hash(planBytes), bodies = cutBodies(plan, planHash);
        payloads.push(["claim.json", pack("claim", claim)], ["plan.json", planBytes], ["barrier.json", bodies.barrierBytes], ...bodies.files);
        const authorityBytes = parts.reduce((n, part) => n + part.bytes, 0) + Buffer.byteLength(bodies.barrierBytes)
          + bodies.files.reduce((n, [, bytes]) => n + Buffer.byteLength(bytes), 0);
        if (parts.length > 256 || inventories.length > 64 || payloads.length > RESERVATION_FILES || authorityBytes > TOTAL_LIMIT
          || payloads.some(([, bytes]) => Buffer.byteLength(bytes) > FILE_LIMIT)) refuse("capacity");
        payloads.forEach(([name, bytes], index) => this.fillCutReservation(root, claim, index, name, bytes));
        this.syncCutDirectory(root, claim); this.syncDirectory(root);
        for (const [name, bytes] of payloads) {
          if (!this.cutSource(root, claim, name)?.equals(Buffer.from(bytes))) refuse("migration_candidate_invalid");
        }
        const before = this.state(root);
        if (before.revision !== state.revision || before.hash !== state.hash || before.projectionHash !== state.projectionHash
          || !same(before.outcomes, state.outcomes) || before.bytes !== state.bytes) refuse("revision_conflict");
        if (invocation) { this.validateInvocation(invocation, root); invocation.used = true; }
        uncertain = true;
        try { linkSync(join(root.path, cutChild("barrier.json")), join(root.path, bodies.barrierName)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { uncertain = false; refuse("revision_conflict"); } throw error; }
        reserved = true; uncertain = false;
        this.syncDirectory(root);
        this.completeCutover(root, bodies.barrier, Buffer.from(bodies.barrierBytes));
        if (invocation) this.validateInvocation(invocation, root);
        return {migrationId, revision: state.revision, logicalHead: state.hash};
      } finally {
        if (!reserved && !uncertain) this.removeCutFiles(root, claim);
      }
    });
  }
  /** Explicit trusted-local maintenance. Calling with quiescent:true asserts
   * ALL writers/maintenance callers are excluded; no PID/age inference exists.
   * Even this caller's live invocation must be drained before entry. */
  reclaimCapsuleStaging(reclamationId: string, options: {quiescent: true}): CapsuleReclamationReceipt {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(reclamationId) || options?.quiescent !== true) refuse("reclamation_quiescence_required");
    const observed = this.root();
    if (!observed) refuse("reclamation_missing_root");
    const adapter = adapters.get(observed.fs);
    if (adapter?.currentHolder(observed) || [...liveInvocations].some(i => i.active && i.root.fs === observed.fs)) refuse("reclamation_holder_active");
    return this.operation(undefined, (bound, invocation) => {
      const root = bound!;
      const authority = () => {
        if ([...liveInvocations].some(i => i.active && i.root.fs === root.fs && i !== invocation)) refuse("reclamation_holder_active");
        if (invocation) this.validateInvocation(invocation, root);
        const state = this.readyState(root), cap = state.capsule;
        if (!cap) refuse("reclamation_capsule_required");
        const references = new Set([PEERS, MARKER, cap.barrierName, CUTOVER, commitName(cap.head.serial), doneName(cap.head.serial),
          ...cap.head.parts.map(p => p.name), ...cap.barrier.parts.map(p => p.name), ...cap.head.retire.map(r => r.name)]);
        const tokens = new Set<string>();
        if (cap.head.slot) tokens.add(cap.head.slot.token); // An index alone is not a resource reference.
        if (cap.barrier.migration) tokens.add(cap.barrier.migration.token);
        return {revision: state.revision, logicalHead: state.hash, physicalHead: cap.physicalHash, cutHash: cap.cutHash, references, tokens};
      };
      return reclaimCapsuleStaging(root, reclamationId, {check: () => this.check(root), authority, fail: refuse,
        objectId: stat => this.objectId(root, stat), objectIs: (value, stat) => this.objectIs(root, value, stat),
        rootIs: value => this.rootIs(root, value)});
    });
  }
  private capsulePolicy(root: Root, policy: ManagedPolicy | null) {
    if (!policy) return;
    const adapter = adapters.get(root.fs);
    if (!adapter || adapter.id !== policy.marker.adapterId) refuse("managed_adapter_required");
    const active = invocations.getStore();
    if (!active || active.owner !== this) refuse("managed_context_required");
    this.validateInvocation(active, root);
  }
  /** Atomic rename reserves one of eight nonempty token-bearing slots.
   * Empty canonical directories are abandoned, never live pre-token claims.
   * Tokens identify claims across time. dev:ino alone is only meaningful while
   * an open directory descriptor pins that object; freed inodes can be reused.
   * Nonempty claims stay occupied; no PID, timestamp or age takeover. */
  private capsuleSlots(root: Root, inventory: string[]) {
    const claims = new Map<string,CapsuleSlot>(), allowed = new Set<string>();
    for (const name of inventory.filter(n => n.startsWith(".pairing-v2-slot-"))) {
      if (!/^\.pairing-v2-slot-[0-7]$/.test(name)) refuse("capacity");
      const index = Number(name.at(-1)), path = join(root.path,name);
      const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd); owned(stat,true);
        if(id(lstatSync(path))!==id(stat))refuse("capsule_slot_invalid");
        const children = readdirSync(path);
        if (children.length > 1) refuse("unsafe_path");
        allowed.add(name);
        if (!children.length) {
          if(id(lstatSync(path))!==id(stat))refuse("capsule_slot_invalid");
          continue;
        }
        const child = children[0]!;
        if (!/^[a-f0-9-]{36}\.json$/.test(child)) refuse("unsafe_path");
        const bytes = this.readFile(root,`${name}/${child}`,false); if (!bytes) refuse("revision_conflict");
        const claim = unpack<Record<string,unknown>>(bytes,"claim",refuse);
        if (!this.rootIs(root, claim.rootId) || claim.index !== index || !token(claim.token) || child !== `${claim.token}.json`
          || !this.objectIs(root, claim.identity, stat) || id(lstatSync(path)) !== id(stat)) refuse("unsafe_path");
        const slot = {index,token:claim.token,identity:claim.identity as string};
        if(claims.has(slot.token))refuse("capsule_slot_invalid");claims.set(slot.token,slot);
        let total = bytes.length;
        for (const candidate of [dataName(slot.token), ...(["peers","commit","marker","done"] as const).map(r=>stageName(slot.token,r))]) {
          allowed.add(candidate);
          try {
            const s = lstatSync(join(root.path,candidate)); owned(s,false,false,candidate===stageName(slot.token,"commit"));
            if (s.size > FILE_LIMIT) refuse("capacity"); total += s.size;
          } catch (e) {if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;}
        }
        if (total > SLOT_LIMIT) refuse("capacity");
        if(!this.slotMatches(root,slot,fd))refuse("capsule_slot_invalid");
      } finally {closeSync(fd);}
    }
    this.check(root); return {claims,allowed};
  }
  private capsuleState(root: Root, allowPending: boolean, inventory: string[], materialize = true): State {
    const names = inventory.filter(n=>n.startsWith(PREFIX) || n.startsWith(CAPSULE_PREFIX) || n.startsWith(".pairing-v2")).sort();
    if (names.length > 360) refuse("capacity");
    const barriers = names.filter(n=>n.startsWith(PREFIX));
    if (barriers.length !== 1) refuse("capsule_unexpected_history");
    const barrierBytes = this.readFile(root,barriers[0]!,false); if (!barrierBytes) refuse("capsule_barrier_required");
    const b = unpack<CapsuleBarrier>(barrierBytes,"barrier",refuse), cutHash = hash(barrierBytes);
    if (b.schema !== "scout.pairing-cut/v2" || !this.rootIs(root,b.rootId) || !integer(b.revision,0,REVISION_LIMIT)
      || barriers[0] !== `${PREFIX}${b.revision+1}.json` || !hex(b.logicalHead) || !hex(b.logicalPeersHash)
      || !hex(b.checkpointPeersHash) || !hex(b.projectionHash) || !hex(b.outcomesDigest)
      || !integer(b.chargedBytes,0,TOTAL_LIMIT) || !policyValid(b.policy,v => this.rootIs(root, v),b.revision)
      || !Array.isArray(b.parts) || b.parts.length>256 || !b.parts.every(partValid)) refuse("capsule_barrier_invalid");
    const cutBytes = this.readFile(root,CUTOVER,false); if (!cutBytes) refuse("capsule_cutover_incomplete");
    const cut = unpack<Record<string,unknown>>(cutBytes,"receipt",refuse);
    if (cut.schema !== "scout.pairing-cutover-done/v2" || !this.rootIs(root,cut.rootId) || cut.cutHash !== cutHash) refuse("capsule_cutover_incomplete");
    const serials = names.filter(n=>n.startsWith(`${CAPSULE_PREFIX}commit.`)).map(n=>{
      const match=/^trusted-peers\.v2\.commit\.([1-9][0-9]*)\.json$/.exec(n);
      if (!match || !integer(Number(match[1]),1,Number.MAX_SAFE_INTEGER)) refuse("capsule_serial_invalid");
      return Number(match[1]);
    });
    if (!serials.length || serials.length>2) refuse("capsule_serial_invalid");
    const serial = Math.max(...serials), name = commitName(serial);
    const physical = this.readFile(root,name,true); if (!physical) refuse("revision_conflict");
    const h = unpack<CapsuleHead>(physical,"capsule",refuse), physicalHash = hash(physical);
    if (h.schema !== "scout.pairing-capsule/v2") refuse("capsule_version_unsupported");
    if (!this.rootIs(root,h.rootId) || h.cutHash !== cutHash || h.serial !== serial || !integer(h.revision,b.revision,REVISION_LIMIT)
      || h.serial!==h.revision-b.revision+1
      || !hex(h.logicalHead) || !hex(h.previousLogicalHead) || !hex(h.previousPhysicalHead)
      || !hex(h.logicalPeersHash) || !hex(h.checkpointPeersHash) || !hex(h.projectionHash) || !hex(h.outcomesDigest)
      || !integer(h.chargedBytes,0,TOTAL_LIMIT) || !policyValid(h.policy,v => this.rootIs(root, v),h.revision)
      || !Array.isArray(h.parts) || h.parts.length>256 || !h.parts.every(partValid)
      || !Array.isArray(h.retire) || h.retire.length>3) refuse("capsule_invalid");
    if (!same(h.parts.slice(0,b.parts.length),b.parts)) refuse("capsule_cut_changed");
    const checkpointPeers=peersOf(h.peers);
    if (hash(encodePeers(checkpointPeers)) !== h.checkpointPeersHash) refuse("capsule_peers_invalid");
    if (h.adoption !== null && (!record(h.adoption) || !hex(h.adoption.fromProjectionHash) || !hex(h.adoption.toProjectionHash))) refuse("capsule_invalid");
    const uniqueParts=new Set(h.parts.map(p=>p.name));
    if (uniqueParts.size !== h.parts.length) refuse("capsule_invalid");
    const outcomes:Record<string,SavedOutcome>={}, rows:CapsuleRow[]=[], partData:Buffer[]=[];
    // Full callers keep the existing retry lookup and chunk materialization.
    // Views retain only duplicate IDs and the last row, never prior bodies.
    const ids = materialize ? null : new Set<string>();
    let rowCount=0, lastRow:CapsuleRow|undefined;
    let charge=0, cutCharge=0, policy:ManagedPolicy|null=null, cutPolicy:ManagedPolicy|null=null, authorityBytes=physical.length+barrierBytes.length+cutBytes.length;
    // Reject an over-budget inventory before allocating its bodies. Each
    // declared byte length is also compared with the checked file below.
    if(authorityBytes+h.parts.reduce((n,p)=>n+p.bytes,0)>TOTAL_LIMIT)refuse("capacity");
    const fullDigest=createHash("sha256").update("["), cutDigest=createHash("sha256").update("[");
    for (let i=0;i<h.parts.length;i++) {
      const p=h.parts[i]!, bytes=this.readFile(root,p.name,false); if (!bytes) refuse("capsule_chunk_missing");
      authorityBytes+=bytes.length; if (authorityBytes>TOTAL_LIMIT) refuse("capacity");
      if (bytes.length!==p.bytes || hash(bytes)!==p.sha256) refuse("capsule_chunk_checksum");
      if (bytes[0]!==91 || bytes.at(-1)!==93) refuse("capsule_rows_invalid");
      const values:unknown=JSON.parse(bytes.toString());
      if (!Array.isArray(values) || values.length!==p.count) refuse("capsule_rows_invalid");
      if(i) fullDigest.update(","); fullDigest.update(bytes.subarray(1,-1));
      if(i<b.parts.length){if(i)cutDigest.update(",");cutDigest.update(bytes.subarray(1,-1));}
      for(const value of values){
        if(!rowValid(value,rowCount+1,v => this.rootIs(root, v)) || (ids ? ids.has(value[0]) : Object.hasOwn(outcomes,value[0]))) refuse("capsule_outcome_invalid");
        const row=value; rowCount++; lastRow=row; if(materialize)rows.push(row); else ids!.add(row[0]); charge+=row[6];
        if(row[2]==="manage") {if(policy)refuse("managed_downgrade");policy={revision:row[1],marker:this.normMarker(root,row[7],"capsule_outcome_invalid")};}
        if(row[1]<=b.revision){cutCharge+=row[6];cutPolicy=policy;}
        if(materialize)Object.defineProperty(outcomes,row[0],{value:{request:row[5],outcome:outcome(row)},enumerable:true});
      }
      if(materialize)partData.push(bytes);
    }
    if(rowCount!==h.revision || charge!==h.chargedBytes || charge>TOTAL_LIMIT || cutCharge!==b.chargedBytes
      || b.parts.reduce((n,p)=>n+p.count,0)!==b.revision || fullDigest.update("]").digest("hex")!==h.outcomesDigest
      || cutDigest.update("]").digest("hex")!==b.outcomesDigest) refuse("capsule_outcomes_invalid");
    // Permanent policy is derived from all retained records, not a head flag.
    // Records may mix legacy and v2 root ids. Compare normalized policies.
    const headPolicy=this.normPolicy(root,h.policy,"capsule_invalid"), barrierPolicy=this.normPolicy(root,b.policy,"capsule_barrier_invalid");
    if(!same(policy,headPolicy) || !same(cutPolicy,barrierPolicy)) refuse("managed_downgrade");
    if(h.revision===b.revision){
      if(h.previousLogicalHead!==b.logicalHead || h.previousPhysicalHead!==cutHash || h.logicalHead!==b.logicalHead || h.logicalPeersHash!==b.logicalPeersHash || h.checkpointPeersHash!==b.checkpointPeersHash
        || h.projectionHash!==b.projectionHash || h.outcomesDigest!==b.outcomesDigest) refuse("capsule_cut_changed");
    } else if(h.logicalPeersHash!==h.checkpointPeersHash || h.projectionHash!==h.checkpointPeersHash
      // The digest covers the root id and policy exactly as the head's writer stored them.
      || h.logicalHead!==logicalHead(h.rootId,h.revision,h.previousLogicalHead,h.logicalPeersHash,h.policy,lastRow!,h.adoption,h.outcomesDigest)) refuse("capsule_logical_head_invalid");
    this.capsulePolicy(root,policy);
    const slots=this.capsuleSlots(root,inventory);
    if(h.slot!==null && (!record(h.slot) || !integer(h.slot.index,0,7) || !token(h.slot.token)
      || !identityFormat(h.slot.identity))) refuse("capsule_slot_invalid");
    if(h.slot===null && (h.serial!==1 || h.revision!==b.revision)) refuse("capsule_slot_invalid");
    const stat=lstatSync(join(root.path,name));owned(stat,false,false,true);
    const pending=stat.nlink===2;
    if(pending){
      if(!h.slot || !same(slots.claims.get(h.slot.token),h.slot)) refuse("capsule_slot_invalid");
      const witness=lstatSync(join(root.path,stageName(h.slot.token,"commit")));owned(witness,false,false,true);
      if(id(witness)!==id(stat))refuse("publication_incomplete");
    }
    const marker=this.marker(root), managed=policy?.marker??null;
    if(!same(marker,managed) && !(pending && marker===null && managed!==null)) refuse("managed_marker_mismatch");
    const projection=this.readFile(root,PEERS), projectionHash=hash(projection??Buffer.alloc(0));
    let peers=checkpointPeers, adoption:ProjectionAdoption|null=null;
    if(!pending){
      if(managed && projectionHash!==h.logicalPeersHash)refuse("external_change_or_incomplete");
      if(!managed){
        peers=projection?peersOf(JSON.parse(projection.toString())):[];
        if(projectionHash!==h.logicalPeersHash)adoption={fromProjectionHash:h.logicalPeersHash,toProjectionHash:projectionHash};
      }
    }
    const allowed=new Set([barriers[0]!,CUTOVER,name,doneName(serial),...h.parts.map(p=>p.name),...slots.allowed]);
    const retiredNames=new Set<string>();
    if(serial===1 && h.retire.length)refuse("capsule_retirement_invalid");
    for(const r of h.retire){
      if(!record(r) || typeof r.name!=="string" || !hex(r.sha256) || !identityFormat(r.identity)
        || retiredNames.has(r.name) || uniqueParts.has(r.name)
        || !(r.name===commitName(serial-1) && r.sha256===h.previousPhysicalHead || r.name===doneName(serial-1)
          || /^trusted-peers\.v2\.data\.[a-f0-9-]{36}\.json$/.test(r.name))) refuse("capsule_retirement_invalid");
      retiredNames.add(r.name);allowed.add(r.name);
    }
    if(serial>1 && (!retiredNames.has(commitName(serial-1)) || !retiredNames.has(doneName(serial-1))))refuse("capsule_retirement_invalid");
    if(names.some(n=>!allowed.has(n)))refuse("capsule_unexpected_history");
    const receiptBytes=this.readFile(root,doneName(serial),false);
    if(receiptBytes){const receipt=unpack<Record<string,unknown>>(receiptBytes,"receipt",refuse);
      if(authorityBytes+receiptBytes.length>TOTAL_LIMIT)refuse("capacity");
      if(receipt.schema!=="scout.pairing-collected/v2" || !this.rootIs(root,receipt.rootId) || receipt.serial!==serial || receipt.physicalHash!==physicalHash)refuse("capsule_receipt_invalid");
      if(h.retire.some(r=>names.includes(r.name)))refuse("capsule_retired_reappeared");
    }
    const ownSlotExists=!!(h.slot && same(slots.claims.get(h.slot.token),h.slot));
    const needsRecovery=pending || !receiptBytes || ownSlotExists;
    if(needsRecovery && !allowPending)refuse("publication_incomplete");
    const after=readdirSync(root.path).filter(n=>n.startsWith(PREFIX)||n.startsWith(CAPSULE_PREFIX)||n.startsWith(".pairing-v2")).sort();
    if(!same(names,after))refuse("revision_conflict");this.check(root);
    this.capsulePolicy(root,policy); // Also validate the holder after all authority I/O.
    return {revision:h.revision,peers,hash:h.logicalHead,peersHash:h.logicalPeersHash,managed,outcomes,bytes:charge,
      projectionHash,adoption,pendingStage:pending&&h.slot?join(root.path,stageName(h.slot.token,"commit")):null,
      projectionStage:h.slot?stageName(h.slot.token,"peers"):null,
      capsule:{barrier:{...b,policy:barrierPolicy},barrierName:barriers[0]!,cutHash,head:{...h,policy:headPolicy},physicalHash,rows,partData,needsRecovery,pending}};
  }
  /** The descriptor must stay open for the entire check/use interval. */
  private slotMatches(root: Root, slot: CapsuleSlot, fd: number): boolean {
    const stat=fstatSync(fd);owned(stat,true);
    if(!this.objectIs(root,slot.identity,stat))return false;
    const directory=join(root.path,slotName(slot.index));
    try {
      if(id(lstatSync(directory))!==id(stat))return false;
      const bytes=this.readFile(root,`${slotName(slot.index)}/${slot.token}.json`,false);
      if(!bytes)return false; // Includes a newer mkdir before its token write.
      const claim=unpack<Record<string,unknown>>(bytes,"claim",refuse);
      if(!this.rootIs(root,claim.rootId) || !same(claim,{rootId:claim.rootId,...slot}))refuse("capsule_slot_invalid");
      return id(lstatSync(directory))===id(stat);
    } catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}
  }
  private syncSlot(root: Root, slot: CapsuleSlot) {
    this.check(root);const path=join(root.path,slotName(slot.index));
    const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try {
      if(!this.slotMatches(root,slot,fd))refuse("capsule_slot_invalid");
      fsyncSync(fd);
      if(!this.slotMatches(root,slot,fd))refuse("capsule_slot_invalid");
    } finally {closeSync(fd);}this.check(root);
  }
  /** A candidate carries only its small claim file, never staged payloads.
   * It is outside the authority inventory until its atomic directory rename.
   * Only an empty canonical slot can be replaced; live claims stay nonempty. */
  private claimCapsuleSlot(root: Root): CapsuleSlot {
    for(let index=0;index<8;index++){
      this.check(root);
      const candidate=`.pairing-claim-${randomUUID()}`,source=join(root.path,candidate);
      mkdirSync(source,{mode:0o700});
      const fd=openSync(source,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {
        const stat=fstatSync(fd);
        owned(stat,true);
        const slot={index,token:randomUUID(),identity:this.objectId(root,stat)},child=`${slot.token}.json`;
        let renamed=false;
        try {
          this.writeNew(root,`${candidate}/${child}`,pack("claim",{rootId:root.id,...slot}));
          if(id(lstatSync(source))!==id(stat) || !same(readdirSync(source),[child]))refuse("capsule_slot_invalid");
          const bytes=this.readFile(root,`${candidate}/${child}`,false);
          if(!bytes || !same(unpack(bytes,"claim",refuse),{rootId:root.id,...slot}))refuse("capsule_slot_invalid");
          // Persist the complete claim BEFORE exposing it at a reusable index.
          fsyncSync(fd);this.syncDirectory(root);
          try {renameSync(source,join(root.path,slotName(index)));}
          catch(e){
            if(["ENOTEMPTY","EEXIST"].includes((e as NodeJS.ErrnoException).code??""))continue;
            throw e;
          }
          renamed=true;
          if(!this.slotMatches(root,slot,fd))refuse("capsule_slot_invalid");
          this.syncDirectory(root);
          return slot;
        } catch(e){
          if(renamed)this.releaseCapsuleSlot(root,slot);
          throw e;
        } finally {
          if(!renamed){
            // The descriptor pins THIS unique candidate across cleanup.
            // Crashed candidates are metadata, not canonical resource claims.
            if(id(lstatSync(source))!==id(fstatSync(fd)))refuse("capsule_slot_invalid");
            const names=readdirSync(source);
            if(names.some(name=>name!==child))refuse("capsule_slot_invalid");
            if(names.length)unlinkSync(join(source,child));
            rmdirSync(source);
            this.syncDirectory(root);
          }
        }
      } finally {closeSync(fd);}
    }
    return refuse("capsule_staging_capacity");
  }
  private releaseCapsuleSlot(root: Root, slot: CapsuleSlot) {
    this.check(root);const directory=join(root.path,slotName(slot.index));
    let fd:number;
    try{fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
    try {
      // A matching inode without this token is not ownership. In particular,
      // never rmdir an empty newer claim that reused a previous inode number.
      if(!this.slotMatches(root,slot,fd))return;
      const name=`${slotName(slot.index)}/${slot.token}.json`;
      try{unlinkSync(join(root.path,name));}
      catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      // Keep fd open across unlink and rmdir: another helper can consume this
      // directory, but its replacement cannot reuse this still-pinned inode.
      if(id(lstatSync(directory))!==id(fstatSync(fd)))return;
      fsyncSync(fd);rmdirSync(directory);
    } catch(e) {
      if(!["ENOENT","ENOTEMPTY","EEXIST"].includes((e as NodeJS.ErrnoException).code??""))throw e;
    } finally {closeSync(fd);}
    this.syncDirectory(root);
  }
  private capsuleFileIdentity(root: Root, name: string): RetiredFile {
    const bytes=this.readFile(root,name,false);if(!bytes)refuse("revision_conflict");
    const stat=lstatSync(join(root.path,name));owned(stat);
    return {name,sha256:hash(bytes),identity:this.objectId(root,stat)};
  }
  private completeCapsule(root: Root, snapshot: State) {
    if(completing.has(root.fs))refuse("publication_incomplete");
    completing.add(root.fs);
    try {
      let state=this.state(root,true), cap=state.capsule!;
      if(!cap || cap.head.serial!==snapshot.capsule!.head.serial)return;
      const h=cap.head, slot=h.slot;
      if(cap.pending){
        if(!slot)refuse("publication_incomplete");
        this.capsulePolicy(root,h.policy);
        if(h.policy){
          const markerSource=stageName(slot.token,"marker"), staged=this.readFile(root,markerSource,false);
          if(staged){
            if(!same(this.normMarker(root,JSON.parse(staged.toString()),"publication_incomplete"),h.policy.marker))refuse("publication_incomplete");
            try{renameSync(join(root.path,markerSource),join(root.path,MARKER));}
            catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          }
          if(!same(this.marker(root),h.policy.marker))refuse("managed_marker_mismatch");
        }
        const source=stageName(slot.token,"peers"), bytes=this.readFile(root,source,false);
        if(bytes){
          if(hash(bytes)!==h.projectionHash)refuse("publication_incomplete");
          this.check(root);
          try{renameSync(join(root.path,source),join(root.path,PEERS));}
          catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
        }
        state=this.state(root,true);cap=state.capsule!;
        if(cap.head.serial!==h.serial)return;
        if(state.projectionHash!==h.projectionHash || !same(this.marker(root),h.policy?.marker??null))refuse("publication_incomplete");
        try{unlinkSync(join(root.path,stageName(slot.token,"commit")));}
        catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
        this.syncDirectory(root);
      }
      state=this.state(root,true);cap=state.capsule!;
      if(cap.head.serial!==h.serial)return;
      if(!this.readFile(root,doneName(h.serial),false)){
        // Establish publication durability BEFORE retiring any older authority.
        this.syncDirectory(root);
        try {
          for(const retired of h.retire){
            const bytes=this.readFile(root,retired.name,false);
            if(!bytes)continue;
            const stat=lstatSync(join(root.path,retired.name));owned(stat);
            if(!this.objectIs(root,retired.identity,stat) || hash(bytes)!==retired.sha256)refuse("capsule_retirement_changed");
            this.check(root);
            try{unlinkSync(join(root.path,retired.name));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          }
          this.syncDirectory(root);
          if(!slot)refuse("publication_incomplete");
          const receiptSource=stageName(slot.token,"done"), receipt=this.readFile(root,receiptSource,false);
          if(receipt){
            const r=unpack<Record<string,unknown>>(receipt,"receipt",refuse);
            if(!this.rootIs(root,r.rootId) || r.serial!==h.serial || r.physicalHash!==cap.physicalHash || r.schema!=="scout.pairing-collected/v2")refuse("capsule_receipt_invalid");
            try{renameSync(join(root.path,receiptSource),join(root.path,doneName(h.serial)));}
            catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          }
          this.syncDirectory(root);
          // A consumed receipt source is never reconstructed by a late helper.
          const latest=this.state(root,true);
          if(latest.capsule!.head.serial!==h.serial)return;
          if(!this.readFile(root,doneName(h.serial),false))refuse("publication_incomplete");
        }catch(e){if(e instanceof PairingTrustError)throw e;refuse("capsule_collection_failed");}
      }
      if(slot)this.releaseCapsuleSlot(root,slot);
    } catch(e){if(e instanceof PairingTrustError)throw e;refuse("publication_incomplete");}
    finally{completing.delete(root.fs);}
  }
  private publishCapsule(root: Root, state: State, peers: TrustedPeer[], managed: Marker|null,
    request: string, result: TrustOutcome, invocation?: Invocation, beforePublish?:()=>void): TrustOutcome {
    const prior=state.capsule!, old=prior.head;
    if(old.serial>=Number.MAX_SAFE_INTEGER)refuse("capacity");
    const charge=legacyCharge(root.id,result.revision,state.hash,peers,managed,request,result,state.adoption);
    if(charge>FILE_LIMIT || state.bytes+charge>TOTAL_LIMIT)refuse("capacity");
    const row:CapsuleRow=[result.mutationId,result.revision,result.type,result.publicKey,result.changed,request,charge,
      result.type==="manage"?managed:null];
    const policy:ManagedPolicy|null=result.type==="manage"?{revision:result.revision,marker:managed!}:old.policy;
    this.capsulePolicy(root,policy);
    const slot=this.claimCapsuleSlot(root), serial=old.serial+1;
    let reserved=false, uncertain=false;
    try {
      const parts=old.parts.map(p=>({...p})), payloads=prior.partData.slice();
      let replaced:CapsulePart|undefined, data:string;
      const tail=payloads.at(-1);
      // Initial cut chunks stay immutable forever. Later writes COW only the final chunk.
      if(parts.length>prior.barrier.parts.length && tail && tail.length+Buffer.byteLength(JSON.stringify(row))+1<=CHUNK_TARGET){
        replaced=parts.pop();payloads.pop();
        data=tail.subarray(0,-1).toString()+","+JSON.stringify(row)+"]";
        if(!Buffer.from(data).subarray(0,tail.length-1).equals(tail.subarray(0,-1)))refuse("capsule_prior_rows_changed");
      }else data=JSON.stringify([row]);
      const bytes=Buffer.from(data), part:CapsulePart={name:dataName(slot.token),sha256:hash(bytes),bytes:bytes.length,
        count:(replaced?.count??0)+1};
      if(bytes.length>FILE_LIMIT || parts.length>=256)refuse("capacity");
      parts.push(part);payloads.push(bytes);
      const table=createHash("sha256").update("[");
      payloads.forEach((b,i)=>{if(i)table.update(",");table.update(b.subarray(1,-1));});
      const outcomesDigest=table.update("]").digest("hex"), peerBytes=encodePeers(peers), peersHash=hash(peerBytes);
      const retire=[this.capsuleFileIdentity(root,commitName(old.serial)),this.capsuleFileIdentity(root,doneName(old.serial))];
      if(replaced)retire.push(this.capsuleFileIdentity(root,replaced.name));
      const h:CapsuleHead={schema:"scout.pairing-capsule/v2",rootId:root.id,cutHash:prior.cutHash,serial,
        revision:result.revision,logicalHead:logicalHead(root.id,result.revision,state.hash,peersHash,policy,row,state.adoption,outcomesDigest),
        previousLogicalHead:state.hash,previousPhysicalHead:prior.physicalHash,logicalPeersHash:peersHash,
        checkpointPeersHash:peersHash,projectionHash:peersHash,peers,policy,outcomesDigest,chargedBytes:state.bytes+charge,
        parts,adoption:state.adoption,slot,retire};
      const header=pack("capsule",h), physicalHash=hash(header);
      const receipt=pack("receipt",{schema:"scout.pairing-collected/v2",rootId:root.id,serial,physicalHash});
      const markerBytes=managed && !state.managed?JSON.stringify(managed):"";
      if([data,peerBytes,header,receipt,markerBytes].some(v=>Buffer.byteLength(v)>FILE_LIMIT))refuse("capacity");
      const barrierBytes=this.readFile(root,prior.barrierName,false), cutBytes=this.readFile(root,CUTOVER,false);
      if(!barrierBytes || !cutBytes)refuse("revision_conflict");
      if(Buffer.byteLength(header)+parts.reduce((n,p)=>n+p.bytes,0)+barrierBytes.length+cutBytes.length+Buffer.byteLength(receipt)>TOTAL_LIMIT)refuse("capacity");
      const claimBytes=this.readFile(root,`${slotName(slot.index)}/${slot.token}.json`,false);
      if(!claimBytes || claimBytes.length+bytes.length+Buffer.byteLength(peerBytes)+Buffer.byteLength(header)+Buffer.byteLength(receipt)+Buffer.byteLength(markerBytes)>SLOT_LIMIT)refuse("capacity");
      this.writeNew(root,part.name,data);
      this.writeNew(root,stageName(slot.token,"peers"),peerBytes);
      if(markerBytes)this.writeNew(root,stageName(slot.token,"marker"),markerBytes);
      this.writeNew(root,stageName(slot.token,"commit"),header);
      this.writeNew(root,stageName(slot.token,"done"),receipt);
      this.capsuleSlots(root,readdirSync(root.path));
      this.syncDirectory(root);
      const before=this.state(root);
      if(!before.capsule || before.revision!==state.revision || before.hash!==state.hash || before.projectionHash!==state.projectionHash
        || before.capsule.physicalHash!==prior.physicalHash)refuse("revision_conflict");
      // Verify the actual candidate sources, not just the in-memory intent.
      const candidateFiles:[string,string][]=[[part.name,data],[stageName(slot.token,"peers"),peerBytes],
        [stageName(slot.token,"commit"),header],[stageName(slot.token,"done"),receipt]];
      if(markerBytes)candidateFiles.push([stageName(slot.token,"marker"),markerBytes]);
      for(const [name,expected] of candidateFiles){const actual=this.readFile(root,name,false);
        if(!actual || !actual.equals(Buffer.from(expected)))refuse("capsule_candidate_changed");}
      // Assert prior records, not merely their count, immediately before publication.
      const oldRows=before.capsule.rows;
      const candidateRows=payloads.flatMap(b=>JSON.parse(b.toString()) as CapsuleRow[]);
      if(!same(candidateRows.slice(0,-1),oldRows) || !same(candidateRows.at(-1),row))refuse("capsule_prior_rows_changed");
      if(invocation){this.validateInvocation(invocation,root);invocation.used=true;}
      beforePublish?.();
      uncertain=true;
      try{linkSync(join(root.path,stageName(slot.token,"commit")),join(root.path,commitName(serial)));}
      catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST"){uncertain=false;refuse("revision_conflict");}throw e;}
      reserved=true;uncertain=false;
      this.syncDirectory(root);
      this.completeCapsule(root,this.state(root,true));
      if(invocation)this.validateInvocation(invocation,root);
      const committed=this.readyState(root);
      if(committed.outcomes[result.mutationId]?.request!==request)refuse("outcome_unavailable");
      return structuredClone(result);
    } finally {
      if(!reserved && !uncertain){
        for(const name of [dataName(slot.token),...(["peers","commit","marker","done"] as const).map(r=>stageName(slot.token,r))]){
          const bytes=this.readFile(root,name,false);
          if(bytes){this.check(root);try{unlinkSync(join(root.path,name));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
        }
        this.releaseCapsuleSlot(root,slot);
      }
    }
  }
  private validateInvocation(invocation: Invocation, root: Root) {
    if (!invocation.active || invocations.getStore() !== invocation || invocation.owner !== this
      || invocation.root.fs !== root.fs || adapters.get(root.fs) !== invocation.adapter
      || invocation.adapter.currentHolder(root) !== invocation.holder) refuse("invalid_context");
  }
  /** One callback invocation; a context permits at most one publication.
   * Reads can repeat. Capturing an object does not capture gate ownership. */
  withInvocation<T>(body: (context: PairingTrustContext) => T): T {
    const root = this.root(true)!; const adapter = adapters.get(root.fs);
    if (!adapter) refuse("managed_adapter_required");
    return adapter.withGate(root, holder => {
      const invocation: Invocation = {owner: this, root, adapter, holder, active: true, used: false};
      const context = Object.freeze({ toJSON(): never { return refuse("context_not_serializable"); } }) as unknown as PairingTrustContext;
      contexts.set(context, invocation);
      liveInvocations.add(invocation);
      return invocations.run(invocation, () => {
        try {
          this.validateInvocation(invocation, root);
          const result = body(context);
          if (result && typeof (result as {then?: unknown}).then === "function") {
            return Promise.resolve(result).finally(() => { invocation.active = false; liveInvocations.delete(invocation); }) as T;
          }
          invocation.active = false; liveInvocations.delete(invocation); return result;
        } catch (e) { invocation.active = false; liveInvocations.delete(invocation); throw e; }
      });
    });
  }
  private operation<T>(context: PairingTrustContext | undefined, body: (root: Root | null, invocation?: Invocation) => T): T {
    const root = this.root();
    if (context !== undefined) {
      const invocation = contexts.get(context as object);
      if (!root || !invocation) refuse("invalid_context");
      this.validateInvocation(invocation, root); return body(root, invocation);
    }
    if (root && adapters.has(root.fs)) return this.withInvocation(ctx => this.operation(ctx, body));
    return body(root);
  }
  read(context?: PairingTrustContext): TrustSnapshot {
    const snapshot = this.operation(context, root => {
      if (!root) return {revision: 0, peers: [] as TrustedPeer[]};
      const state = this.readyState(root); return {revision: state.revision, peers: structuredClone(state.peers)};
    });
    try {
      const root = this.root(), advisory = root ? this.lastSeen(root) : new Map<string, string>();
      for (const peer of snapshot.peers) {
        const seen = advisory.get(peer.publicKey);
        if (seen) peer.lastSeen = this.laterSeen(peer, seen);
      }
    } catch { /* An unavailable advisory file never hides an authority snapshot. */ }
    return snapshot;
  }
  /** Exhaustive transport authority without the unused saved-retry lookup.
   * Every call re-reads/hashes/validates all authority through the same validator
   * as read(). No cache, advisory merge, automatic migration or session state.
   * Pending publication completes with a full build before any view is served. */
  readAuthority(context?: PairingTrustContext): PairingAuthorityView {
    this.root(true);
    return this.operation(context, root => {
      const state = this.readyState(root!, false);
      return {revision: state.revision, peers: structuredClone(state.peers),
        stamp: this.pairingOpportunityStamp(root!, state)};
    });
  }
  /** Membership is authoritative; the subsequent display-only write is best
   * effort, needs no gate and never changes projection/generations/outcomes. */
  refresh(publicKey: string, lastSeen: string, context?: PairingTrustContext): void {
    fullKey(publicKey);
    if (typeof lastSeen !== "string" || lastSeen.length > 128) refuse("invalid_mutation");
    const snapshot = this.read(context);
    if (!snapshot.peers.some(peer => peer.publicKey === publicKey)) refuse("peer_revoked");
    try {
      const root = this.root();
      if (root) this.recordLastSeen(root, snapshot.peers, publicKey, lastSeen);
    } catch { /* Authority succeeded; advisory metadata is optional. */ }
  }
  /** Verified decision baseline for a trusted workflow crossing process startup.
   * This is not a grant; only a matching live opportunity can admit a peer. */
  pairingAuthorityStamp(): string {
    this.root(true);
    return this.operation(undefined, root => this.pairingOpportunityStamp(root!, this.readyState(root!)));
  }
  private pairingOpportunityStamp(root: Root, state: State): string {
    return hash(JSON.stringify([root.id, state.revision, state.hash, state.projectionHash, state.managed]));
  }
  /** Trusted local workflow only. Opening a window does not write authority.
   * Any intervening authority change cancels it; advisory lastSeen is excluded. */
  openPairingOpportunity(room: string, expiresAt: number, expectedPublicKey?: string, expectedAuthorityStamp?: string): PairingOpportunity {
    if (expectedPublicKey !== undefined) fullKey(expectedPublicKey);
    if (typeof room !== "string" || !room || room.length > 256 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || expiresAt - Date.now() > 300_000) refuse("invalid_pairing_opportunity");
    this.root(true);
    const stamp = (root: Root, state: State) => this.pairingOpportunityStamp(root, state);
    const baseline = this.operation(undefined, root => stamp(root!, this.readyState(root!)));
    if (expectedAuthorityStamp !== undefined && expectedAuthorityStamp !== baseline) refuse("pairing_opportunity_closed");
    const deadline = performance.now() + (expiresAt - Date.now());
    const id = randomUUID(); let closed = false, consumed = false;
    const valid = () => !closed && !consumed && Date.now() < expiresAt && performance.now() < deadline;
    return Object.freeze({ id, expiresAt,
      toJSON(): never { return refuse("opportunity_not_serializable"); },
      cancel() { closed = true; },
      isOpen: () => {
        if (!valid()) { closed = true; return false; }
        try {
          const current = this.operation(undefined, root => stamp(root!, this.readyState(root!)));
          if (current !== baseline) closed = true;
          return valid();
        } catch { closed = true; return false; }
      },
      admit: (publicKey: string, logicalRoom: string, isLive: () => boolean) => {
        try {
          fullKey(publicKey);
          // A different key cannot consume a named request's opportunity.
          if (expectedPublicKey !== undefined && publicKey !== expectedPublicKey) return false;
          if (logicalRoom !== room || !isLive() || !valid()) { closed = true; return false; }
          return this.operation(undefined, (root, invocation) => {
            const state = this.readyState(root!);
            if (!isLive() || !valid() || stamp(root!, state) !== baseline) { closed = true; return false; }
            // Consume before publication, including failed/uncertain publication.
            consumed = true;
            // A trusted scan still consumes, but creates no authority generation.
            if (state.peers.some(peer => peer.publicKey === publicKey)) {
              if (!isLive() || closed || Date.now() >= expiresAt || performance.now() >= deadline
                || stamp(root!, this.readyState(root!)) !== baseline) { closed = true; return false; }
              return true;
            }
            const peer = {publicKey, pairedAt: new Date().toISOString()};
            const context = invocation ? this.contextFor(invocation) : undefined;
            this.mutateGuarded(state.revision, id, {type: "grant", peer}, context, () => {
              const current = this.readyState(root!);
              if (!isLive() || closed || Date.now() >= expiresAt || performance.now() >= deadline
                || stamp(root!, current) !== baseline) refuse("pairing_opportunity_closed");
            });
            return true;
          });
        } catch (error) { closed = true; throw error; }
      },
    });
  }
  mutate(expectedRevision: number, mutationId: string, raw: TrustMutation, context?: PairingTrustContext): TrustOutcome {
    return this.mutateGuarded(expectedRevision, mutationId, raw, context);
  }
  private mutateGuarded(expectedRevision: number, mutationId: string, raw: TrustMutation, context?: PairingTrustContext, beforePublish?: () => void): TrustOutcome {
    // Snapshot untrusted caller-owned objects before adapter callbacks or I/O.
    const mutation = structuredClone(raw);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !/^[a-zA-Z0-9._:-]{1,128}$/.test(mutationId)) refuse("invalid_mutation");
    if (mutation.type === "grant") mutation.peer = peersOf([mutation.peer])[0]!;
    else if (mutation.type === "revoke") fullKey(mutation.publicKey);
    else if (mutation.type !== "manage") refuse("invalid_mutation");
    this.root(true);
    return this.operation(context, (bound, invocation) => {
      const root = bound!, state = this.readyState(root);
      const request = JSON.stringify([expectedRevision, mutation.type,
        mutation.type === "grant" ? mutation.peer : mutation.type === "manage" ? null : mutation.publicKey,
        null]);
      const saved = Object.hasOwn(state.outcomes, mutationId) ? state.outcomes[mutationId] : undefined;
      if (saved) {
        if (saved.request !== request) refuse("mutation_id_reused");
        // An earlier attempt may have published but failed its directory sync.
        // A retry must establish the barrier, not infer durability from bytes.
        this.syncDirectory(root);
        if (invocation) this.validateInvocation(invocation, root);
        const verified = this.state(root);
        if (verified.outcomes[mutationId]?.request !== request) refuse("outcome_unavailable");
        return structuredClone(saved.outcome);
      }
      if (state.revision !== expectedRevision) refuse("revision_conflict");
      if (invocation?.used) refuse("context_already_used");
      if (state.revision >= REVISION_LIMIT) refuse("capacity");
      const peers = structuredClone(state.peers);
      let changed = false, publicKey: string | null = null;
      let managed = state.managed;
      if (mutation.type === "manage") {
        if (!invocation || managed) refuse("invalid_adoption");
        managed = {schema: "scout.pairing-trust-managed/v1", rootId: root.id, adapterId: invocation.adapter.id};
        changed = true;
      } else {
        publicKey = mutation.type === "grant" ? mutation.peer.publicKey : mutation.publicKey;
        const index = peers.findIndex(p => p.publicKey === publicKey);
        if (mutation.type === "grant") {
          if (index < 0) peers.push(mutation.peer); else peers[index] = mutation.peer;
          changed = true;
        } else if (index >= 0) { peers.splice(index, 1); changed = true; }
      }
      const outcome: TrustOutcome = {mutationId, revision: state.revision + 1, type: mutation.type, publicKey, changed};
      const peerBytes = encodePeers(peers);
      if (state.capsule) return this.publishCapsule(root, state, peers, managed, request, outcome, invocation, beforePublish);
      let stagedPeers: string | null = null, stagedGeneration: string | null = null, stagedMarker: string | null = null;
      let reserved = false;
      try {
        stagedPeers = this.stage(root, peerBytes);
        const generation: Generation = {schema: "scout.pairing-trust-owner/v1", rootId: root.id,
          revision: outcome.revision, previousHash: state.hash, peersHash: hash(peerBytes), peers, managed, adoption: state.adoption, projectionStage: basename(stagedPeers), mutation: {request, outcome}};
        const bytes = JSON.stringify({generation, sha256: hash(JSON.stringify(generation))});
        if (state.bytes + Buffer.byteLength(bytes) > TOTAL_LIMIT) refuse("capacity");
        stagedGeneration = this.stage(root, bytes);
        // Revalidate after staging, including external replacement detection.
        const before = this.state(root);
        if (before.revision !== expectedRevision || before.hash !== state.hash || before.projectionHash !== state.projectionHash) refuse("revision_conflict");
        if (invocation) { this.validateInvocation(invocation, root); invocation.used = true; }
        // Exclusive immutable generation name is the unmanaged CAS. No new lock.
        beforePublish?.();
        try { linkSync(stagedGeneration, join(root.path, `${PREFIX}${outcome.revision}.json`)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") refuse("revision_conflict"); throw e; }
        reserved = true;
        if (mutation.type === "manage") {
          stagedMarker = this.stage(root, JSON.stringify(managed));
          linkSync(stagedMarker, join(root.path, MARKER)); unlinkSync(stagedMarker); stagedMarker = null;
        }
        // Original writer and helpers consume the same named projection stage.
        // If a helper already finished, do not rename or replay this mutation.
        const published = this.state(root, true);
        if (published.pendingStage && published.revision === outcome.revision && published.hash === hash(bytes)) this.completePublication(root, published);
        else this.syncDirectory(root);
        if (invocation) this.validateInvocation(invocation, root);
        const committed = this.state(root, true);
        if (committed.outcomes[mutationId]?.request !== request) refuse("outcome_unavailable");
        return structuredClone(outcome);
      } finally {
        for (const path of [reserved ? null : stagedPeers, reserved ? null : stagedGeneration, stagedMarker]) {
          if (path) { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
        }
      }
    });
  }
  revokePrefix(prefix: string, mutationId = randomUUID()): boolean {
    if (!/^[0-9a-f]{16}$/.test(prefix) && !/^[0-9a-f]{64}$/.test(prefix)) refuse("invalid_prefix");
    return this.operation(undefined, (_root, invocation) => {
      // Reuse this invocation rather than reacquire a native gate.
      const context = invocation ? this.contextFor(invocation) : undefined;
      const snapshot = this.read(context), matches = snapshot.peers.filter(p => p.publicKey.startsWith(prefix));
      if (matches.length > 1) refuse("ambiguous_prefix");
      if (!matches.length) return false;
      return this.mutate(snapshot.revision, mutationId, {type: "revoke", publicKey: matches[0]!.publicKey}, context).changed;
    });
  }
  private contextFor(invocation: Invocation): PairingTrustContext {
    const context = Object.freeze({toJSON(): never { return refuse("context_not_serializable"); }}) as unknown as PairingTrustContext;
    contexts.set(context, invocation); return context;
  }
  /** Typed trusted-bootstrap registration, root identity checked before install.
   * Unregistration does not delete the persistent managed marker. */
  register(adapter: PairingTrustAdapter): () => void {
    const root = this.root(true)!;
    if (!adapter || !/^[a-z0-9.-]{1,64}$/.test(adapter.id) || typeof adapter.withGate !== "function"
      || typeof adapter.currentHolder !== "function") refuse("invalid_adapter");
    if (adapters.has(root.fs)) refuse("adapter_already_registered");
    adapters.set(root.fs, adapter);
    return () => { if (adapters.get(root.fs) === adapter) adapters.delete(root.fs); };
  }
}
/** One owner per canonical root. Options apply when the owner is first made. */
export function pairingTrustOwner(path = resolveOpenScoutPairingHome(), options?: PairingTrustOwnerOptions): PairingTrustOwner {
  const root = canonical(path); let owner = owners.get(root);
  if (!owner) { owner = new PairingTrustOwner(root, options); owners.set(root, owner); }
  return owner;
}
