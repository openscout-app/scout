import * as z from "zod/v4";
import type { ObservedSessionInventory } from "@openscout/protocol";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";

const status = z.enum(["not_scanned", "available", "unavailable", "unknown"]);
const id = z.string().min(1).max(1024).regex(/^[^\x00-\x1f]+$/u);
const schema = z.object({
  schema: z.literal("scout.observed-sessions/v1"), nodeId: id,
  scannedAt: z.number().finite().nullable(), availability: z.enum(["not_scanned", "available", "unavailable", "unknown", "partial"]),
  sources: z.array(z.object({ harness: id, availability: status, processes: status }).strict()).max(32),
  sessions: z.array(z.object({
    identity: z.object({ nodeId: id, harness: id, nativeSessionId: id }).strict(),
    links: z.array(z.object({ kind: z.enum(["agent", "conversation", "terminal"]), id }).strict()).max(8),
    cwd: z.string().max(4096).nullable(), title: z.string().max(512).nullable(),
    // Older runtimes send neither field; a renamed session carries both.
    titleSource: z.enum(["operator", "work", "harness"]).nullable().optional(),
    harnessTitle: z.string().max(512).nullable().optional(),
    observedAt: z.number().finite(), availability: status, identityConflict: z.boolean(),
  }).strict()).max(200),
  coverage: z.object({ kind: z.literal("cached_window"), scope: z.string().nullable(), truncated: z.boolean(),
    links: z.object({ agents: z.enum(["available", "unavailable"]), conversations: z.literal("unsupported"), terminals: z.literal("unsupported") }).strict(),
  }).strict(),
}).strict();

export class SessionInventoryError extends Error {
  constructor(readonly status: number | null, readonly code: string) { super(`Session inventory unavailable: ${code}${status === null ? "" : ` (HTTP ${status})`}.`); }
}
const invalid = () => new SessionInventoryError(null, "invalid_session_inventory_response");

/** Passive local read only. No web cookie/bootstrap, source scan, transcript
 * read, resolver by-ref precedence, service startup, or failed-socket fallback.
 * Keep these bounds when this minimal client joins the shared reader. */
export async function readRuntimeSessionInventory(options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<ObservedSessionInventory> {
  const env = options.env ?? process.env;
  const origin = new URL(env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl());
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new SessionInventoryError(null, "local_broker_required");
  const socketPath = env.OPENSCOUT_BROKER_SOCKET_PATH?.trim();
  if (env.OPENSCOUT_BROKER_SOCKET_ONLY === "1" && !socketPath) throw new SessionInventoryError(null, "broker_socket_required");
  const response = await (options.fetchImpl ?? fetch)(new URL("/v1/observed-sessions?limit=200", origin), {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(8_000), ...(socketPath ? { unix: socketPath } : {}),
  });
  const reader = response.body?.getReader();
  try {
    const limit = 8 * 1024 * 1024;
    if (response.redirected || response.status >= 300 && response.status < 400 || Number(response.headers.get("content-length")) > limit) throw invalid();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > limit) throw invalid(); chunks.push(chunk.value);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch {
      if (response.status !== 200) throw new SessionInventoryError(response.status, "session_inventory_unavailable");
      throw invalid();
    }
    if (response.status !== 200) {
      const error = z.object({ error: z.string().regex(/^[a-z_]{1,128}$/) }).safeParse(payload);
      throw new SessionInventoryError(response.status, error.success ? error.data.error : "session_inventory_unavailable");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw invalid();
    const inventory = parsed.data;
    const keys = new Set<string>();
    for (const session of inventory.sessions) {
      const key = JSON.stringify(session.identity);
      if (session.identity.nodeId !== inventory.nodeId || keys.has(key)) throw invalid();
      keys.add(key);
    }
    return inventory;
  } catch (error) {
    if (error instanceof SessionInventoryError) throw error;
    throw invalid();
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
