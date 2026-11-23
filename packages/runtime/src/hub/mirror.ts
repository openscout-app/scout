/**
 * Applies opened chunks to mirror copies of cloud transcripts. A mirror file
 * only ever grows by whole lines at its end, so the Claude source tails it
 * like any local transcript.
 *
 * Headers come from outside this host and are checked before any write: the
 * label, session id and file path must match Claude's own layout, so a chunk
 * can only land inside the mirror root.
 */

import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { HubChunkHeader } from "./seal.js";

const LABEL = /^[A-Za-z0-9._-]{1,100}$/u;
const SESSION = /^[A-Za-z0-9-]{1,100}$/u;
const RUN = /^[A-Za-z0-9._-]{1,100}$/u;
const AGENT_FILE = /^agent-[A-Za-z0-9]{1,100}\.jsonl$/u;
export const MAX_MIRROR_FILE_BYTES = 1024 * 1024 * 1024;

export type MirrorOutcome =
  | { outcome: "appended"; path: string; bytes: number }
  | { outcome: "duplicate"; path: string }
  | { outcome: "gap"; path: string; have: number; offset: number }
  | { outcome: "rejected"; reason: string };

function safeName(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && value !== "." && value !== "..";
}

/** The mirror path a header points at, or a reason it may not be written. */
export function mirrorPathForHeader(root: string, header: HubChunkHeader): { path: string } | { reason: string } {
  if (header?.v !== 1 || header.kind !== "claude-code.transcript") return { reason: "unknown chunk kind" };
  if (typeof header.label !== "string" || !safeName(header.label, LABEL)) return { reason: "bad label" };
  if (typeof header.sessionId !== "string" || !SESSION.test(header.sessionId)) return { reason: "bad session id" };
  if (!Number.isSafeInteger(header.offset) || header.offset < 0) return { reason: "bad offset" };
  const parts = typeof header.file === "string" ? header.file.split("/") : [];
  const main = parts.length === 1 && parts[0] === `${header.sessionId}.jsonl`;
  const subagent = parts.length === 3 && parts[0] === header.sessionId && parts[1] === "subagents" && AGENT_FILE.test(parts[2]!);
  const workflow = parts.length === 5 && parts[0] === header.sessionId && parts[1] === "subagents" && parts[2] === "workflows"
    && safeName(parts[3]!, RUN) && AGENT_FILE.test(parts[4]!);
  if (!main && !subagent && !workflow) return { reason: "bad file path" };
  const path = join(root, header.label, ...parts);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || rel.split(sep)[0] !== header.label) return { reason: "path escapes the mirror" };
  return { path };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function applyChunkToMirror(root: string, header: HubChunkHeader, data: Uint8Array): MirrorOutcome {
  const target = mirrorPathForHeader(root, header);
  if ("reason" in target) return { outcome: "rejected", reason: target.reason };
  if (data.length === 0 || data[data.length - 1] !== 10) return { outcome: "rejected", reason: "chunk does not end at a line end" };
  const have = sizeOf(target.path);
  const end = header.offset + data.length;
  if (header.offset > have) return { outcome: "gap", path: target.path, have, offset: header.offset };
  if (end <= have) return { outcome: "duplicate", path: target.path };
  if (end > MAX_MIRROR_FILE_BYTES) return { outcome: "rejected", reason: "mirror file would pass its size limit" };
  mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 });
  const fresh = data.subarray(have - header.offset);
  const fd = openSync(target.path, "a", 0o600);
  try {
    let written = 0;
    while (written < fresh.length) written += writeSync(fd, fresh, written, fresh.length - written);
  } finally {
    closeSync(fd);
  }
  return { outcome: "appended", path: target.path, bytes: fresh.length };
}
