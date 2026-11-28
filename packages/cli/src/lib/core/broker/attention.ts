import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gitLogLastCommitUnix, gitRevParse, gitStatusPorcelain } from "@openscout/runtime/setup";

import type {
  AgentEndpoint,
  CollaborationRecord,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";
import { collaborationRequesterId, isCollaborationTerminalState } from "@openscout/protocol";

import {
  readScoutBrokerSnapshot,
  resolveScoutBrokerUrl,
  type ScoutBrokerSnapshot,
} from "./service.ts";

export type ScoutAttentionSeverity = "interrupt" | "badge" | "info";

export type ScoutAttentionEvidenceKind =
  | "git"
  | "work_item"
  | "question"
  | "flight"
  | "message";

export type ScoutAttentionEvidence = {
  kind: ScoutAttentionEvidenceKind;
  severity: ScoutAttentionSeverity;
  id: string | null;
  state: string | null;
  summary: string;
  at: number | null;
  agentId: string | null;
  invocationId: string | null;
  flightId: string | null;
  workId: string | null;
  messageId: string | null;
};

export type ScoutAttentionGitState = {
  projectRoot: string;
  isGitRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  hasChanges: boolean;
  lastCommitAt: number | null;
  shortStatus: string[];
  error: string | null;
};

export type ScoutAttentionProject = {
  projectRoot: string | null;
  projectName: string;
  status: "needs_attention" | "active";
  score: number;
  lastActivityAt: number | null;
  agents: string[];
  reasons: string[];
  nextAction: string;
  git: ScoutAttentionGitState | null;
  evidence: ScoutAttentionEvidence[];
};

export type ScoutAttentionReport = {
  generatedAt: number;
  since: number;
  brokerReachable: boolean;
  projects: ScoutAttentionProject[];
  counts: {
    projects: number;
    evidence: number;
    gitProjects: number;
    openCollaborationRecords: number;
    activeFlights: number;
    riskyTerminalFlights: number;
    riskyMessages: number;
  };
};

export type BuildScoutAttentionReportOptions = {
  since: number;
  now?: number;
  brokerReachable?: boolean;
  projectRoots?: string[];
  gitStates?: ScoutAttentionGitState[];
};

export type LoadScoutAttentionReportOptions = {
  since: number;
  now?: number;
  currentDirectory: string;
  projectRoots?: string[];
  includeGit?: boolean;
  brokerUrl?: string;
};

type ProjectAccumulator = ScoutAttentionProject & {
  reasonSet: Set<string>;
  agentSet: Set<string>;
};

const TERMINAL_FLIGHT_STATES = new Set(["completed", "failed", "cancelled"]);
const RISK_TEXT_PATTERN =
  /\b(blocked|blocking|stuck|failed|failure|error|cannot|can't|could not|couldn't|unable|not run|did not run|untested|needs review|waiting on|approval|permission|uncommitted|dirty)\b/i;

export async function loadScoutAttentionReport(
  options: LoadScoutAttentionReportOptions,
): Promise<ScoutAttentionReport> {
  const brokerUrl = options.brokerUrl ?? resolveScoutBrokerUrl();
  const snapshot = await readScoutBrokerSnapshot(brokerUrl);
  const brokerReachable = Boolean(snapshot);
  const baseSnapshot = snapshot ?? emptyScoutBrokerSnapshot();
  const currentGitRoot = options.includeGit === false
    ? null
    : await findGitRoot(options.currentDirectory);
  const preview = buildScoutAttentionReport(baseSnapshot, {
    since: options.since,
    now: options.now,
    brokerReachable,
    projectRoots: options.projectRoots,
  });

  const gitStates = options.includeGit === false
    ? []
    : await collectGitStates({
      roots: collectCandidateGitRoots(preview, currentGitRoot, options.projectRoots),
      projectRoots: options.projectRoots,
    });

  return buildScoutAttentionReport(baseSnapshot, {
    since: options.since,
    now: options.now,
    brokerReachable,
    projectRoots: options.projectRoots,
    gitStates,
  });
}

export function buildScoutAttentionReport(
  snapshot: ScoutBrokerSnapshot,
  options: BuildScoutAttentionReportOptions,
): ScoutAttentionReport {
  const now = options.now ?? Date.now();
  const projectFilters = normalizeProjectRoots(options.projectRoots ?? []);
  const projects = new Map<string, ProjectAccumulator>();
  const counts = {
    openCollaborationRecords: 0,
    activeFlights: 0,
    riskyTerminalFlights: 0,
    riskyMessages: 0,
  };

  for (const record of Object.values(snapshot.collaborationRecords ?? {})) {
    if (record.updatedAt < options.since) continue;
    if (isTerminalCollaborationRecord(record)) continue;
    const projectRoot = projectRootForCollaborationRecord(snapshot, record);
    if (!projectAllowed(projectRoot, projectFilters)) continue;
    const project = ensureProject(projects, projectRoot);
    const state = record.state;
    const severity = collaborationSeverity(record);
    counts.openCollaborationRecords += 1;
    addEvidence(project, {
      kind: record.kind,
      severity,
      id: record.id,
      state,
      summary: collaborationSummary(record),
      at: record.updatedAt,
      agentId: record.nextMoveOwnerId ?? record.ownerId ?? null,
      invocationId: null,
      flightId: null,
      workId: record.kind === "work_item" ? record.id : null,
      messageId: null,
    }, collaborationReason(record));
  }

  for (const flight of Object.values(snapshot.flights ?? {})) {
    const invocation = snapshot.invocations?.[flight.invocationId];
    const at = flightActivityAt(flight, invocation);
    if (at !== null && at < options.since) continue;
    if (isStaleReconciledFlight(flight)) continue;
    const projectRoot = projectRootForFlight(snapshot, flight, invocation);
    if (!projectAllowed(projectRoot, projectFilters)) continue;

    const terminal = TERMINAL_FLIGHT_STATES.has(flight.state);
    if (terminal && flightAttentionDismissed(flight, at)) continue;
    const riskText = [flight.error, flight.summary, flight.output, invocation?.task]
      .filter(Boolean)
      .join("\n");
    const riskyTerminal = terminal && flight.state !== "completed";
    const riskyCompleted = terminal && flight.state === "completed" && RISK_TEXT_PATTERN.test(riskText);
    if (terminal && !riskyTerminal && !riskyCompleted) continue;

    const project = ensureProject(projects, projectRoot);
    const severity = terminal
      ? (riskyTerminal ? "interrupt" : "badge")
      : (flight.state === "waiting" ? "interrupt" : "badge");
    if (terminal) {
      counts.riskyTerminalFlights += 1;
    } else {
      counts.activeFlights += 1;
    }
    addEvidence(project, {
      kind: "flight",
      severity,
      id: flight.id,
      state: flight.state,
      summary: flightSummary(flight, invocation),
      at,
      agentId: flight.targetAgentId,
      invocationId: flight.invocationId,
      flightId: flight.id,
      workId: workIdForInvocationOrFlight(invocation, flight),
      messageId: invocation?.messageId ?? null,
    }, terminal ? flightTerminalReason(flight) : "active flight");
  }

  for (const message of Object.values(snapshot.messages ?? {})) {
    if (message.createdAt < options.since) continue;
    if (!RISK_TEXT_PATTERN.test(message.body)) continue;
    if (messageFlightAttentionDismissed(snapshot, message)) continue;
    const projectRoot = projectRootForMessage(snapshot, message);
    if (!projectAllowed(projectRoot, projectFilters)) continue;
    const project = ensureProject(projects, projectRoot);
    counts.riskyMessages += 1;
    addEvidence(project, {
      kind: "message",
      severity: "info",
      id: message.id,
      state: null,
      summary: compactText(message.body, 160),
      at: message.createdAt,
      agentId: message.actorId,
      invocationId: metadataString(message.metadata, "invocationId") ?? null,
      flightId: metadataString(message.metadata, "flightId") ?? null,
      workId: metadataString(message.metadata, "workId")
        ?? metadataString(message.metadata, "collaborationRecordId")
        ?? null,
      messageId: message.id,
    }, "recent risky message");
  }

  for (const git of options.gitStates ?? []) {
    if (!git.isGitRepo) continue;
    if (!projectAllowed(git.projectRoot, projectFilters)) continue;
    if (!gitRequiresAttention(git, options.since)) continue;
    const project = ensureProject(projects, git.projectRoot);
    project.git = git;
    addEvidence(project, {
      kind: "git",
      severity: git.hasChanges ? "interrupt" : "badge",
      id: null,
      state: git.branch,
      summary: gitSummary(git),
      at: git.lastCommitAt,
      agentId: null,
      invocationId: null,
      flightId: null,
      workId: null,
      messageId: null,
    }, gitReason(git));
  }

  mergeAncestorProjectEvidence(projects);

  const projectList = [...projects.values()]
    .filter((project) => project.evidence.length > 0)
    .map(finalizeProject)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    });

  return {
    generatedAt: now,
    since: options.since,
    brokerReachable: options.brokerReachable ?? true,
    projects: projectList,
    counts: {
      projects: projectList.length,
      evidence: projectList.reduce((total, project) => total + project.evidence.length, 0),
      gitProjects: projectList.filter((project) => project.git).length,
      ...counts,
    },
  };
}

