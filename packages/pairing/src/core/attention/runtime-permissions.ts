import { shapeAttentionContext, type AttentionContext } from "@openscout/agent-sessions";
/**
 * Permission requests the runtime holds (question records carrying
 * `metadata.permissionRequest`): native Claude Code hooks and managed
 * tmux/Codex sessions. They push to the phone with the request id as the
 * push item id; this lists them in the phone's inbox and answers them through
 * the runtime's decide route, as the web app does.
 *
 * Approve is always the narrowest grant the session offers (allow once). The
 * runtime revalidates the prompt before it sends anything, so a stale tap is
 * refused there, not here.
 */

import { basename } from "node:path";

import type { CollaborationRecord } from "@openscout/protocol";
import { nativeActorName } from "@openscout/protocol";
import { ScoutBrokerHttpError, type NativePermissionDisplay } from "@openscout/runtime";

import {
  decideScoutPermission,
  loadScoutBrokerContext,
  type ScoutBrokerSnapshot,
} from "../broker/service.ts";
import type { MobileInboxItem } from "../pairing/runtime/bridge/router.ts";

export type MobilePermissionDecision = "approve" | "deny";

export type MobilePermissionDecideResult =
  | { ok: true }
  | { ok: false; code: "refused" | "unconfirmed" | "ended" | "unreachable"; message: string };

type RuntimeBroker = { baseUrl: string; snapshot: ScoutBrokerSnapshot };

export type RuntimePermissionDeps = {
  /** The runtime's snapshot. Null when it cannot be reached. */
  loadBroker?: () => Promise<RuntimeBroker | null>;
};

const READ_TIMEOUT_MS = 2_000;

const MESSAGES = {
  refused: "It was answered elsewhere or changed. Refresh and look again.",
  unconfirmed: "The decision may not have reached the session. Check it there.",
  ended: "The session isn't waiting on this anymore.",
  unreachable: "Couldn't reach the runtime.",
} as const;

