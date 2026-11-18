import { z } from "zod";
import { POST_LIMITS, type AgentEndpoint, type ScoutPost } from "@openscout/protocol";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import { endpointStronglyMatchesSession } from "./broker-endpoint-selection.js";
import { BrokerShowStore, ShowError } from "./broker-show-store.js";
import { BrokerPostStore, PostError, postFromShow } from "./broker-post-store.js";

export const callerSchema = z.object({
  actorId: z.string().min(1).max(256),
  currentDirectory: z.string().min(1).max(4096),
  metadata: z.object({ sessionId: z.string().max(512).optional(), harness: z.string().max(64).optional() }).optional(),
}).strict();
export type PostCaller = z.infer<typeof callerSchema>;

export class CallerMismatchError extends Error {
  constructor(message: string, readonly detail: string) { super(message); }
}

/**
 * The session behind a caller. A harness passes its own native id
 * (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID); endpoints keep that id under
 * several keys, so match every key that proves the session. An id no endpoint
 * holds yet is kept as the caller gave it. Only an id that belongs to another
 * agent, or a harness that contradicts the matched endpoint, is refused.
 */
export function resolveCallerSession(snapshot: Pick<RuntimeSnapshot, "endpoints">, caller: PostCaller, prefix: "show" | "post"): { sessionId?: string; harness?: string; endpoint?: AgentEndpoint } {
  const sessionId = caller.metadata?.sessionId?.trim() || undefined;
  const harness = caller.metadata?.harness?.trim() || undefined;
  const all = Object.values(snapshot.endpoints);
  const own = all.filter(e => e.agentId === caller.actorId);
  let endpoint: AgentEndpoint | undefined;
  if (sessionId) {
    endpoint = own.find(e => endpointStronglyMatchesSession(e, sessionId));
    if (!endpoint) {
      const other = all.find(e => e.agentId !== caller.actorId && endpointStronglyMatchesSession(e, sessionId, harness as AgentEndpoint["harness"] | undefined));
      if (other) throw new CallerMismatchError(`${prefix}_session_mismatch_check_caller`, `session ${sessionId} belongs to ${other.agentId}, not ${caller.actorId}; check OPENSCOUT_AGENT`);
    }
  } else if (own.length === 1) endpoint = own[0];
  if (endpoint && harness && endpoint.harness !== harness) {
    throw new CallerMismatchError(`${prefix}_harness_mismatch_check_caller`, `${caller.actorId} runs in ${endpoint.harness}, but the caller says ${harness}`);
  }
  return { sessionId: sessionId ?? endpoint?.sessionId, harness: endpoint?.harness ?? harness, ...(endpoint ? { endpoint } : {}) };
}

const linkSchema = z.object({ url: z.string().min(1).max(POST_LIMITS.linkCharacters), title: z.string().max(POST_LIMITS.linkTitleCharacters).optional() }).strict();
const inputSchema = z.object({
  text: z.string().min(1).max(POST_LIMITS.textCharacters),
  file: z.string().min(1).max(4096).optional(),
  links: z.array(linkSchema).max(POST_LIMITS.links).optional(),
  milestone: z.boolean().optional(),
  caller: callerSchema,
}).strict();

export type PostAuthorNamer = (input: { agentId: string; harness?: string; sessionId?: string; endpoint?: AgentEndpoint }) => string | undefined;

export type PostHttpDeps = {
  store?: BrokerPostStore;
  shows?: BrokerShowStore;
  snapshot: () => Pick<RuntimeSnapshot, "agents" | "endpoints">;
  authorName?: PostAuthorNamer;
};

/** Posts and the shows no post carries, oldest first, newest `limit`. */
export async function listPosts(deps: PostHttpDeps, since: number, limit: number): Promise<ScoutPost[]> {
  // A carried show may predate `since`, so fold against every post.
  const all = await deps.store!.list(0);
  const carried = new Set(all.flatMap(post => post.file ? [post.file.showId] : []));
  const posts = all.filter(post => post.createdAt > since);
  const snapshot = deps.snapshot();
  const shows = deps.shows ? (await deps.shows.listAll(since)).filter(show => !carried.has(show.id)) : [];
  const fromShows = shows.map(show => postFromShow(show, deps.authorName?.({
    agentId: show.agentId, harness: show.harness, sessionId: show.sessionId,
    endpoint: Object.values(snapshot.endpoints).find(e => e.agentId === show.agentId && (!show.sessionId || endpointStronglyMatchesSession(e, show.sessionId))),
  })));
  return [...posts, ...fromShows].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-limit);
}

export async function handlePostRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, url: URL, deps: PostHttpDeps): Promise<boolean> {
  const method = request.method ?? "GET";
  const create = method === "POST" && url.pathname === "/v1/posts";
  const list = method === "GET" && url.pathname === "/v1/posts";
  if (!create && !list) return false;
  try {
    const transport = request.transportContext;
    if (!transport || transport.transport === "remote" || transport.peer || transport.guest || transport.scoped) throw new PostError("post_forbidden", 403);
    // A browser-origin write could otherwise attach a local file the page names.
    if (create && request.headers.origin) throw new PostError("post_forbidden", 403);
    const store = deps.store;
    if (!store) throw new PostError("posts_unavailable", 503);
    if (create) {
      const parsed = inputSchema.safeParse(await readRequestBody(request, { maxBytes: 32_768, requireJsonContentType: true }));
      if (!parsed.success) throw new PostError("invalid_post_request");
      const { caller, file, ...input } = parsed.data;
      const session = resolveCallerSession(deps.snapshot(), caller, "post");
      if (file && !deps.shows) throw new PostError("post_files_unavailable", 503);
      const show = file ? await deps.shows!.show({ path: file, caption: input.text, currentDirectory: caller.currentDirectory, agentId: caller.actorId, sessionId: session.sessionId, harness: session.harness }) : undefined;
      const name = deps.authorName?.({ agentId: caller.actorId, harness: session.harness, sessionId: session.sessionId, endpoint: session.endpoint });
      const post = await store.post({ ...input, currentDirectory: caller.currentDirectory, show, author: { agentId: caller.actorId, sessionId: session.sessionId, harness: session.harness, name } });
      json(response, 201, { post });
    } else {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new PostError("invalid_post_since");
      const limit = Number(url.searchParams.get("limit") ?? 200);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > POST_LIMITS.listLimit) throw new PostError("invalid_post_limit");
      json(response, 200, { posts: await listPosts(deps, since, limit) });
    }
  } catch (error) {
    if (error instanceof CallerMismatchError) { json(response, 409, { error: error.message, detail: error.detail }); return true; }
    const known = error instanceof PostError || error instanceof ShowError;
    json(response, known ? (error as PostError).status : 400, { error: known ? (error as Error).message : "post_failed" });
  }
  return true;
}
