import { z } from "zod";
import { SCOUT_ROUTINE_LIMITS } from "@openscout/protocol";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import { RoutineError, type RoutineRunner } from "./routine-runner.js";

const createSchema = z.object({
  title: z.string().min(1).max(120),
  code: z.string().min(1).max(SCOUT_ROUTINE_LIMITS.codeCharacters),
  dueAt: z.number().int().nonnegative().optional(),
  everyMs: z.number().int().min(SCOUT_ROUTINE_LIMITS.minEveryMs).optional(),
  ownerId: z.string().min(1).max(256).optional(),
  currentDirectory: z.string().min(1).max(4096).optional(),
}).strict();

export type RoutineHttpDeps = { runner?: RoutineRunner };

/**
 * `GET /v1/routines`, `POST /v1/routines` and `POST /v1/routines/:id/cancel`.
 * Local callers only: a routine runs code on this host.
 */
export async function handleRoutineRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, url: URL, deps: RoutineHttpDeps): Promise<boolean> {
  const method = request.method ?? "GET";
  const cancel = method === "POST" ? url.pathname.match(/^\/v1\/routines\/([^/]+)\/cancel$/) : null;
  const create = method === "POST" && url.pathname === "/v1/routines";
  const list = method === "GET" && url.pathname === "/v1/routines";
  if (!create && !list && !cancel) return false;
  try {
    const transport = request.transportContext;
    if (!transport || transport.transport === "remote" || transport.peer || transport.guest || transport.scoped) throw new RoutineError("routine_forbidden", 403);
    if (!list && request.headers.origin) throw new RoutineError("routine_forbidden", 403);
    const runner = deps.runner;
    if (!runner) throw new RoutineError("routines_unavailable", 503);
    if (list) {
      json(response, 200, { routines: runner.list() });
    } else if (create) {
      const parsed = createSchema.safeParse(await readRequestBody(request, { maxBytes: 32_768, requireJsonContentType: true }));
      if (!parsed.success) throw new RoutineError("invalid_routine_request");
      json(response, 201, { routine: await runner.create(parsed.data) });
    } else {
      json(response, 200, { routine: await runner.cancel(decodeURIComponent(cancel![1]!)) });
    }
  } catch (error) {
    const known = error instanceof RoutineError;
    json(response, known ? error.status : 400, { error: known ? error.message : "routine_failed" });
  }
  return true;
}
