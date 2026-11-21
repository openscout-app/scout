/**
 * GET /v1/feed/work: work items as a feed reads them (feed-work.ts).
 *
 *   ?since=<ms>               window: every item changed since then
 *   ?since=<ms>&until=<ms>    a slice of the window: changed before `until` too
 *   ?since=<ms>&mark=<ms>     changed: items changed since the mark, and those
 *                             whose conversation got a message since it
 *   &limit=<n>                at most n items, newest change first; default all
 *
 * Answers { tasks, gone }. Local callers only, like the post list: the
 * replies it carries are the operator's own conversations.
 */
import { FEED_WORK_LIMITS, type ScoutFeedWorkPage, type ScoutFeedWorkRead } from "@openscout/protocol";

import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json } from "./broker-http-helpers.js";

export type FeedWorkHttpDeps = {
  /** Unset when the runtime keeps no control-plane database. */
  read?: (read: ScoutFeedWorkRead) => ScoutFeedWorkPage;
};

class FeedWorkError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function time(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new FeedWorkError(`invalid_feed_work_${name}`);
  return value;
}

/** The read a query string names. Throws a FeedWorkError the route answers with 400. */
export function feedWorkRead(url: URL): ScoutFeedWorkRead {
  const since = time(url, "since") ?? 0;
  const mark = time(url, "mark");
  const until = time(url, "until");
  if (until !== undefined && mark !== undefined) throw new FeedWorkError("invalid_feed_work_until");
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? -1 : Number(rawLimit);
  if (rawLimit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > FEED_WORK_LIMITS.listLimit)) {
    throw new FeedWorkError("invalid_feed_work_limit");
  }
  if (mark !== undefined) return { mode: "changed", mark, since, limit };
  return until === undefined ? { mode: "window", since, limit } : { mode: "window", since, until, limit };
}

export function handleFeedWorkRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, url: URL, deps: FeedWorkHttpDeps): boolean {
  const method = request.method ?? "GET";
  if (!(method === "GET" && url.pathname === "/v1/feed/work")) return false;
  try {
    const transport = request.transportContext;
    if (!transport || transport.transport === "remote" || transport.peer || transport.guest || transport.scoped) throw new FeedWorkError("feed_work_forbidden", 403);
    if (!deps.read) throw new FeedWorkError("feed_work_unavailable", 503);
    json(response, 200, deps.read(feedWorkRead(url)));
  } catch (error) {
    if (error instanceof FeedWorkError) json(response, error.status, { error: error.message });
    else json(response, 500, { error: "feed_work_failed" });
  }
  return true;
}