function mergeAncestorProjectEvidence(projects: Map<string, ProjectAccumulator>): void {
  const projectList = [...projects.values()]
    .filter((project) => project.projectRoot);
  for (const source of projectList) {
    if (!source.projectRoot || source.evidence.length === 0) continue;
    const target = projectList
      .filter((candidate) =>
        candidate.projectRoot
        && candidate.projectRoot !== source.projectRoot
        && isAncestorPath(source.projectRoot!, candidate.projectRoot)
        && sourceAgentsMatchProject(source, candidate.projectRoot)
      )
      .sort((left, right) => (right.projectRoot?.length ?? 0) - (left.projectRoot?.length ?? 0))[0];
    if (!target) continue;
    for (const evidence of source.evidence) {
      target.evidence.push(evidence);
      target.score += severityScore(evidence.severity);
      if (evidence.at !== null) {
        target.lastActivityAt = target.lastActivityAt === null
          ? evidence.at
          : Math.max(target.lastActivityAt, evidence.at);
      }
    }
    for (const reason of source.reasons) {
      if (!target.reasonSet.has(reason)) {
        target.reasonSet.add(reason);
        target.reasons.push(reason);
      }
    }
    for (const agent of source.agentSet) {
      target.agentSet.add(agent);
    }
    source.evidence = [];
    source.score = 0;
    source.reasons = [];
    source.reasonSet.clear();
    source.agentSet.clear();
  }
}

