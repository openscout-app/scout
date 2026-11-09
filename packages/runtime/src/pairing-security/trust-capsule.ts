/** Internal disk codec. No I/O, activation, cache or alternate owner. */
import { createHash } from "node:crypto";
import type { TrustedPeer, TrustOutcome } from "./trust-owner.js";

export const CAPSULE_PREFIX = "trusted-peers.v2.";
export const CUTOVER = `${CAPSULE_PREFIX}cutover.json`;
export const FILE_LIMIT = 1024 * 1024;
export const SLOT_LIMIT = 3 * 1024 * 1024, CHUNK_TARGET = 512 * 1024;
export const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export type ManagedMarker = {schema:"scout.pairing-trust-managed/v1"; rootId:string; adapterId:string};
export type ManagedPolicy = {revision:number; marker:ManagedMarker};
export type CapsuleRow = [string, number, string, string|null, boolean, string, number, ManagedMarker|null];
export type CapsulePart = {name:string; sha256:string; bytes:number; count:number};
export type CapsuleSlot = {index:number; token:string; identity:string};
export type RetiredFile = {name:string; sha256:string; identity:string};
export type CapsuleBarrier = {
  schema:"scout.pairing-cut/v2"; rootId:string; revision:number; logicalHead:string;
  logicalPeersHash:string; checkpointPeersHash:string; projectionHash:string;
  outcomesDigest:string; chargedBytes:number; policy:ManagedPolicy|null; parts:CapsulePart[];
  migration?: {migrationId:string; token:string; identity:string; planHash:string};
};
export type CapsuleHead = {
  schema:"scout.pairing-capsule/v2"; rootId:string; cutHash:string; serial:number;
  revision:number; logicalHead:string; previousLogicalHead:string; previousPhysicalHead:string;
  logicalPeersHash:string; checkpointPeersHash:string; projectionHash:string; peers:TrustedPeer[];
  policy:ManagedPolicy|null; outcomesDigest:string; chargedBytes:number; parts:CapsulePart[];
  adoption:{fromProjectionHash:string;toProjectionHash:string}|null;
  slot:CapsuleSlot|null; retire:RetiredFile[];
};
export type CapsuleDecoded = {barrier:CapsuleBarrier; barrierName:string; cutHash:string;
  head:CapsuleHead; physicalHash:string; rows:CapsuleRow[]; partData:Buffer[];
  needsRecovery:boolean; pending:boolean};
export const commitName = (serial:number) => `${CAPSULE_PREFIX}commit.${serial}.json`;
export const doneName = (serial:number) => `${CAPSULE_PREFIX}done.${serial}.json`;
export const dataName = (token:string) => `${CAPSULE_PREFIX}data.${token}.json`;
export const slotName = (index:number) => `.pairing-v2-slot-${index}`;
export const stageName = (token:string, role:"peers"|"commit"|"marker"|"done") => `.pairing-v2-${token}-${role}.tmp`;
export const record = (v:unknown):v is Record<string,any> => !!v && typeof v === "object" && !Array.isArray(v);
export const hex = (v:unknown):v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const token = (v:unknown):v is string => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
export const integer = (v:unknown, min:number, max:number):v is number => Number.isSafeInteger(v) && Number(v)>=min && Number(v)<=max;
export const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
export const pack = (field:string, value:unknown) => JSON.stringify({[field]:value,sha256:digest(JSON.stringify(value))});
export function unpack<T>(bytes:Buffer, field:string, refuse:(code:string)=>never):T {
  const envelope = JSON.parse(bytes.toString());
  if (!record(envelope) || !record(envelope[field]) || envelope.sha256!==digest(JSON.stringify(envelope[field]))) refuse("capsule_checksum");
  return envelope[field] as T;
}
/** Accepts a persisted root id. See rootIs in trust-owner.ts: current keyed
 * ids and legacy dev:ino ids with a matching inode both pass. */
export type RootMatcher = (value:unknown) => boolean;
export function markerValid(value:unknown, rootIs:RootMatcher):value is ManagedMarker {
  return record(value) && value.schema==="scout.pairing-trust-managed/v1" && rootIs(value.rootId)
    && typeof value.adapterId==="string" && /^[a-z0-9.-]{1,64}$/.test(value.adapterId);
}
export function policyValid(value:unknown, rootIs:RootMatcher, revision:number):value is ManagedPolicy|null {
  return value===null || record(value) && integer(value.revision,1,revision) && markerValid(value.marker,rootIs);
}
export function partValid(p:unknown):p is CapsulePart {
  return record(p) && typeof p.name==="string" && /^trusted-peers\.v2\.data\.[a-f0-9-]{36}\.json$/.test(p.name)
    && hex(p.sha256) && integer(p.bytes,2,FILE_LIMIT) && integer(p.count,1,65536);
}
export function rowValid(row:unknown, revision:number, rootIs:RootMatcher):row is CapsuleRow {
  return Array.isArray(row) && row.length===8 && typeof row[0]==="string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(row[0])
    && row[1]===revision && ["grant","revoke","manage","refresh"].includes(row[2])
    && (row[2]==="manage" ? row[3]===null && markerValid(row[7],rootIs) : hex(row[3]) && row[7]===null)
    && typeof row[4]==="boolean" && typeof row[5]==="string" && integer(row[6],1,FILE_LIMIT);
}
export function outcome(row:CapsuleRow):TrustOutcome {
  return {mutationId:row[0],revision:row[1],type:row[2] as TrustOutcome["type"],publicKey:row[3],changed:row[4]};
}
export function logicalHead(rootId:string, revision:number, previous:string, peersHash:string,
  policy:ManagedPolicy|null, row:CapsuleRow, adoption:CapsuleHead["adoption"], outcomesDigest:string) {
  return digest(JSON.stringify(["scout.pairing-logical-generation/v2",rootId,revision,previous,peersHash,
    policy?.marker??null,{request:row[5],outcome:outcome(row)},adoption,outcomesDigest]));
}
/** Exact legacy-size accounting, not the smaller capsule's physical size. The
 * UUID's contents do not affect its encoded length; no path is created. */
export function legacyCharge(rootId:string, revision:number, previousHash:string, peers:TrustedPeer[],
  managed:ManagedMarker|null, request:string, result:TrustOutcome, adoption:CapsuleHead["adoption"]) {
  const generation = {schema:"scout.pairing-trust-owner/v1",rootId,revision,previousHash,
    peersHash:digest(JSON.stringify(peers,null,2)),peers,managed,adoption,
    projectionStage:".pairing-owner-00000000-0000-0000-0000-000000000000.tmp",mutation:{request,outcome:result}};
  return Buffer.byteLength(pack("generation",generation));
}
