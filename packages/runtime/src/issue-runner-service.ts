import {
  deriveProjectedAgentRunId,
  isWorkItemTerminalState,
  type FlightRecord,
  type FlightState,
  type InvocationRequest,
  type MetadataMap,
  type ScoutId,
  type WorkItemRecord,
} from "@openscout/protocol";

import {
  deriveIssueRunnerStableId,
  isIssueClaimLeaseExpired,
  isIssueClaimTerminal,
  planIssueRunnerDispatches,
  type ExternalIssueSnapshot,
  type IssueBinding,
  type IssueClaim,
  type IssueDispatchPlan,
  type IssueRunnerIssueInput,
  type IssueRunnerProfile,
  type IssueWorkspace,
  type RunnerEligibilityPlan,
} from "./issue-runner.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import type { ControlRuntime } from "./service.js";

export const SCOUT_ISSUE_RUNNER_METADATA_KEY = "issueRunner";

const SCOUT_ISSUE_RUNNER_METADATA_VERSION = 1;
const ACTIVE_FLIGHT_STATES = new Set<FlightState>(["queued", "waking", "running", "waiting"]);

export interface ScoutIssueRunnerProfileState {
  source: "scout";
  profileId: ScoutId;
  profileRevision?: string;
  binding: IssueBinding;
  externalIssue: ExternalIssueSnapshot;
  claim: IssueClaim;
  workspace: IssueWorkspace;
  runner: {
    dispatchId: ScoutId;
    invocationId: ScoutId;
    flightId?: ScoutId;
    runId?: ScoutId;
    runnerId: ScoutId;
    leaseOwnerId: ScoutId;
    status: "claimed" | "invoked" | "failed";
    claimedAt: number;
    invokedAt?: number;
    fencing: {
      claimId: ScoutId;
      generation: number;
      bindingKey: string;
    };
  };
}

export interface ScoutIssueRunnerMetadata {
  version: typeof SCOUT_ISSUE_RUNNER_METADATA_VERSION;
  profiles: Record<ScoutId, ScoutIssueRunnerProfileState>;
}

export interface ScoutIssueRunnerDispatchWork {
  dispatch: IssueDispatchPlan;
  workItem: WorkItemRecord;
  claimedWorkItem: WorkItemRecord;
  invocation: InvocationRequest;
}

export interface ScoutIssueRunnerTickPlan {
  profileId: ScoutId;
  now: number;
  candidates: IssueRunnerIssueInput[];
  planner: RunnerEligibilityPlan;
  dispatches: ScoutIssueRunnerDispatchWork[];
}

export interface PlanScoutIssueRunnerTickInput {
  snapshot: RuntimeRegistrySnapshot;
  profile: IssueRunnerProfile;
  now?: number;
  runnerId?: ScoutId;
  leaseOwnerId?: ScoutId;
  requesterId?: ScoutId;
  requesterNodeId?: ScoutId;
  workspaceRoot?: string;
  maxDispatches?: number;
  ensureAwake?: boolean;
  stream?: boolean;
  timeoutMs?: number;
}

export interface ApplyScoutIssueRunnerDispatchesInput {
  runtime: Pick<ControlRuntime, "snapshot" | "upsertCollaboration" | "invokeAgent">;
  dispatches: readonly ScoutIssueRunnerDispatchWork[];
  now?: number;
}

export interface ScoutIssueRunnerAppliedDispatch {
  dispatch: IssueDispatchPlan;
  invocation: InvocationRequest;
  flight: FlightRecord;
  workItem: WorkItemRecord;
}

export interface ScoutIssueRunnerSkippedDispatch {
  dispatch: IssueDispatchPlan;
  reason:
    | "work_item_missing"
    | "work_item_terminal"
    | "active_claim"
    | "stale_generation"
    | "target_agent_missing"
    | "invoke_failed";
  workItem?: WorkItemRecord;
  claim?: IssueClaim;
  error?: string;
}

export interface ScoutIssueRunnerApplyResult {
  applied: ScoutIssueRunnerAppliedDispatch[];
  skipped: ScoutIssueRunnerSkippedDispatch[];
}

export interface RunScoutIssueRunnerTickInput extends Omit<PlanScoutIssueRunnerTickInput, "snapshot"> {
  runtime: Pick<ControlRuntime, "snapshot" | "upsertCollaboration" | "invokeAgent">;
}