function sourceAgentsMatchProject(source: ProjectAccumulator, projectRoot: string): boolean {
  const name = normalizeName(basename(projectRoot));
  if (!name) return false;
  return [...source.agentSet].some((agentId) => {
    const value = normalizeName(agentId);
    return value === name
      || value.startsWith(`${name}-`)
      || value.startsWith(`${name}.`)
      || value.includes(`-${name}-`);
  });
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  const output = await gitRevParse({ repoRoot: cwd, kind: "showToplevel" });
  return output ? resolve(output) : null;
}

export async function readGitAttentionState(projectRoot: string): Promise<ScoutAttentionGitState> {
  const normalizedRoot = resolve(projectRoot);
  if (!existsSync(normalizedRoot)) {
    return emptyGitState(normalizedRoot, "path does not exist");
  }
  const inside = await gitRevParse({ repoRoot: normalizedRoot, kind: "isInsideWorkTree" });
  if (inside !== "true") {
    return emptyGitState(normalizedRoot, "not a git worktree");
  }

  const statusOutput = await gitStatusPorcelain({
    repoRoot: normalizedRoot,
    version: "v1",
    branch: true,
  });
  if (statusOutput === null) {
    return emptyGitState(normalizedRoot, "git status failed");
  }

  const lines = statusOutput.split("\n").filter((line) => line.length > 0);
  const branchLine = lines.find((line) => line.startsWith("## ")) ?? null;
  const statusLines = lines.filter((line) => !line.startsWith("## "));
  const branch = parseStatusBranch(branchLine);
  const upstream = parseStatusUpstream(branchLine);
  const ahead = parseStatusDistance(branchLine, "ahead");
  const behind = parseStatusDistance(branchLine, "behind");
  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;

  for (const line of statusLines) {
    if (line.startsWith("??")) {
      untrackedFiles += 1;
      continue;
    }
    if ((line[0] ?? " ") !== " ") {
      stagedFiles += 1;
    }
    if ((line[1] ?? " ") !== " ") {
      unstagedFiles += 1;
    }
  }

  const lastCommit = await gitLogLastCommitUnix(normalizedRoot);
  const lastCommitAt = lastCommit && /^\d+$/.test(lastCommit)
    ? Number.parseInt(lastCommit, 10) * 1000
    : null;

  return {
    projectRoot: normalizedRoot,
    isGitRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    changedFiles: statusLines.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    hasChanges: statusLines.length > 0,
    lastCommitAt,
    shortStatus: statusLines.slice(0, 20),
    error: null,
  };
}

