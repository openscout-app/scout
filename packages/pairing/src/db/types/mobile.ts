/**
 * Types served to the iOS app via the bridge router.
 *
 * These shapes intentionally mirror what the mobile client expects so the
 * bridge can fulfil reads from SQLite without round-tripping the broker.
 */

import type { AgentSummaryState } from "../../shared/api/common.ts";

export type MobileAgentSummary = {
  id: string;
  title: string;
  selector: string | null;
  defaultSelector: string | null;
  workspaceRoot: string | null;
  harness: string | null;
  transport: string | null;
  state: AgentSummaryState;
  statusLabel: string;
  sessionId: string | null;
  /// The broker chat the phone should open for this agent. This is an existing
  /// opaque chat id, or null when no chat has been created yet.
  conversationId: string | null;
  lastActiveAt: number | null;
};

export type MobileSessionSummary = {
  id: string;
  kind: string;
  title: string;
  alias?: string | null;
  naturalKey?: string | null;
  participantIds: string[];
  agentId: string | null;
  agentName: string | null;
  harness: string | null;
  model: string | null;
  reasoningEffort: string | null;
  transport: string | null;
  sessionId: string | null;
  harnessSessionId: string | null;
  harnessLogPath: string | null;
  currentBranch: string | null;
  preview: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  workspaceRoot: string | null;
  /** Work item of the ask that started or last steered this session. */
  workItemId?: string | null;
  /** That work item's title. */
  workItemTitle?: string | null;
  /** First line of that ask's task, as plain text. */
  currentTask?: string | null;
};

export type MobileWorkspaceSummary = {
  id: string;
  title: string;
  projectName: string;
  root: string;
  sourceRoot: string;
  relativePath: string;
  registrationKind: string;
  defaultHarness: string;
  harnesses: Array<{
    harness: string;
    source: "manifest" | "marker" | "default" | "endpoint";
    detail: string;
    readinessState: "ready" | "configured" | "installed" | "missing" | null;
    readinessDetail: string | null;
  }>;
};

export type MobileAgentDetail = MobileAgentSummary & {
  cwd: string | null;
  wakePolicy: string | null;
  capabilities: string[];
  branch: string | null;
  role: string | null;
  model: string | null;
  activeFlights: Array<{
    id: string;
    state: string;
    summary: string | null;
    startedAt: number | null;
  }>;
  recentActivity: Array<{
    id: string;
    kind: string;
    ts: number;
    title: string | null;
    summary: string | null;
  }>;
  messageCount: number;
};
