import { z } from "zod";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import type { WorktreeRetirementService } from "./agent-workspace-retirement.js";

const sweepSchema = z.object({
  dryRun: z.boolean().optional(),
  projectRoots: z.array(z.string().min(1).max(4096)).max(64).optional(),
}).strict();

export type WorktreeRetirementHttpDeps = { service?: WorktreeRetirementService };

/**
 * `GET /v1/worktrees/retirement` (settings and the last sweep) and
 * `POST /v1/worktrees/retirement/sweep` (run one sweep now, or a dry run).
 * Local callers only: a sweep removes folders on this host.
 */
export async function handleWorktreeRetirementRoute(
  request: RuntimeHttpRequestLike,
  response: RuntimeHttpResponseLike,
  url: URL,
  deps: WorktreeRetirementHttpDeps,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const status = method === "GET" && url.pathname === "/v1/worktrees/retirement";
  const sweep = method === "POST" && url.pathname === "/v1/worktrees/retirement/sweep";
  if (!status && !sweep) return false;
  const transport = request.transportContext;
  if (!transport || transport.transport === "remote" || transport.peer || transport.guest || transport.scoped || (sweep && request.headers.origin)) {
    json(response, 403, { error: "worktree_retirement_forbidden" });
    return true;
  }
  const service = deps.service;
  if (!service) {
    json(response, 503, { error: "worktree_retirement_unavailable" });
    return true;
  }
  if (status) {
    json(response, 200, service.status());
    return true;
  }
  const parsed = sweepSchema.safeParse(await readRequestBody(request, { maxBytes: 65_536, requireJsonContentType: true }).catch(() => null));
  if (!parsed.success) {
    json(response, 400, { error: "invalid_worktree_retirement_request" });
    return true;
  }
  try {
    json(response, 200, await service.sweep({ trigger: "manual", dryRun: parsed.data.dryRun, projectRoots: parsed.data.projectRoots }));
  } catch (error) {
    json(response, 500, { error: "worktree_retirement_failed", detail: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