function emptyScoutBrokerSnapshot(): ScoutBrokerSnapshot {
  return {
    nodes: {},
    actors: {},
    agents: {},
    endpoints: {},
    conversations: {},
    bindings: {},
    messages: {},
    readCursors: {},
    invocations: {},
    flights: {},
    collaborationRecords: {},
  };
}

function collectCandidateGitRoots(
  report: ScoutAttentionReport,
  currentGitRoot: string | null,
  requestedRoots: string[] | undefined,
): string[] {
  const roots = new Set<string>();
  for (const root of requestedRoots ?? []) {
    roots.add(resolve(root));
  }
  for (const project of report.projects) {
    if (project.projectRoot) roots.add(resolve(project.projectRoot));
  }
  if (currentGitRoot) {
    roots.add(resolve(currentGitRoot));
  }
  return [...roots];
}

async function collectGitStates(input: {
  roots: string[];
  projectRoots?: string[];
}): Promise<ScoutAttentionGitState[]> {
  const projectFilters = normalizeProjectRoots(input.projectRoots ?? []);
  return await Promise.all(input.roots
    .map((root) => resolve(root))
    .filter((root) => projectAllowed(root, projectFilters))
    .map(readGitAttentionState));
}

function normalizeProjectRoots(roots: string[]): Set<string> {
  return new Set(
    roots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root)),
  );
}

function projectAllowed(projectRoot: string | null, filters: Set<string>): boolean {
  if (filters.size === 0) return true;
  return Boolean(projectRoot && filters.has(resolve(projectRoot)));
}

function projectKey(projectRoot: string | null): string {
  return projectRoot ? resolve(projectRoot) : "unscoped";
}

function ensureProject(
  projects: Map<string, ProjectAccumulator>,
  projectRoot: string | null,
): ProjectAccumulator {
  const key = projectKey(projectRoot);
  const existing = projects.get(key);
  if (existing) return existing;
  const next: ProjectAccumulator = {
    projectRoot: projectRoot ? resolve(projectRoot) : null,
    projectName: projectRoot ? basename(resolve(projectRoot)) : "Unscoped Scout activity",
    status: "active",
    score: 0,
    lastActivityAt: null,
    agents: [],
    agentSet: new Set(),
    reasons: [],
    reasonSet: new Set(),
    nextAction: "Review the evidence and either close the loop or record the next owner.",
    git: null,
    evidence: [],
  };
  projects.set(key, next);
  return next;
}

function addEvidence(
  project: ProjectAccumulator,
  evidence: ScoutAttentionEvidence,
  reason: string,
): void {
  project.evidence.push(evidence);
  project.score += severityScore(evidence.severity);
  if (evidence.at !== null) {
    project.lastActivityAt = project.lastActivityAt === null
      ? evidence.at
      : Math.max(project.lastActivityAt, evidence.at);
  }
  if (evidence.agentId) {
    project.agentSet.add(evidence.agentId);
  }
  if (!project.reasonSet.has(reason)) {
    project.reasonSet.add(reason);
    project.reasons.push(reason);
  }
}

