import type { QuarantineEvidence, QuarantineListOptions, QuarantineMetadata, QuarantineSummary, QuarantineRetryResult } from "./broker-quarantine.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

type MaybePromise<T> = T | Promise<T>;
export type BrokerQuarantineQueries = {
  status: () => MaybePromise<QuarantineSummary>;
  list: (options: QuarantineListOptions) => MaybePromise<QuarantineMetadata[]>;
  read: (id: string) => MaybePromise<QuarantineEvidence | null>;
  acknowledge: (id: string) => MaybePromise<QuarantineMetadata | null>;
  defer?: (id: string) => MaybePromise<QuarantineMetadata | null>;
  retry?: (id: string) => MaybePromise<QuarantineRetryResult | null>;
};

/** Acknowledgement hides a warning. It never deletes evidence or retries work. */
export async function handleBrokerQuarantineRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike,
  url: URL, queries: BrokerQuarantineQueries | undefined,
  json: (response: RuntimeHttpResponseLike, status: number, value: unknown) => void): Promise<boolean> {
  if (url.pathname !== "/v1/quarantine" && !url.pathname.startsWith("/v1/quarantine/")) return false;
  if (request.transportContext?.transport === "remote") {
    json(response, 403, { error: "forbidden", detail: "Quarantine evidence is machine-local." }); return true;
  }
  const method = request.method ?? "GET";
  const exact = method === "GET" ? url.pathname.match(/^\/v1\/quarantine\/([^/]+)$/) : null;
  const acknowledge = method === "POST" ? url.pathname.match(/^\/v1\/quarantine\/([^/]+)\/acknowledge$/) : null;
  const deferred = method === "POST" ? url.pathname.match(/^\/v1\/quarantine\/([^/]+)\/defer$/) : null;
  const retried = method === "POST" ? url.pathname.match(/^\/v1\/quarantine\/([^/]+)\/retry$/) : null;
  const decision = deferred ?? retried;
  const list = method === "GET" && url.pathname === "/v1/quarantine";
  if (!list && !exact && !acknowledge && !decision) {
    // Preserve the namespace's previous 404/405 precedence, including when
    // queries are unavailable. Successful dispatch uses explicit method/path pairs.
    const known = url.pathname === "/v1/quarantine" || /^\/v1\/quarantine\/([^/]+)(\/(acknowledge|defer|retry))?$/.test(url.pathname);
    json(response, known ? 405 : 404, { error: known ? "method_not_allowed" : "quarantine_route_not_found" }); return true;
  }
  if (!queries) { json(response, 503, { error: "quarantine_unavailable" }); return true; }
  try {
    if (list) {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const status = url.searchParams.get("status") ?? "open";
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !["open", "acknowledged", "deferred", "resolved"].includes(status)
        || (sessionId !== undefined && (!sessionId.trim() || sessionId.length > 4096))) {
        json(response, 400, { error: "invalid_quarantine_query" }); return true;
      }
      const records = await queries.list({ limit, status: status as QuarantineListOptions["status"], ...(sessionId ? { sessionId } : {}) });
      json(response, 200, { status: await queries.status(), records });
    } else {
      const id = decodeURIComponent((exact ?? acknowledge ?? decision)![1]!);
      if (!/^quarantine-[a-f0-9]{64}$/.test(id)) { json(response, 400, { error: "invalid_quarantine_identity" }); return true; }
      if (decision) {
        const operation = Boolean(retried) ? queries.retry : queries.defer;
        if (!operation) { json(response, 503, { error: "quarantine_operation_unavailable" }); return true; }
        const result = await operation(id);
        if (!result) { json(response, 404, { error: "quarantine_record_not_found" }); return true; }
        const retry = Boolean(retried);
        json(response, retry && "outcome" in result && result.outcome === "failed" ? 409 : 200,
          retry ? result : { record: result });
        return true;
      }
      const record = acknowledge ? await queries.acknowledge(id) : await queries.read(id);
      json(response, record ? 200 : 404, record ? { record } : { error: "quarantine_record_not_found" });
    }
  } catch (error) {
    json(response, error instanceof URIError ? 400 : 503, {
      error: error instanceof URIError ? "invalid_quarantine_identity" : "quarantine_unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