function defaultLoadBroker(): Promise<RuntimeBroker | null> {
  return loadScoutBrokerContext(undefined, {
    scope: "conversations",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

async function readBroker(deps: RuntimePermissionDeps): Promise<RuntimeBroker | null> {
  return (deps.loadBroker ?? defaultLoadBroker)().catch(() => null);
}

type OpenPermission = {
  record: CollaborationRecord;
  version: string;
  sessionId: string | null;
  projectRoot: string | null;
  invocationId: string | null;
  decisions: string[];
  native: { harness: string | null; display: NativePermissionDisplay | undefined; context: AttentionContext | null } | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The runtime's display as stored on the record; malformed parts are dropped. */
export function parsePermissionDisplay(value: unknown): NativePermissionDisplay | undefined {
  const raw = object(value);
  const action = text(raw?.action);
  if (!raw || !action) return undefined;
  const display: NativePermissionDisplay = { action };
  const command = text(raw.command);
  const target = text(raw.target);
  const note = text(raw.note);
  if (command) display.command = command;
  if (target) display.target = target;
  if (note) display.note = note;
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).flatMap((entry) => {
    const q = object(entry);
    const question = text(q?.question);
    if (!q || !question) return [];
    const header = text(q.header);
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((entry) => {
      const option = object(entry);
      const label = text(option?.label);
      const description = text(option?.description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    });
    return [{ ...(header ? { header } : {}), question, options }];
  });
  if (questions.length) display.questions = questions;
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).flatMap((entry) => {
    const field = object(entry);
    const key = text(field?.key);
    const fieldValue = text(field?.value);
    return key && fieldValue ? [{ key, value: fieldValue }] : [];
  });
  if (fields.length) display.fields = fields;
  return display;
}

function parseContext(value: unknown): AttentionContext | null {
  const raw = object(value);
  if (!raw || typeof raw.text !== "string" || !["assistant", "prompt", "task"].includes(String(raw.source))) return null;
  return shapeAttentionContext(raw.text, raw.source as AttentionContext["source"], typeof raw.at === "number" ? raw.at : null);
}

function openPermission(record: CollaborationRecord): OpenPermission | null {
  if (record.kind !== "question" || record.state !== "open") return null;
  const raw = object(record.metadata?.permissionRequest);
  const version = text(raw?.version);
  if (!raw || !version) return null;
  const native = object(raw.native);
  return {
    record,
    version,
    sessionId: text(raw.sessionId) ?? null,
    projectRoot: text(raw.projectRoot) ?? null,
    invocationId: text(raw.invocationId) ?? null,
    decisions: Array.isArray(raw.decisions) ? raw.decisions.filter((d): d is string => typeof d === "string") : [],
    native: native ? { harness: text(native.harness) ?? null, display: parsePermissionDisplay(native.display), context: parseContext(native.context) } : null,
  };
}

function agentName(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  return nativeActorName(actorId)
    ?? text(snapshot.agents?.[actorId]?.displayName)
    ?? text(snapshot.actors?.[actorId]?.displayName)
    ?? "Agent";
}

function harnessFor(snapshot: ScoutBrokerSnapshot, permission: OpenPermission): string | null {
  if (permission.native?.harness) return permission.native.harness;
  const actorId = permission.record.createdById;
  const nativeHarness = /^native:([^:]+):/u.exec(actorId)?.[1];
  if (nativeHarness) return nativeHarness;
  const endpoint = Object.values(snapshot.endpoints ?? {}).find((candidate) => candidate.agentId === actorId);
  if (endpoint?.harness) return endpoint.harness;
  const invocation = snapshot.invocations?.[permission.invocationId ?? ""];
  return invocation?.executionResolution?.harness.observed ?? invocation?.executionResolution?.harness.resolved ?? invocation?.execution?.harness ?? null;
}

function mobileDecisions(decisions: string[]): MobilePermissionDecision[] {
  return [
    ...(decisions.includes("once") ? ["approve" as const] : []),
    ...(decisions.includes("deny") ? ["deny" as const] : []),
  ];
}

function permissionInboxItem(snapshot: ScoutBrokerSnapshot, permission: OpenPermission): MobileInboxItem {
  const { record } = permission;
  const display = permission.native?.display;
  return {
    id: record.id,
    kind: "permission",
    createdAt: record.createdAt,
    sessionId: permission.sessionId ?? record.conversationId ?? "",
    conversationId: record.conversationId ?? null,
    harness: permission.sessionId ? harnessFor(snapshot, permission) : null,
    context: permission.native?.context ?? shapeAttentionContext(
      snapshot.invocations?.[permission.invocationId ?? ""]?.task, "task",
    ),
    sessionName: agentName(snapshot, record.createdById),
    adapterType: harnessFor(snapshot, permission) ?? (permission.native ? "native" : "tmux"),
    turnId: null,
    blockId: null,
    version: null,
    risk: "medium",
    title: display?.action ?? "Permission request",
    description: text(record.summary) ?? display?.action ?? "Permission request",
    detail: permission.projectRoot ? basename(permission.projectRoot) || null : null,
    permission: {
      ...(display ? { display } : {}),
      decisions: mobileDecisions(permission.decisions),
    },
  };
}

/**
 * One item per open permission request. Best-effort: an unreachable runtime
 * adds nothing rather than failing the rest of the inbox.
 */
export async function queryPermissionInboxItems(deps: RuntimePermissionDeps = {}): Promise<MobileInboxItem[]> {
  const broker = await readBroker(deps);
  if (!broker) return [];
  const { snapshot } = broker;
  return Object.values(snapshot.collaborationRecords ?? {})
    .map(openPermission)
    .filter((permission): permission is OpenPermission => permission !== null)
    .map((permission) => permissionInboxItem(snapshot, permission))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

function failure(code: keyof typeof MESSAGES): MobilePermissionDecideResult {
  return { ok: false, code, message: MESSAGES[code] };
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOENT",
  "EACCES",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/**
 * How a decide call failed. A response the runtime sent says what happened;
 * a connection that never opened means nothing was sent. Anything else (a
 * timeout, a dropped connection) may have reached the session.
 */
function decideFailure(error: unknown): MobilePermissionDecideResult {
  const status = error instanceof ScoutBrokerHttpError
    ? error.status
    : typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;
  if (status === 410) return failure("ended");
  if (status === 502) return failure("unconfirmed");
  if (status !== null) return failure(status >= 500 ? "unconfirmed" : "refused");
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return failure("unreachable");
  return failure("unconfirmed");
}

/**
 * The operator's decision on a runtime permission request. Approve sends
 * allow-once; deny sends deny. Expected refusals are values, not errors.
 */
export async function decideMobilePermission(
  input: { requestId: string; decision: MobilePermissionDecision },
  deps: RuntimePermissionDeps & { decide?: typeof decideScoutPermission } = {},
): Promise<MobilePermissionDecideResult> {
  const broker = await readBroker(deps);
  if (!broker) return failure("unreachable");
  const record = broker.snapshot.collaborationRecords?.[input.requestId];
  const permission = record ? openPermission(record) : null;
  if (!permission) return failure("ended");
  const decision = input.decision === "approve" ? "once" : "deny";
  try {
    await (deps.decide ?? decideScoutPermission)({
      requestId: input.requestId,
      version: permission.version,
      decision,
      baseUrl: broker.baseUrl,
    });
    return { ok: true };
  } catch (error) {
    return decideFailure(error);
  }
}
