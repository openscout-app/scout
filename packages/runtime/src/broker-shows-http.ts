import { open, realpath } from "node:fs/promises";
import { z } from "zod";
import { SHOW_LIMITS } from "@openscout/protocol";
import type { RuntimeSnapshot } from "./scout-dispatcher.js";
import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";
import { json, readRequestBody } from "./broker-http-helpers.js";
import { BrokerShowStore, ShowError } from "./broker-show-store.js";

const inputSchema = z.object({
  path: z.string().min(1).max(4096), caption: z.string().max(SHOW_LIMITS.captionCharacters).optional(),
  caller: z.object({ actorId: z.string().min(1).max(256), currentDirectory: z.string().min(1).max(4096), metadata: z.object({ sessionId: z.string().max(512).optional(), harness: z.string().max(64).optional() }).optional() }).strict(),
}).strict();
export function showByteRange(value: string | undefined, size: number): [number, number] | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new ShowError("show_range_unsatisfiable", 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new ShowError("show_range_unsatisfiable", 416);
  return [start, end];
}
export type ShowHttpDeps = { store?: BrokerShowStore; snapshot: () => Pick<RuntimeSnapshot, "agents" | "endpoints"> };
let streams = 0;
export async function handleShowRoute(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike, url: URL, deps: ShowHttpDeps): Promise<boolean> {
  const method = request.method ?? "GET";
  const create = method === "POST" && url.pathname === "/v1/shows";
  const list = method === "GET" && url.pathname === "/v1/shows";
  const capability = method === "GET" && url.pathname === "/v1/shows/capability";
  const events = method === "GET" && url.pathname === "/v1/shows/events";
  const bytesMatch = method === "GET" ? url.pathname.match(/^\/v1\/shows\/([^/]+)\/bytes$/) : null;
  if (!create && !list && !capability && !events && !bytesMatch) return false;
  try {
    const transport = request.transportContext;
    if (!transport || transport.transport === "remote" || transport.peer || transport.guest || transport.scoped) throw new ShowError("show_forbidden", 403);
    // Browser-origin writes cannot turn this local-file verb into a cross-site file reader.
    if (create && request.headers.origin) throw new ShowError("show_forbidden", 403);
    const store = deps.store;
    if (capability) { json(response, 200, { "shows.v1": Boolean(store), ...SHOW_LIMITS }); return true; }
    if (!store) throw new ShowError("shows_unavailable", 503);
    if (create) {
      const parsed = inputSchema.safeParse(await readRequestBody(request, { maxBytes: 16_384, requireJsonContentType: true }));
      if (!parsed.success) throw new ShowError("invalid_show_request");
      const { caller, ...input } = parsed.data;
      const sessionId = caller.metadata?.sessionId;
      const snapshot = deps.snapshot();
      const endpoints = Object.values(snapshot.endpoints).filter(e => e.agentId === caller.actorId);
      const endpoint = sessionId ? endpoints.find(e => e.sessionId === sessionId || e.metadata?.harnessSessionId === sessionId) : endpoints.length === 1 ? endpoints[0] : undefined;
      if (sessionId && endpoints.length && !endpoint) throw new ShowError("show_session_mismatch_check_caller", 409);
      if (endpoint && caller.metadata?.harness && endpoint.harness !== caller.metadata.harness) throw new ShowError("show_harness_mismatch_check_caller", 409);
      json(response, 201, { show: await store.show({ ...input, currentDirectory: caller.currentDirectory, agentId: caller.actorId, sessionId: sessionId || endpoint?.sessionId, harness: endpoint?.harness || caller.metadata?.harness }) });
    } else if (list || events) {
      const project = url.searchParams.get("projectRoot");
      if (!project) throw new ShowError("show_project_root_required");
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new ShowError("invalid_show_since");
      if (list) json(response, 200, { shows: await store.list(project, since) });
      else {
        const projectRoot = await realpath(project);
        if (streams >= 32) throw new ShowError("show_stream_limit", 503);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        streams++;
        const unsubscribe = store.subscribe(show => {
          if (show.projectRoot === projectRoot && show.createdAt > since && response.write(`event: show.created\nid: ${show.id}\ndata: ${JSON.stringify(show)}\n\n`) === false) { close(); response.end(); }
        });
        const timer = setInterval(() => { if (response.write(": keepalive\n\n") === false) { close(); response.end(); } }, 15_000);
        let closed = false;
        const close = () => { if (closed) return; closed = true; streams--; clearInterval(timer); unsubscribe(); };
        response.on("close", close); response.on("error", close);
        response.write(": connected; list after connecting to reconcile missed events\n\n");
      }
    } else if (bytesMatch) {
      const record = await store.get(bytesMatch[1]!);
      const header = request.headers.range;
      let range: [number, number] | undefined;
      try { range = showByteRange(Array.isArray(header) ? header.join(",") : header, record.byteSize); }
      catch (error) { response.writeHead(416, { "content-range": `bytes */${record.byteSize}` }); response.end(); return true; }
      // Open before yielding: an eviction cannot change an in-flight version's bytes.
      const file = await open(store.blobPath(record.id), "r").catch(() => { throw new ShowError("show_not_found", 404); });
      try {
        const start = range?.[0] ?? 0, end = range?.[1] ?? record.byteSize - 1;
        const safeInline = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm|quicktime))$/.test(record.mediaType);
        response.writeHead(range ? 206 : 200, {
          "content-type": safeInline ? record.mediaType : "application/octet-stream",
          "content-disposition": safeInline ? "inline" : "attachment",
          "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "no-store", "accept-ranges": "bytes", "content-length": Math.max(0, end - start + 1),
          etag: `"${record.sha256}"`, ...(range ? { "content-range": `bytes ${start}-${end}/${record.byteSize}` } : {}),
        });
        // Drain-aware bounded reads, including slow/aborted video clients.
        let closed = false; response.on("close", () => { closed = true; });
        for (let offset = start; offset <= end && !closed;) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, end - offset + 1));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead || closed) break;
          offset += bytesRead;
          if (response.write(buffer.subarray(0, bytesRead)) === false && !closed) await new Promise<void>(resolve => {
            const done = () => { response.off?.("drain", done); response.off?.("close", done); resolve(); };
            response.on("drain", done); response.on("close", done);
          });
        }
        response.end();
      } finally { await file.close(); }
    }
  } catch (error) {
    if (response.getHeader?.("content-type")) { response.destroy?.(); return true; }
    json(response, error instanceof ShowError ? error.status : 400, { error: error instanceof ShowError ? error.message : "show_failed_check_path_and_permissions" });
  }
  return true;
}
