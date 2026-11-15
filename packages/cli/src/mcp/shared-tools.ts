/**
 * One set of Scout tool definitions for every connection.
 *
 * Building a Scout MCP server registers ~50 tools with their schemas and
 * handlers, about 3 MB. The shared HTTP server builds that once. Each
 * connection gets only a protocol endpoint (a low-level `Server`) whose
 * requests run the shared handlers inside an AsyncLocalStorage scope that
 * holds the connection's environment, folder and notification target.
 *
 * The tools read the session through `env` and `defaultCurrentDirectory`
 * at call time. Both are views onto the current scope here, so the same
 * handler sees a different session on each connection. A value the tools
 * read while being built is fixed for every connection; `buildTimeReads`
 * lists those keys.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createScoutMcpServer, type ScoutMcpSessionScope } from "./scout-mcp.ts";

export type ScoutSessionContext = {
  env: NodeJS.ProcessEnv;
  currentDirectory: string;
  scope: ScoutMcpSessionScope;
};

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/** A request as the SDK hands it to a handler. */
export type SharedToolRequest = { method: string; params?: { _meta?: unknown; [key: string]: unknown } };

/**
 * The session a request runs as: one context for the whole connection, or
 * one chosen per request (a Codex call names its thread and turn).
 */
export type ScoutSessionResolver =
  | ScoutSessionContext
  | ((request: SharedToolRequest) => ScoutSessionContext | Promise<ScoutSessionContext>);

/** SDK internals this module relies on. Checked once at build time so a change fails loudly. */
type ProtocolInternals = {
  _requestHandlers: Map<string, RequestHandler>;
  _capabilities: Record<string, unknown>;
  _serverInfo: { name: string; version: string };
  _instructions?: string;
};

/** Requests every protocol endpoint answers itself. */
const PER_CONNECTION_METHODS = new Set(["initialize", "ping"]);

export type SharedScoutTools = {
  /** A protocol endpoint for one connection, answered by the shared tools. */
  connect: (session: ScoutSessionResolver) => Server;
  /** Env keys read while the tools were built: one value for every connection. */
  buildTimeReads: ReadonlySet<string>;
  methods: string[];
};

export function createSharedScoutTools(baseEnv: NodeJS.ProcessEnv = process.env): SharedScoutTools {
  const sessions = new AsyncLocalStorage<ScoutSessionContext>();
  const buildTimeReads = new Set<string>();
  const current = () => sessions.getStore();
  const targetEnv = () => current()?.env ?? baseEnv;

  const env = new Proxy({} as NodeJS.ProcessEnv, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const store = current();
      if (!store) {
        buildTimeReads.add(key);
        return baseEnv[key];
      }
      return store.env[key];
    },
    set(_target, key, value) {
      targetEnv()[key as string] = value;
      return true;
    },
    deleteProperty(_target, key) {
      delete targetEnv()[key as string];
      return true;
    },
    has(_target, key) {
      return typeof key === "string" && key in targetEnv();
    },
    // Listing keys (Object.keys asks ownKeys and each descriptor) fixes
    // nothing; reading a value does. A copy made while building
    // ({ ...env }) reads every value through `get`, which records it.
    ownKeys() {
      return Reflect.ownKeys(targetEnv());
    },
    getOwnPropertyDescriptor(_target, key) {
      const value = targetEnv()[key as string];
      return value === undefined ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
  });

  const template: McpServer = createScoutMcpServer({
    get defaultCurrentDirectory() {
      return current()?.currentDirectory ?? baseEnv.HOME ?? "/";
    },
    env,
    sessionScope: () => current()?.scope,
  });

  const internals = template.server as unknown as ProtocolInternals;
  if (!(internals._requestHandlers instanceof Map) || !internals._requestHandlers.has("tools/call")) {
    throw new Error("MCP SDK internals changed: cannot share tool handlers across connections");
  }
  const shared = [...internals._requestHandlers].filter(([method]) => !PER_CONNECTION_METHODS.has(method));
  const capabilities = structuredClone(internals._capabilities);
  const serverInfo = { ...internals._serverInfo };
  const instructions = internals._instructions;

  return {
    buildTimeReads,
    methods: shared.map(([method]) => method),
    connect(session) {
      const server = new Server(serverInfo, { capabilities, instructions });
      const handlers = (server as unknown as ProtocolInternals)._requestHandlers;
      const resolve = typeof session === "function" ? session : () => session;
      for (const [method, handler] of shared) {
        // A resolver that throws refuses the request; the SDK turns it into
        // a JSON-RPC error for the client.
        handlers.set(method, async (request, extra) => {
          const context = await resolve(request as SharedToolRequest);
          return sessions.run(context, () => handler(request, extra));
        });
      }
      return server;
    },
  };
}
