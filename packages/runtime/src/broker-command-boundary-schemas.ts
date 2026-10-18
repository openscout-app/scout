import { z } from "zod";

import {
  AGENT_HARNESSES,
  SCOUT_PERMISSION_PROFILES,
  SCOUT_REASONING_EFFORTS,
  validateScoutRuntimeTuple,
  validateInvocationExecutionPreference,
  type InvocationRequest,
  type ScoutDeliverRequest,
  type ScoutOperatorSignal,
  type ScoutOwnedRuntimeCatalog,
  type ScoutRouteTarget,
} from "@openscout/protocol";

import type { BrokerRouteTargetInput } from "./scout-dispatcher.js";

const INVOCATION_ACTIONS = [
  "consult",
  "execute",
  "summarize",
  "status",
  "wake",
] as const;

const INVOCATION_SESSION_POLICIES = [
  "new",
  "reuse",
  "existing",
  "fork",
  "any",
] as const;

const ROUTE_AMBIGUOUS_POLICIES = ["reject", "ask"] as const;

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Required",
});

const optionalNonEmptyString = nonEmptyString.optional();

const trimmedNonEmptyString = nonEmptyString.transform((value) => value.trim());

const metadataMapSchema = z.record(z.string(), z.unknown());

const scoutRoutePolicySchema = z.object({
  preferLocalNodeId: optionalNonEmptyString,
  ambiguous: z.enum(ROUTE_AMBIGUOUS_POLICIES).optional(),
  allowHistoricalDirectId: z.boolean().optional(),
  allowStaleDirectId: z.boolean().optional(),
}).passthrough();

const routeTargetValueSchema = {
  value: optionalNonEmptyString,
};

const scoutRouteTargetSchema: z.ZodType<ScoutRouteTarget> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent_id"),
    agentId: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("agent_label"),
    label: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("existing_handle"),
    handle: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("runtime_profile"),
    profile: nonEmptyString,
    projectPath: nonEmptyString,
    reasoningEffort: z.enum(SCOUT_REASONING_EFFORTS).optional(),
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("route_alias"),
    alias: nonEmptyString,
    scope: z.object({
      projectKey: optionalNonEmptyString,
      projectRoot: optionalNonEmptyString,
      nodeId: optionalNonEmptyString,
    }).passthrough().optional(),
    bindingId: optionalNonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("target_handle"),
    handle: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("session_id"),
    sessionId: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("binding_ref"),
    ref: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("project_path"),
    projectPath: nonEmptyString,
    host: nonEmptyString.optional(),
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("channel"),
    channel: nonEmptyString,
    ...routeTargetValueSchema,
  }).passthrough(),
  z.object({
    kind: z.literal("broadcast"),
    ...routeTargetValueSchema,
  }).passthrough(),
]);

const invocationForkContextOptionsSchema = z.object({
  maxMessages: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
  includeBrokerRecords: z.boolean().optional(),
  includeObservedHarnessMaterial: z.boolean().optional(),
}).passthrough();

const invocationSessionLineageSchema = z.object({
  parentSessionId: optionalNonEmptyString,
  parentHarnessThreadId: optionalNonEmptyString,
  forkSourceKind: z.enum(["native_thread_clone", "scout_state_snapshot"]).optional(),
  forkSourceId: optionalNonEmptyString,
  forkedAt: z.number().int().nonnegative().optional(),
  metadata: metadataMapSchema.optional(),
}).passthrough();

const invocationExecutionPreferenceSchema = (runtimeCatalog?: ScoutOwnedRuntimeCatalog) => z.object({
  harness: z.enum(AGENT_HARNESSES).optional(),
  model: optionalNonEmptyString,
  reasoningEffort: z.enum(SCOUT_REASONING_EFFORTS).optional(),
  permissionProfile: z.enum(SCOUT_PERMISSION_PROFILES).optional(),
  placement: z.enum(["background", "foreground", "attached"]).optional(),
  session: z.enum(INVOCATION_SESSION_POLICIES).optional(),
  targetSessionId: optionalNonEmptyString,
  forkFromStateId: optionalNonEmptyString,
  forkFromSessionId: optionalNonEmptyString,
  forkContext: invocationForkContextOptionsSchema.optional(),
  lineage: invocationSessionLineageSchema.optional(),
  // Hard per-turn budget — a requester may wait far longer than any single
  // turn should run, so this is capped independently of timeoutMs.
  turnBudgetMs: z.number().int().positive().max(6 * 60 * 60_000).optional(),
}).passthrough().superRefine((execution, ctx) => {
  for (const message of validateInvocationExecutionPreference(execution)) {
    ctx.addIssue({ code: "custom", message });
  }
  // Tuple legality runs against the supplied owned catalog — the broker's live
  // snapshot on request paths — not a compiled-in harness/model list. Callers
  // without a live snapshot get the bundled default (see the parameter doc on
  // validateScoutRuntimeTuple).
  for (const issue of validateScoutRuntimeTuple(execution, undefined, runtimeCatalog)) {
    ctx.addIssue({
      code: "custom",
      path: [issue.dimension],
      message: issue.message,
    });
  }
});