function finalizeProject(project: ProjectAccumulator): ScoutAttentionProject {
  const evidence = [...project.evidence].sort((left, right) => {
    const severityDelta = severityScore(right.severity) - severityScore(left.severity);
    if (severityDelta !== 0) return severityDelta;
    return (right.at ?? 0) - (left.at ?? 0);
  });
  const agents = [...project.agentSet].sort();
  return {
    projectRoot: project.projectRoot,
    projectName: project.projectName,
    status: evidence.some((item) => item.severity === "interrupt")
      ? "needs_attention"
      : "active",
    score: project.score,
    lastActivityAt: project.lastActivityAt,
    agents,
    reasons: project.reasons,
    nextAction: chooseNextAction({ ...project, evidence, agents }),
    git: project.git,
    evidence,
  };
}

function severityScore(severity: ScoutAttentionSeverity): number {
  switch (severity) {
    case "interrupt":
      return 50;
    case "badge":
      return 20;
    case "info":
      return 5;
  }
}

function isTerminalCollaborationRecord(record: CollaborationRecord): boolean {
  // Questions terminate on closed/declined; work items on done/cancelled. Blunt
  // work-state checks leave closed questions as permanent phantom attention items.
  return isCollaborationTerminalState(record);
}

function collaborationSeverity(record: CollaborationRecord): ScoutAttentionSeverity {
  if (record.kind === "work_item" && (record.state === "waiting" || record.state === "review")) {
    return "interrupt";
  }
  return "badge";
}

function collaborationReason(record: CollaborationRecord): string {
  if (record.kind === "question") {
    if (record.state === "answered") return "question answered";
    return "open question";
  }
  if (record.state === "waiting") return "work item waiting";
  if (record.state === "review") return "work item needs review";
  return "open work item";
}

function collaborationSummary(record: CollaborationRecord): string {
  const parts = [
    `${record.title} (${record.state})`,
    record.summary,
    record.kind === "work_item" && record.waitingOn
      ? `waiting on ${record.waitingOn.label}`
      : null,
    record.nextMoveOwnerId ? `next: ${record.nextMoveOwnerId}` : null,
  ];
  return compactText(parts.filter(Boolean).join("; "), 180);
}

function projectRootForCollaborationRecord(
  snapshot: ScoutBrokerSnapshot,
  record: CollaborationRecord,
): string | null {
  return metadataProjectRoot(record.metadata)
    ?? agentProjectRoot(snapshot, record.nextMoveOwnerId)
    ?? agentProjectRoot(snapshot, record.ownerId)
    // requestedById (work item) / askedById (question).
    ?? agentProjectRoot(snapshot, collaborationRequesterId(record))
    ?? agentProjectRoot(snapshot, record.createdById);
}

function projectRootForFlight(
  snapshot: ScoutBrokerSnapshot,
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
): string | null {
  return metadataProjectRoot(flight.metadata)
    ?? metadataProjectRoot(invocation?.metadata)
    ?? metadataProjectRoot(invocation?.context)
    ?? projectRootMentionedInText(snapshot, invocation?.task)
    ?? agentProjectRoot(snapshot, invocation?.targetAgentId)
    ?? agentProjectRoot(snapshot, flight.targetAgentId)
    ?? agentProjectRoot(snapshot, invocation?.requesterId)
    ?? agentProjectRoot(snapshot, flight.requesterId);
}

function projectRootForMessage(
  snapshot: ScoutBrokerSnapshot,
  message: MessageRecord,
): string | null {
  return metadataProjectRoot(message.metadata)
    ?? agentProjectRoot(snapshot, message.actorId)
    ?? projectRootMentionedInText(snapshot, message.body);
}

function metadataProjectRoot(metadata: Record<string, unknown> | undefined): string | null {
  return metadataString(metadata, "projectRoot")
    ?? metadataString(metadata, "workspaceRoot")
    ?? metadataString(metadata, "cwd")
    ?? null;
}

function agentProjectRoot(
  snapshot: ScoutBrokerSnapshot,
  agentId: string | null | undefined,
): string | null {
  if (!agentId) return null;
  const endpoint = preferredEndpointForAgent(snapshot, agentId);
  const explicitRoot = endpoint?.projectRoot ?? null;
  const metadataRoot = metadataProjectRoot(snapshot.agents?.[agentId]?.metadata)
    ?? metadataProjectRoot(snapshot.actors?.[agentId]?.metadata);
  const inferredRoot = inferProjectRootForAgentName(snapshot, agentId);
  if (explicitRoot && inferredRoot && isAncestorPath(explicitRoot, inferredRoot)) {
    return inferredRoot;
  }
  return explicitRoot
    ?? metadataRoot
    ?? inferredRoot
    ?? endpoint?.cwd
    ?? null;
}