export interface RunScoutIssueRunnerTickResult extends ScoutIssueRunnerTickPlan {
  apply: ScoutIssueRunnerApplyResult;
}

export function planScoutIssueRunnerTick(input: PlanScoutIssueRunnerTickInput): ScoutIssueRunnerTickPlan {
  const now = input.now ?? Date.now();
  const runnerId = input.runnerId ?? input.profile.agent.agentId;
  const leaseOwnerId = input.leaseOwnerId ?? runnerId;
  const candidates = collectScoutIssueRunnerCandidates({
    snapshot: input.snapshot,
    profile: input.profile,
    now,
  });
  const planner = planIssueRunnerDispatches({
    profile: input.profile,
    candidates,
    now,
    workspaceRoot: input.workspaceRoot,
    runnerId,
    leaseOwnerId,
    capacity: deriveIssueRunnerCapacity(input.snapshot, input.profile.id),
    maxDispatches: input.maxDispatches,
  });
  const requesterId = input.requesterId ?? leaseOwnerId;
  const requesterNodeId = input.requesterNodeId ?? defaultRequesterNodeId(input.snapshot, input.profile);

  return {
    profileId: input.profile.id,
    now,
    candidates,
    planner,
    dispatches: planner.dispatches.map((dispatch) => {
      const workItem = input.snapshot.collaborationRecords[dispatch.workItem.id];
      if (!workItem || workItem.kind !== "work_item") {
        throw new Error(`planned Scout issue dispatch references unknown work item: ${dispatch.workItem.id}`);
      }

      const invocation = buildInvocationRequest({
        dispatch,
        profile: input.profile,
        now,
        requesterId,
        requesterNodeId,
        ensureAwake: input.ensureAwake ?? true,
        stream: input.stream ?? true,
        timeoutMs: input.timeoutMs,
      });

      return {
        dispatch,
        workItem,
        claimedWorkItem: buildScoutIssueRunnerWorkItem({
          workItem,
          profile: input.profile,
          dispatch,
          invocation,
          now,
          status: "claimed",
        }),
        invocation,
      };
    }),
  };
}

