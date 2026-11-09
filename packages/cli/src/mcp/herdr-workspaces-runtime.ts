import * as z from "zod/v4";
import type { HerdrWorkspacesRead } from "@openscout/protocol";
import { resolveBrokerControlUrl } from "@openscout/runtime/local-config";

const availability = z.enum(["not_scanned", "available", "unavailable", "partial"]);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/u);
const session = z.string().min(1).max(128).refine(value => value === value.trim()
  && value !== "." && value !== ".." && !/[/\\\x00-\x1f\x7f]/u.test(value));
const text = z.string().max(4096);
const counts = z.object({ blocked: integer, working: integer, idle: integer, done: integer, unknown: integer }).strict();
const pane = z.object({
  target: id.nullable(), paneId: id, workspaceId: id, tabId: id,
  name: text.nullable().optional(), label: text.nullable(),
  agentSession: z.object({ agent: id, kind: id, source: id, value: text }).strict().nullable().optional(),
  agent: text.nullable(), status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
  directory: text.nullable(), focused: z.boolean(), backlog: integer.nullable(),
  gitBranch: text.nullable().optional(),
}).strict();
const digest = z.object({
  session, live: z.boolean(), observedAt: z.number().finite(), savedAt: z.number().finite().nullable(),
  unavailable: z.enum(["not_running", "unreadable"]).nullable(), availability,
  clients: integer.optional(), apps: z.array(text).max(256).optional(),
  totals: z.object({ workspaces: integer, tabs: integer, panes: integer, agents: integer }).strict(), counts,
  needsYou: z.array(pane).max(12), working: z.array(pane).max(12),
  groups: z.array(z.object({ directory: text.nullable(), name: text, counts,
    panes: z.array(pane).max(40), omitted: integer, omittedCounts: counts }).strict()).max(256),
  shapes: z.array(z.object({ workspaceId: id, workspaceLabel: text, tabId: id, tabLabel: text,
    paneCount: integer, arrangement: text, zoomed: z.boolean(), focused: z.boolean() }).strict()).max(64),
  truncated: z.boolean(), notes: z.array(text).max(128),
}).strict();
const schema = z.object({
  schema: z.literal("scout.herdr-workspaces/v1"), nodeId: id, scannedAt: z.number().finite().nullable(),
  availability, reason: z.enum(["not_scanned", "session_list_unavailable"]).nullable(),
  requestedSession: session.nullable(), count: integer.max(8), digests: z.array(digest).max(8), truncated: z.boolean(),
  coverage: z.object({ kind: z.literal("ttl_cached_probes"), scope: z.literal("this_host_only"),
    listedSessions: integer.nullable(), limits: z.object({
      sessions: z.literal(8), enumeratedSessions: z.literal(256), workspacesPerSession: z.literal(16),
      tabsPerSession: z.literal(64), inputPanesPerSession: z.literal(256), emittedPanesPerSession: z.literal(40),
      leadsPerSession: z.literal(12), concurrentSessions: z.literal(2),
    }).strict(),
  }).strict(),
}).strict();

export class HerdrWorkspacesReadError extends Error {
  constructor(readonly status: number | null, readonly code: string) {
    super(`Herdr workspaces unavailable: ${code}${status === null ? "" : ` (HTTP ${status})`}.`);
  }
}
const invalid = () => new HerdrWorkspacesReadError(null, "invalid_herdr_workspaces_response");

function validate(value: unknown, requestedSession: string | undefined): HerdrWorkspacesRead {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result = parsed.data;
  if (result.requestedSession !== (requestedSession ?? null) || result.count !== result.digests.length) throw invalid();
  const names = new Set<string>();
  for (const row of result.digests) {
    if (names.has(row.session) || requestedSession !== undefined && row.session !== requestedSession) throw invalid();
    names.add(row.session);
    const panes = row.groups.flatMap(group => group.panes);
    if (panes.length > 40 || new Set(panes.map(p => JSON.stringify([p.workspaceId, p.paneId]))).size !== panes.length
      || row.live && (row.savedAt !== null || row.unavailable !== null)
      // Clients are a live-read fact, and apps travel with the count.
      || (row.clients === undefined) !== (row.apps === undefined) || !row.live && row.clients !== undefined
      || !row.live && [...panes, ...row.needsYou, ...row.working].some(p => p.target !== null || p.status !== "unknown")) throw invalid();
  }
  if (result.availability === "not_scanned" && result.digests.length) throw invalid();
  if (result.availability === "available" && (result.reason !== null || result.scannedAt === null
    || result.digests.some(row => row.availability !== "available"))) throw invalid();
  return result;
}

/** Read the selected machine-local broker once. A selected socket never falls
 * back to HTTP. No web auth/bootstrap, local Herdr probe, app start or retry.
 * The broker owns its TTL-cached probes and reports their coverage explicitly. */
export async function readRuntimeHerdrWorkspaces(options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; session?: string;
} = {}): Promise<HerdrWorkspacesRead> {
  if (options.session !== undefined && !session.safeParse(options.session).success)
    throw new HerdrWorkspacesReadError(null, "invalid_herdr_session");
  const env = options.env ?? process.env;
  const configured = env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  // URL normalizes abbreviated/numeric IPv4 spellings. Require a literal
  // supported loopback authority before normalization, as the ingress promises.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/iu.test(configured))
    throw new HerdrWorkspacesReadError(null, "local_broker_required");
  let origin: URL;
  try { origin = new URL(configured); }
  catch { throw new HerdrWorkspacesReadError(null, "local_broker_required"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    throw new HerdrWorkspacesReadError(null, "local_broker_required");
  const socketPath = env.OPENSCOUT_BROKER_SOCKET_PATH?.trim();
  if (env.OPENSCOUT_BROKER_SOCKET_ONLY === "1" && !socketPath)
    throw new HerdrWorkspacesReadError(null, "broker_socket_required");
  const url = new URL("/v1/terminal-hosts/herdr/workspaces", origin);
  if (options.session !== undefined) url.searchParams.set("session", options.session);
  // One signal covers both response headers and body consumption.
  const signal = AbortSignal.timeout(8_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", signal,
      ...(socketPath ? { unix: socketPath } : {}),
    });
  } catch { throw new HerdrWorkspacesReadError(null, "herdr_workspaces_unavailable"); }
  const reader = response.body?.getReader();
  try {
    const maxBytes = 2 * 1024 * 1024;
    if (response.redirected || response.status >= 300 && response.status < 400
      || Number(response.headers.get("content-length")) > maxBytes) throw invalid();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxBytes) throw invalid(); chunks.push(chunk.value);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch {
      if (response.status !== 200) throw new HerdrWorkspacesReadError(response.status, "herdr_workspaces_unavailable");
      throw invalid();
    }
    if (response.status !== 200) {
      const error = z.object({ error: z.string().regex(/^[a-z_]{1,128}$/u) }).safeParse(payload);
      throw new HerdrWorkspacesReadError(response.status, error.success ? error.data.error : "herdr_workspaces_unavailable");
    }
    return validate(payload, options.session);
  } catch (error) {
    if (error instanceof HerdrWorkspacesReadError) throw error;
    throw invalid();
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