export const brokerOperatorSignalSchema: z.ZodType<ScoutOperatorSignal> =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("notify"),
      blocking: z.literal(false),
      replyExpectation: z.literal("none"),
    }).strict(),
    z.object({
      kind: z.literal("consult"),
      blocking: z.literal(false),
      replyExpectation: z.literal("optional"),
      defaultAction: trimmedNonEmptyString,
    }).strict(),
    // `question` is trimmedNonEmptyString at the boundary, so a need with no
    // question is rejected by the broker as well as by the CLI. The empty
    // attention card that started this could not survive either gate.
    z.object({
      kind: z.literal("need"),
      blocking: z.literal(true),
      replyExpectation: z.literal("required"),
      question: trimmedNonEmptyString,
      requestKind: z.literal("permission").optional(),
      options: z.array(trimmedNonEmptyString).nonempty().optional(),
      blockedReason: trimmedNonEmptyString.optional(),
    }).strict(),
  ]);

export const brokerDeliverRequestSchema: z.ZodType<ScoutDeliverRequest> = z.object({
  body: trimmedNonEmptyString,
  // A previous broker rejects this new discriminant instead of ignoring the
  // option and silently starting ordinary consult execution.
  intent: z.enum(["tell", "consult", "session_input", "explicit_consult"]),
  completion: z.object({ mode: z.literal("explicit") }).strict().optional(),
  relation: z.object({ parentFlightId: nonEmptyString, kind: z.enum(["joined", "continuation"]) }).strict().optional(),
  operatorSignal: brokerOperatorSignalSchema.optional(),
  sessionDelivery: z.literal("in_place_or_resume").optional(),
}).passthrough().refine(
  payload => (payload.intent === "session_input") === (payload.sessionDelivery === "in_place_or_resume"),
  "session input requires its versioned wire intent and delivery option",
).refine(
  payload => (payload.intent === "explicit_consult") === Boolean(payload.completion || payload.relation),
  "completion contracts require explicit_consult wire intent",
).transform(payload => ({ ...payload, intent: payload.intent === "session_input" || payload.intent === "explicit_consult" ? "consult" as const : payload.intent }));

export function brokerInvocationRequestSchemaFor(
  runtimeCatalog?: ScoutOwnedRuntimeCatalog,
): z.ZodType<InvocationRequest & BrokerRouteTargetInput> {
  return z.object({
  id: nonEmptyString,
  requestId: nonEmptyString.max(256).optional(),
  requesterId: nonEmptyString,
  requesterNodeId: nonEmptyString,
  targetAgentId: nonEmptyString,
  targetNodeId: optionalNonEmptyString,
  action: z.enum(INVOCATION_ACTIONS),
  task: z.string().min(1),
  collaborationRecordId: optionalNonEmptyString,
  conversationId: optionalNonEmptyString,
  messageId: optionalNonEmptyString,
  context: metadataMapSchema.optional(),
  execution: invocationExecutionPreferenceSchema(runtimeCatalog).optional(),
  ensureAwake: z.boolean(),
  stream: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
  labels: z.array(nonEmptyString).optional(),
  createdAt: z.number().int().nonnegative(),
  metadata: metadataMapSchema.optional(),
  target: scoutRouteTargetSchema.nullish(),
  targetSessionId: nonEmptyString.nullish(),
  targetLabel: nonEmptyString.nullish(),
  routePolicy: scoutRoutePolicySchema.nullish(),
}).passthrough().refine(payload => payload.metadata?.completion === undefined
  && payload.metadata?.completionRelation === undefined && payload.metadata?.completionLocalNodeId === undefined,
  "completion contracts must enter through ask /v1/deliver");
}

/** Boundary schema validated against the bundled catalog; request paths that
 * can supply the broker's live snapshot should use
 * `brokerInvocationRequestSchemaFor` instead. */
export const brokerInvocationRequestSchema = brokerInvocationRequestSchemaFor();