export async function applyScoutIssueRunnerDispatches(
  input: ApplyScoutIssueRunnerDispatchesInput,
): Promise<ScoutIssueRunnerApplyResult> {
  const now = input.now ?? Date.now();
  const applied: ScoutIssueRunnerAppliedDispatch[] = [];
  const skipped: ScoutIssueRunnerSkippedDispatch[] = [];

  for (const work of input.dispatches) {
    const snapshot = input.runtime.snapshot();
    const current = snapshot.collaborationRecords[work.dispatch.workItem.id];
    if (!current || current.kind !== "work_item") {
      skipped.push({ dispatch: work.dispatch, reason: "work_item_missing" });
      continue;
    }
    if (isWorkItemTerminalState(current.state)) {
      skipped.push({ dispatch: work.dispatch, reason: "work_item_terminal", workItem: current });
      continue;
    }

    const existingClaim = readScoutIssueRunnerProfileState(current.metadata, work.dispatch.profileId)?.claim;
    const skipReason = skipReasonForExistingClaim(existingClaim, work.dispatch.claim, now);
    if (skipReason) {
      skipped.push({
        dispatch: work.dispatch,
        reason: skipReason,
        workItem: current,
        claim: existingClaim,
      });
      continue;
    }
    if (!snapshot.agents[work.invocation.targetAgentId]) {
      skipped.push({
        dispatch: work.dispatch,
        reason: "target_agent_missing",
        workItem: current,
        error: `unknown agent: ${work.invocation.targetAgentId}`,
      });
      continue;
    }

    const issueRunnerContext = metadataRecord(work.dispatch.invocation.context, "issueRunner");
    const claimedWorkItem = buildScoutIssueRunnerWorkItem({
      workItem: current,
      profileId: work.dispatch.profileId,
      profileRevision: typeof issueRunnerContext?.profileRevision === "string" ? issueRunnerContext.profileRevision : undefined,
      dispatch: work.dispatch,
      invocation: work.invocation,
      now,
      status: "claimed",
    });
    await input.runtime.upsertCollaboration(claimedWorkItem);

    let flight: FlightRecord;
    try {
      flight = await input.runtime.invokeAgent(work.invocation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latestWorkItem = input.runtime.snapshot().collaborationRecords[current.id] as WorkItemRecord | undefined;
      const failedWorkItem = buildScoutIssueRunnerWorkItem({
        workItem: latestWorkItem ?? claimedWorkItem,
        profileId: work.dispatch.profileId,
        profileRevision: typeof issueRunnerContext?.profileRevision === "string" ? issueRunnerContext.profileRevision : undefined,
        dispatch: work.dispatch,
        invocation: work.invocation,
        now,
        status: "failed",
        error: message,
      });
      await input.runtime.upsertCollaboration(failedWorkItem);
      const failedState = readScoutIssueRunnerProfileState(failedWorkItem.metadata, work.dispatch.profileId);
      skipped.push({
        dispatch: work.dispatch,
        reason: "invoke_failed",
        workItem: failedWorkItem,
        claim: failedState?.claim,
        error: message,
      });
      continue;
    }
    const invokedWorkItem = buildScoutIssueRunnerWorkItem({
      workItem: input.runtime.snapshot().collaborationRecords[current.id] as WorkItemRecord,
      profileId: work.dispatch.profileId,
      profileRevision: typeof issueRunnerContext?.profileRevision === "string" ? issueRunnerContext.profileRevision : undefined,
      dispatch: work.dispatch,
      invocation: work.invocation,
      flight,
      now,
      status: "invoked",
    });
    await input.runtime.upsertCollaboration(invokedWorkItem);

    applied.push({
      dispatch: work.dispatch,
      invocation: work.invocation,
      flight,
      workItem: invokedWorkItem,
    });
  }

  return { applied, skipped };
}

export async function runScoutIssueRunnerTick(
  input: RunScoutIssueRunnerTickInput,
): Promise<RunScoutIssueRunnerTickResult> {
  const plan = planScoutIssueRunnerTick({
    ...input,
    snapshot: input.runtime.snapshot(),
  });
  const apply = await applyScoutIssueRunnerDispatches({
    runtime: input.runtime,
    dispatches: plan.dispatches,
    now: plan.now,
  });

  return {
    ...plan,
    apply,
  };
}

export function buildScoutExternalIssueSnapshot(input: {
  workItem: WorkItemRecord;
  profile: Pick<IssueRunnerProfile, "tracker">;
  now: number;
}): ExternalIssueSnapshot {
  const { workItem, profile, now } = input;

  return {
    source: "scout",
    sourceInstanceId: profile.tracker.sourceInstanceId,
    externalId: workItem.id,
    identifier: workItem.id,
    title: workItem.title,
    description: workItem.summary ?? null,
    state: workItem.state,
    priority: scoutPriorityRank(workItem.priority),
    labels: workItem.labels ?? [],
    assignee: workItem.ownerId ? { id: workItem.ownerId, name: workItem.ownerId } : null,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
    version: workItem.updatedAt,
    lastSeenAt: now,
    metadata: {
      source: "scout",
      workItemId: workItem.id,
      acceptanceState: workItem.acceptanceState,
      ownerId: workItem.ownerId,
      nextMoveOwnerId: workItem.nextMoveOwnerId,
      conversationId: workItem.conversationId,
      parentId: workItem.parentId,
    },
  };
}

export function readScoutIssueRunnerProfileState(
  metadata: MetadataMap | undefined,
  profileId: ScoutId,
): ScoutIssueRunnerProfileState | undefined {
  const issueRunner = metadataRecord(metadata, SCOUT_ISSUE_RUNNER_METADATA_KEY);
  const profiles = metadataRecord(issueRunner, "profiles");
  const profileState = metadataRecord(profiles, profileId);
  if (profileState) {
    return profileState as unknown as ScoutIssueRunnerProfileState;
  }

  if (issueRunner && issueRunner.profileId === profileId) {
    return issueRunner as unknown as ScoutIssueRunnerProfileState;
  }

  return undefined;
}

function collectScoutIssueRunnerCandidates(input: {
  snapshot: RuntimeRegistrySnapshot;
  profile: IssueRunnerProfile;
  now: number;
}): IssueRunnerIssueInput[] {
  return Object.values(input.snapshot.collaborationRecords)
    .filter((record): record is WorkItemRecord => record.kind === "work_item")
    .map((workItem) => {
      const state = readScoutIssueRunnerProfileState(workItem.metadata, input.profile.id);
      const claim = readIssueClaim(state?.claim);
      return {
        externalIssue: buildScoutExternalIssueSnapshot({
          workItem,
          profile: input.profile,
          now: input.now,
        }),
        workItem,
        binding: readIssueBinding(state?.binding),
        claim,
        activeFlightStates: activeFlightStatesForWorkItem(input.snapshot, input.profile.id, workItem.id),
        nextRetryAt: claim?.nextRetryAt,
        metadata: {
          source: "scout",
          issueRunnerState: state,
        },
      };
    });
}

function buildInvocationRequest(input: {
  dispatch: IssueDispatchPlan;
  profile: IssueRunnerProfile;
  now: number;
  requesterId: ScoutId;
  requesterNodeId: ScoutId;
  ensureAwake: boolean;
  stream: boolean;
  timeoutMs?: number;
}): InvocationRequest {
  const invocationId = deriveIssueRunnerStableId(
    "issue-invocation",
    `${input.dispatch.claim.id}:${input.dispatch.claim.generation}`,
  );
  const issueRunnerContext = metadataRecord(input.dispatch.invocation.context, "issueRunner") ?? {};
  const metadata: MetadataMap = {
    ...input.dispatch.invocation.metadata,
    source: "external_issue",
    externalIssueSource: "scout",
    profileId: input.dispatch.profileId,
    profileRevision: input.profile.revision,
    bindingKey: input.dispatch.bindingKey,
    claimId: input.dispatch.claim.id,
    claimGeneration: input.dispatch.claim.generation,
    workspaceId: input.dispatch.workspace.id,
    workspacePath: input.dispatch.workspace.path,
    workId: input.dispatch.workItem.id,
    collaborationRecordId: input.dispatch.workItem.id,
    dispatchId: input.dispatch.id,
    idempotencyKey: input.dispatch.id,
  };

  return {
    origin: { source: "unknown" },
    id: invocationId,
    requesterId: input.requesterId,
    requesterNodeId: input.requesterNodeId,
    targetAgentId: input.dispatch.invocation.targetAgentId,
    action: input.dispatch.invocation.action,
    task: input.dispatch.invocation.task,
    collaborationRecordId: input.dispatch.invocation.collaborationRecordId,
    context: {
      ...input.dispatch.invocation.context,
      issueRunner: {
        ...issueRunnerContext,
        source: "scout",
        dispatchId: input.dispatch.id,
        invocationId,
      },
    },
    execution: input.dispatch.invocation.execution,
    ensureAwake: input.ensureAwake,
    stream: input.stream,
    timeoutMs: input.timeoutMs,
    createdAt: input.now,
    metadata,
  };
}

function buildScoutIssueRunnerWorkItem(input: {
  workItem: WorkItemRecord;
  profile?: IssueRunnerProfile;
  profileId?: ScoutId;
  profileRevision?: string;
  dispatch: IssueDispatchPlan;
  invocation: InvocationRequest;
  flight?: FlightRecord;
  now: number;
  status: "claimed" | "invoked" | "failed";
  error?: string;
}): WorkItemRecord {
  const profileId = input.profile?.id ?? input.profileId ?? input.dispatch.profileId;
  const profileRevision = input.profile?.revision ?? input.profileRevision;
  const existingIssueRunner = metadataRecord(input.workItem.metadata, SCOUT_ISSUE_RUNNER_METADATA_KEY);
  const existingProfiles = metadataRecord(existingIssueRunner, "profiles") ?? {};
  const runId = input.flight
    ? deriveProjectedAgentRunId({ invocationId: input.invocation.id, flightId: input.flight.id })
    : undefined;
  const claim = buildDurableClaim({
    dispatch: input.dispatch,
    invocation: input.invocation,
    flight: input.flight,
    runId,
    now: input.now,
    status: input.status,
    error: input.error,
  });
  const state: ScoutIssueRunnerProfileState = {
    source: "scout",
    profileId,
    profileRevision,
    binding: {
      ...input.dispatch.binding,
      latestIssue: input.dispatch.issue,
      updatedAt: input.now,
    },
    externalIssue: input.dispatch.issue,
    claim,
    workspace: {
      ...input.dispatch.workspace,
      lastUsedAt: input.now,
    },
    runner: {
      dispatchId: input.dispatch.id,
      invocationId: input.invocation.id,
      flightId: input.flight?.id,
      runId,
      runnerId: input.dispatch.runnerId,
      leaseOwnerId: claim.leaseOwnerId,
      status: input.status,
      claimedAt: input.now,
      invokedAt: input.status === "invoked" ? input.now : undefined,
      fencing: {
        claimId: claim.id,
        generation: claim.generation,
        bindingKey: claim.bindingKey,
      },
    },
  };
  const issueRunner: ScoutIssueRunnerMetadata = {
    ...(existingIssueRunner ?? {}),
    version: SCOUT_ISSUE_RUNNER_METADATA_VERSION,
    profiles: {
      ...existingProfiles,
      [profileId]: state,
    } as Record<ScoutId, ScoutIssueRunnerProfileState>,
  };

  return {
    ...input.workItem,
    updatedAt: Math.max(input.workItem.updatedAt, input.now),
    metadata: {
      ...(input.workItem.metadata ?? {}),
      [SCOUT_ISSUE_RUNNER_METADATA_KEY]: issueRunner,
    },
  };
}

function buildDurableClaim(input: {
  dispatch: IssueDispatchPlan;
  invocation: InvocationRequest;
  flight?: FlightRecord;
  runId?: ScoutId;
  now: number;
  status: "claimed" | "invoked" | "failed";
  error?: string;
}): IssueClaim {
  return {
    ...input.dispatch.claim,
    state: input.status === "invoked"
      ? "running"
      : input.status === "failed"
        ? "cancelled"
        : "claimed",
    updatedAt: input.now,
    heartbeatAt: input.now,
    flightId: input.flight?.id,
    runId: input.runId,
    nextRetryAt: input.status === "failed" ? nextIssueRunnerRetryAt(input.dispatch, input.now) : undefined,
    ...(input.error
      ? {
          lastError: {
            kind: "agent",
            message: input.error,
            retryable: true,
          },
        }
      : {}),
    metadata: {
      ...(input.dispatch.claim.metadata ?? {}),
      source: "scout",
      dispatchId: input.dispatch.id,
      invocationId: input.invocation.id,
      ...(input.error ? { invokeError: input.error } : {}),
      flightId: input.flight?.id,
      runId: input.runId,
      fencing: {
        claimId: input.dispatch.claim.id,
        generation: input.dispatch.claim.generation,
        bindingKey: input.dispatch.bindingKey,
        leaseOwnerId: input.dispatch.claim.leaseOwnerId,
        leaseExpiresAt: input.dispatch.claim.leaseExpiresAt,
      },
    },
  };
}

function nextIssueRunnerRetryAt(dispatch: IssueDispatchPlan, now: number): number {
  const retry = asRecord(dispatch.metadata.retry);
  const initialBackoffMs = metadataNumber(retry, "initialBackoffMs") ?? 60_000;
  const maxBackoffMs = metadataNumber(retry, "maxBackoffMs") ?? initialBackoffMs;
  const attemptIndex = Math.max(0, dispatch.claim.attempt - 1);
  const delay = Math.min(maxBackoffMs, initialBackoffMs * 2 ** attemptIndex);
  return now + delay;
}

function skipReasonForExistingClaim(
  existingClaim: IssueClaim | undefined,
  plannedClaim: IssueClaim,
  now: number,
): ScoutIssueRunnerSkippedDispatch["reason"] | undefined {
  if (!existingClaim || isIssueClaimTerminal(existingClaim)) {
    return undefined;
  }
  if (existingClaim.generation > plannedClaim.generation) {
    return "stale_generation";
  }
  if (existingClaim.generation === plannedClaim.generation) {
    return isIssueClaimLeaseExpired(existingClaim, now) ? "stale_generation" : "active_claim";
  }
  if (!isIssueClaimLeaseExpired(existingClaim, now)) {
    return "active_claim";
  }

  return undefined;
}

function activeFlightStatesForWorkItem(
  snapshot: RuntimeRegistrySnapshot,
  profileId: ScoutId,
  workItemId: ScoutId,
): FlightState[] {
  const states: FlightState[] = [];
  const latestFlights = latestFlightsByInvocation(snapshot);
  for (const invocation of Object.values(snapshot.invocations)) {
    if (invocation.collaborationRecordId !== workItemId) {
      continue;
    }
    if (invocation.metadata?.source !== "external_issue" || invocation.metadata?.profileId !== profileId) {
      continue;
    }
    const flight = latestFlights.get(invocation.id);
    if (flight && ACTIVE_FLIGHT_STATES.has(flight.state)) {
      states.push(flight.state);
    }
  }

  return states;
}

function deriveIssueRunnerCapacity(
  snapshot: RuntimeRegistrySnapshot,
  profileId: ScoutId,
): { activeRuns: number; activeRunsByState: Record<string, number> } {
  const latestFlights = latestFlightsByInvocation(snapshot);
  const activeRunsByState: Record<string, number> = {};
  let activeRuns = 0;

  for (const invocation of Object.values(snapshot.invocations)) {
    if (invocation.metadata?.source !== "external_issue" || invocation.metadata?.profileId !== profileId) {
      continue;
    }
    const flight = latestFlights.get(invocation.id);
    if (!flight || !ACTIVE_FLIGHT_STATES.has(flight.state)) {
      continue;
    }

    activeRuns += 1;
    const issueRunnerContext = metadataRecord(invocation.context, "issueRunner");
    const externalIssue = metadataRecord(issueRunnerContext, "externalIssue");
    const issueState = typeof externalIssue?.state === "string" ? externalIssue.state : undefined;
    if (issueState) {
      activeRunsByState[issueState] = (activeRunsByState[issueState] ?? 0) + 1;
    }
  }

  return { activeRuns, activeRunsByState };
}

function latestFlightsByInvocation(snapshot: RuntimeRegistrySnapshot): Map<ScoutId, FlightRecord> {
  const latest = new Map<ScoutId, FlightRecord>();
  for (const flight of Object.values(snapshot.flights)) {
    const current = latest.get(flight.invocationId);
    if (!current || flightTimestamp(flight) >= flightTimestamp(current)) {
      latest.set(flight.invocationId, flight);
    }
  }

  return latest;
}

function flightTimestamp(flight: FlightRecord): number {
  return flight.completedAt ?? flight.startedAt ?? 0;
}

function defaultRequesterNodeId(snapshot: RuntimeRegistrySnapshot, profile: IssueRunnerProfile): ScoutId {
  const targetAgent = snapshot.agents[profile.agent.agentId];
  if (targetAgent?.authorityNodeId) {
    return targetAgent.authorityNodeId;
  }

  return Object.keys(snapshot.nodes).sort()[0] ?? "local-node";
}

function scoutPriorityRank(priority: WorkItemRecord["priority"]): number | null {
  switch (priority) {
    case "urgent":
      return 0;
    case "high":
      return 1;
    case "normal":
      return 2;
    case "low":
      return 3;
    default:
      return null;
  }
}

function readIssueClaim(value: unknown): IssueClaim | null {
  const claim = asRecord(value);
  if (!claim) {
    return null;
  }
  if (
    typeof claim.id === "string"
    && typeof claim.profileId === "string"
    && typeof claim.bindingKey === "string"
    && typeof claim.workId === "string"
    && typeof claim.generation === "number"
    && typeof claim.leaseExpiresAt === "number"
    && typeof claim.attempt === "number"
  ) {
    return claim as unknown as IssueClaim;
  }

  return null;
}

function readIssueBinding(value: unknown): IssueBinding | undefined {
  const binding = asRecord(value);
  if (!binding) {
    return undefined;
  }
  if (
    typeof binding.id === "string"
    && typeof binding.key === "string"
    && typeof binding.profileId === "string"
    && typeof binding.workId === "string"
    && typeof binding.externalId === "string"
  ) {
    return binding as unknown as IssueBinding;
  }

  return undefined;
}

function metadataRecord(metadata: MetadataMap | undefined, key: string): MetadataMap | undefined {
  return asRecord(metadata?.[key]);
}

function metadataNumber(metadata: MetadataMap | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): MetadataMap | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as MetadataMap;
  }

  return undefined;
}
