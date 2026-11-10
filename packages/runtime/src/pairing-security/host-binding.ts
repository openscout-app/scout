/** Durable pairing-store ownership. The signing key lives outside this store.
 * No key creation, migration, or filesystem work happens on import. */
import {randomUUID} from "node:crypto";
import {constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync,
  fsyncSync, linkSync, unlinkSync, readdirSync, type Stats} from "node:fs";
import {join} from "node:path";
import {canonicalJson, nodeKeyId, signNodePayload, verifyNodeSignature, type NodeIdentity} from "../node-identity-wire.js";

export const PAIRING_HOST_BINDING_FILE = "trusted-peers.host-binding.json";
export type PairingBindingHost = {identity: NodeIdentity; instanceId: string};
export type PairingHostBinding = {
  schema: "scout.pairing-host-binding/v1";
  hostKeyId: string;
  instanceId: string;
  storeId: string;
  path: string;
  authorityId: string;
  migrationId: string;
  signature: string;
};
type Failure = (code: string) => never;
const hex = /^[a-f0-9]{64}$/;
const token = /^[a-zA-Z0-9._:-]{1,128}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function physicalFileIdentity(stat: Stats): string { return `${stat.dev}:${stat.ino}`; }
/** Persistent file claims are scoped by the authenticated store, not st_dev.
 * Birth time distinguishes an inode reused after deletion. Live descriptor
 * checks still compare dev+ino before and after every operation. */
export function persistentFileIdentity(stat: Stats): string {
  const birth = Math.round(stat.birthtimeMs * 1000);
  if (!Number.isSafeInteger(birth) || birth <= 0) throw new Error("pairing_trust_file_birthtime_unavailable");
  return `${stat.ino}:${birth}`;
}
function payload(binding: PairingHostBinding) {
  const {signature: _, ...signed} = binding;
  return canonicalJson(signed);
}
function owned(stat: Stats, fail: Failure, pending = false) {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.nlink !== 1 && !(pending && stat.nlink === 2)) || (stat.mode & 0o077)) fail("host_binding_unsafe");
}
export function readPairingHostBinding(path: string, host: PairingBindingHost, fail: Failure): PairingHostBinding {
  const target = join(path, PAIRING_HOST_BINDING_FILE);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: Buffer;
  let pending: string | null = null;
  const rootIdentity = physicalFileIdentity(lstatSync(path));
  try {
    const stat = fstatSync(fd); owned(stat, fail, true);
    if (stat.nlink === 2) {
      const aliases = readdirSync(path).filter(name => /^\.pairing-host-binding-[a-f0-9-]{36}\.tmp$/.test(name))
        .filter(name => { const alias = lstatSync(join(path, name)); return !alias.isSymbolicLink() && physicalFileIdentity(alias) === physicalFileIdentity(stat); });
      if (aliases.length !== 1) return fail("host_binding_unsafe");
      owned(lstatSync(join(path, aliases[0]!)), fail, true); pending = aliases[0]!;
    }
    if (stat.size > 8192 || physicalFileIdentity(lstatSync(target)) !== physicalFileIdentity(stat)) fail("host_binding_unsafe");
    raw = readFileSync(fd);
    if (raw.length !== stat.size || physicalFileIdentity(lstatSync(target)) !== physicalFileIdentity(stat)) fail("host_binding_changed");
  } finally { closeSync(fd); }
  let binding: PairingHostBinding;
  try { binding = JSON.parse(raw.toString()); } catch { return fail("host_binding_invalid"); }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || Object.keys(binding).sort().join() !== "authorityId,hostKeyId,instanceId,migrationId,path,schema,signature,storeId"
    || binding.schema !== "scout.pairing-host-binding/v1" || !hex.test(binding.hostKeyId)
    || typeof binding.storeId !== "string" || !uuid.test(binding.storeId) || typeof binding.migrationId !== "string" || !token.test(binding.migrationId)
    || typeof binding.authorityId !== "string" || binding.authorityId.length > 256
    || !/^(?:[0-9]+:[0-9]+|host-store:[a-f0-9-]{36})$/.test(binding.authorityId)
    || typeof binding.signature !== "string" || binding.signature.length > 128) return fail("host_binding_invalid");
  // Never accept the key supplied by the store as the host's own identity.
  if (binding.hostKeyId !== nodeKeyId(host.identity.publicKey)) return fail("host_identity_mismatch");
  if (binding.instanceId !== host.instanceId || binding.path !== path) return fail("host_binding_scope_mismatch");
  if (!verifyNodeSignature(host.identity.publicKey, payload(binding), binding.signature)) return fail("host_binding_signature_invalid");
  if (pending) {
    // Help only a fully authenticated publication. A crash after exclusive
    // linking must not strand a legitimate store with two retained links.
    const dir = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (physicalFileIdentity(fstatSync(dir)) !== rootIdentity || physicalFileIdentity(lstatSync(path)) !== rootIdentity) return fail("host_binding_changed");
      const targetStat = lstatSync(target), source = join(path, pending);
      try {
        if (physicalFileIdentity(lstatSync(source)) !== physicalFileIdentity(targetStat)) return fail("host_binding_changed");
        unlinkSync(source);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fsyncSync(dir);
      owned(lstatSync(target), fail);
      if (physicalFileIdentity(lstatSync(path)) !== rootIdentity) return fail("host_binding_changed");
    } finally { closeSync(dir); }
  }
  return binding;
}
/** Caller has validated legacy authority and excluded all writers. Exclusive
 * publication admits only one first binding. A retry verifies that binding;
 * it never replaces a different host, scope, or migration. */
export function publishPairingHostBinding(path: string, host: PairingBindingHost, migrationId: string,
  authorityId: string | null, check: () => void, fail: Failure): PairingHostBinding {
  if (typeof migrationId !== "string" || !token.test(migrationId) || typeof host.instanceId !== "string" || !token.test(host.instanceId)) return fail("host_binding_invalid");
  const storeId = randomUUID();
  const binding: PairingHostBinding = {schema: "scout.pairing-host-binding/v1", hostKeyId: nodeKeyId(host.identity.publicKey),
    instanceId: host.instanceId, storeId, path, authorityId: authorityId ?? `host-store:${storeId}`, migrationId, signature: ""};
  binding.signature = signNodePayload(host.identity, payload(binding));
  const temporary = join(path, `.pairing-host-binding-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(binding, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    check();
    try { linkSync(temporary, join(path, PAIRING_HOST_BINDING_FILE)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  const dir = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { check(); fsyncSync(dir); check(); } finally { closeSync(dir); }
  const observed = readPairingHostBinding(path, host, fail);
  // New-store initialization can race another identical initializer; either
  // authenticated winner is valid. An explicit legacy migration has one ID.
  if (authorityId !== null && (observed.authorityId !== authorityId || observed.migrationId !== migrationId)) fail("host_binding_conflict");
  return observed;
}