function inferProjectRootForAgentName(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): string | null {
  const agent = snapshot.agents?.[agentId];
  const values = [
    agentId,
    agent?.definitionId,
    agent?.selector,
    agent?.defaultSelector,
    agent?.handle,
    agent?.displayName,
  ]
    .filter(Boolean)
    .map((value) => normalizeName(String(value)));
  if (values.length === 0) return null;

  return knownProjectRoots(snapshot)
    .sort((left, right) => basename(left).length - basename(right).length)
    .find((root) => {
      const name = normalizeName(basename(root));
      return Boolean(name && values.some((value) =>
        value === name
        || value.startsWith(`${name}-`)
        || value.startsWith(`${name}.`)
        || value.includes(`-${name}-`)
      ));
    }) ?? null;
}

function preferredEndpointForAgent(
  snapshot: ScoutBrokerSnapshot,
  agentId: string,
): AgentEndpoint | null {
  const endpoints = Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => endpoint.agentId === agentId);
  return endpoints.find((endpoint) => endpoint.state === "active")
    ?? endpoints.find((endpoint) => endpoint.state === "idle" || endpoint.state === "waiting")
    ?? endpoints[0]
    ?? null;
}

function flightActivityAt(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
): number | null {
  return flight.completedAt ?? flight.startedAt ?? invocation?.createdAt ?? null;
}

function workIdForInvocationOrFlight(
  invocation: InvocationRequest | undefined,
  flight: FlightRecord,
): string | null {
  return invocation?.collaborationRecordId
    ?? metadataString(flight.metadata, "workId")
    ?? metadataString(flight.metadata, "collaborationRecordId")
    ?? metadataString(invocation?.metadata, "workId")
    ?? metadataString(invocation?.metadata, "collaborationRecordId")
    ?? null;
}

function flightSummary(
  flight: FlightRecord,
  invocation: InvocationRequest | undefined,
): string {
  const source = flight.error ?? flight.summary ?? flight.output ?? invocation?.task ?? "";
  return compactText(`${flight.state}: ${source || flight.id}`, 180);
}

function flightTerminalReason(flight: FlightRecord): string {
  if (flight.state === "failed") return "recent failed flight";
  if (flight.state === "cancelled") return "recent cancelled flight";
  return "completed flight with follow-up risk";
}

function isStaleReconciledFlight(flight: FlightRecord): boolean {
  const text = [flight.error, flight.summary].filter(Boolean).join("\n");
  return /Stale running flight reconciled:|Didn't finish:/i.test(text);
}

function flightAttentionDismissed(flight: FlightRecord, at: number | null): boolean {
  const dismissedAt = metadataNumber(flight.metadata, "operatorAttentionDismissedAt");
  return dismissedAt !== null && (at === null || dismissedAt >= at);
}

function messageFlightAttentionDismissed(
  snapshot: ScoutBrokerSnapshot,
  message: MessageRecord,
): boolean {
  const flightId = metadataString(message.metadata, "flightId");
  if (!flightId) return false;
  const flight = snapshot.flights?.[flightId];
  if (!flight) return false;
  return flightAttentionDismissed(flight, flightActivityAt(flight, snapshot.invocations?.[flight.invocationId]));
}

function projectRootMentionedInText(
  snapshot: ScoutBrokerSnapshot,
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const roots = knownProjectRoots(snapshot)
    .sort((left, right) => right.length - left.length);
  return roots.find((root) => text.includes(root)) ?? null;
}

function knownProjectRoots(snapshot: ScoutBrokerSnapshot): string[] {
  const roots = new Set<string>();
  for (const endpoint of Object.values(snapshot.endpoints ?? {})) {
    const root = endpoint.projectRoot ?? endpoint.cwd;
    if (root) roots.add(resolve(root));
  }
  for (const agent of Object.values(snapshot.agents ?? {})) {
    const root = metadataProjectRoot(agent.metadata);
    if (root) roots.add(resolve(root));
  }
  for (const actor of Object.values(snapshot.actors ?? {})) {
    const root = metadataProjectRoot(actor.metadata);
    if (root) roots.add(resolve(root));
  }
  return [...roots];
}

function gitRequiresAttention(git: ScoutAttentionGitState, since: number): boolean {
  if (git.hasChanges || git.ahead > 0) return true;
  return Boolean(git.lastCommitAt && git.lastCommitAt >= since && git.behind === 0 && git.error);
}

function gitReason(git: ScoutAttentionGitState): string {
  if (git.hasChanges) return "dirty git worktree";
  if (git.ahead > 0) return "branch ahead of upstream";
  return "git needs review";
}

function gitSummary(git: ScoutAttentionGitState): string {
  const parts = [
    git.branch ? `branch ${git.branch}` : "branch unknown",
    git.changedFiles > 0 ? `${git.changedFiles} changed files` : null,
    git.stagedFiles > 0 ? `${git.stagedFiles} staged` : null,
    git.unstagedFiles > 0 ? `${git.unstagedFiles} unstaged` : null,
    git.untrackedFiles > 0 ? `${git.untrackedFiles} untracked` : null,
    git.ahead > 0 ? `ahead ${git.ahead}` : null,
    git.behind > 0 ? `behind ${git.behind}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function chooseNextAction(project: ScoutAttentionProject): string {
  const firstFailedFlight = project.evidence.find(
    (item) => item.kind === "flight" && (item.state === "failed" || item.state === "cancelled"),
  );
  if (firstFailedFlight?.flightId) {
    return `Inspect the failed flight with scout flight get ${firstFailedFlight.flightId}.`;
  }
  const waitingWork = project.evidence.find(
    (item) => item.kind === "work_item" && item.state === "waiting",
  );
  if (waitingWork?.workId) {
    return `Resolve or reassign the waiting work item ${waitingWork.workId}.`;
  }
  const reviewWork = project.evidence.find(
    (item) => item.kind === "work_item" && item.state === "review",
  );
  if (reviewWork?.workId) {
    return `Review and accept or reopen work item ${reviewWork.workId}.`;
  }
  const activeFlight = project.evidence.find(
    (item) => item.kind === "flight" && item.invocationId && !TERMINAL_FLIGHT_STATES.has(item.state ?? ""),
  );
  if (activeFlight?.invocationId) {
    return `Check progress with scout wait ${activeFlight.invocationId} --timeout 600.`;
  }
  if (project.git?.hasChanges || (project.git?.ahead ?? 0) > 0) {
    return "Review git status and diff, then commit, push, or leave an explicit handoff.";
  }
  return "Read the evidence and record the next owner or close the loop.";
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function metadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9._-]+/g, "-");
}

function isAncestorPath(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild !== normalizedParent
    && normalizedChild.startsWith(`${normalizedParent}/`);
}

function emptyGitState(projectRoot: string, error: string): ScoutAttentionGitState {
  return {
    projectRoot,
    isGitRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    stagedFiles: 0,
    unstagedFiles: 0,
    untrackedFiles: 0,
    hasChanges: false,
    lastCommitAt: null,
    shortStatus: [],
    error,
  };
}

function parseStatusBranch(branchLine: string | null): string | null {
  if (!branchLine) return null;
  const head = branchLine.slice(3).split(" ")[0] ?? "";
  const branch = head.split("...")[0] ?? "";
  if (!branch || branch.startsWith("HEAD")) return null;
  return branch;
}

function parseStatusUpstream(branchLine: string | null): string | null {
  if (!branchLine) return null;
  const head = branchLine.slice(3).split(" ")[0] ?? "";
  const upstream = head.includes("...") ? head.split("...")[1] : null;
  return upstream && !upstream.startsWith("[") ? upstream : null;
}

function parseStatusDistance(branchLine: string | null, kind: "ahead" | "behind"): number {
  if (!branchLine) return 0;
  const match = branchLine.match(new RegExp(`${kind} (\\d+)`));
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}
