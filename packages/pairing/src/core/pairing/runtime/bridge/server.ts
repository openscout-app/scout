import { createCredentialBinding } from "./credential-binding.ts";
// Bridge WebSocket server.
//
// Exposes the bridge over a local WebSocket so the relay (or a direct LAN
// connection from the phone) can send prompts and receive Pairing events.
//
// Supports two modes:
//   - Plaintext (default): backward-compatible, no encryption
//   - Secure: wraps each connection in a Noise-encrypted SecureTransport
//
// Wire protocol: newline-delimited JSON.
//   Inbound (phone -> bridge):  JSON-RPC requests
//   Outbound (bridge -> phone): Pairing events + JSON-RPC responses (wrapped as { seq, event })

import { log } from "./log.ts";
import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import {
  readSessionFileScan,
  readSessionSearch,
} from "@openscout/runtime/system-probes";
import {
  isSessionRegistryError,
  type ActionBlock,
  type Prompt,
  type QuestionAnswer,
} from "@openscout/agent-sessions";
import type { AgentHarness } from "@openscout/protocol";
import type { Bridge } from "./bridge.ts";
import { resolveConfig } from "./config.ts";
import {
  createScoutSession,
  getScoutFleet,
  getScoutMobileActivity,
  getScoutMobileAgents,
  getScoutMobileConversations,
  getScoutMobileConversationMessages,
  getScoutMobileHome,
  getScoutMobileServiceBudgets,
  getScoutMobileSessionSnapshot,
  getScoutMobileSessions,
  getScoutMobileTerminals,
  getScoutMobileWorkspaces,
  markScoutMobileConversationRead,
  sendScoutMobileComms,
  sendScoutMobileMessage,
} from "../../../mobile/service.ts";
import {
  provisionMobileTerminalAccess,
  readMobileTerminalStatus,
} from "./mobile-terminal-provision.ts";
import { InvalidMobileTerminalSessionError } from "./mobile-terminal-session.ts";
import {
  pairingFileServerOrigin,
  readPairingAttachmentBlob,
  storePairingAttachmentBlob,
} from "./fileserver.ts";
import { createArtifactPresentation } from "./artifact-presentation.ts";
import { getMobileMeshNodes } from "./mobile-mesh-nodes.ts";
import { getMobileMeshStatus } from "./mobile-mesh-status.ts";
import {
  SecureTransport,
  type SocketLike,
  type KeyPair,
  isTrustedPeer,
  bytesToHex,
} from "../security/index.ts";
import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RPCRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface RPCResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface BridgeServerOptions {
  /** Enable Noise encryption on all connections. Default: false. */
  secure?: boolean;
  /** Bridge's static key pair (required when secure=true). */
  identity?: KeyPair;
}

interface SocketState {
  unsub?: () => void;
  transport?: SecureTransport;
  deviceId?: string;
  credentialBinding?: object;
  secureTransport?: boolean;
  trustedPeer?: boolean;
}

export interface BridgeRpcContext {
  deviceId?: string;
  credentialBinding?: object;
  secureTransport?: boolean;
  trustedPeer?: boolean;
}

function replaySyncEvents(
  bridge: Bridge,
  sessionId: string,
  lastSeq: number,
): ReturnType<Bridge["replay"]> {
  return bridge.replay(sessionId, lastSeq);
}

function readSyncStatus(
  bridge: Bridge,
  sessionId: string,
): {
  currentSeq: ReturnType<Bridge["currentSeq"]>;
  oldestBufferedSeq: ReturnType<Bridge["oldestBufferedSeq"]>;
} {
  return {
    currentSeq: bridge.currentSeq(sessionId),
    oldestBufferedSeq: bridge.oldestBufferedSeq(sessionId),
  };
}

function resolveSyncSessionId(
  bridge: Bridge,
  preferredSessionId?: string,
): string | null {
  if (preferredSessionId) {
    return preferredSessionId;
  }

  let latestSessionId: string | null = null;
  let latestActivityAt = Number.NEGATIVE_INFINITY;

  for (const session of bridge.getSessionSummaries()) {
    if (session.lastActivityAt > latestActivityAt) {
      latestActivityAt = session.lastActivityAt;
      latestSessionId = session.sessionId;
    }
  }

  return latestSessionId;
}

function sessionRegistryErrorResponse(reqId: string, error: unknown): RPCResponse | null {
  if (!isSessionRegistryError(error)) {
    return null;
  }

  switch (error.code) {
    case "NOT_FOUND":
      return { id: reqId, error: { code: -32001, message: error.message } };
    case "CONFLICT":
      return { id: reqId, error: { code: -32010, message: error.message } };
    case "BAD_REQUEST":
      return { id: reqId, error: { code: -32602, message: error.message } };
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startBridgeServer(
  bridge: Bridge,
  port: number,
  options: BridgeServerOptions = {},
): { stop: () => void } {
  const { secure = false, identity } = options;

  if (secure && !identity) {
    throw new Error("[bridge] secure mode requires an identity (key pair)");
  }

  // Per-socket state, keyed by the raw ServerWebSocket reference.
  const socketState = new WeakMap<ServerWebSocket<unknown>, SocketState>();
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("Pairing bridge. Connect via WebSocket.", { status: 200 });
      }
    },
    websocket: {
      open(ws) {
        console.log("[bridge] client connected");

        const state: SocketState = {};
        socketState.set(ws, state);

        if (secure && identity) {
          // Wrap in SecureTransport. The bridge is always the responder —
          // the phone (or relay-forwarded phone) initiates the handshake.
          const socketAdapter: SocketLike = { send: (data) => ws.send(data) };

          const transport = new SecureTransport(
            socketAdapter,
            "responder",
            identity,
            {
              onReady: (remotePublicKey, readyInfo) => {
                const pubHex = bytesToHex(remotePublicKey);
                const trusted = readyInfo.wasTrustedPeer && isTrustedPeer(pubHex);
                state.deviceId = pubHex.slice(0, 16);
                state.secureTransport = true;
                state.trustedPeer = trusted;
                if (trusted) {
                  try {
                    state.credentialBinding = createCredentialBinding(bridge, pubHex,
                      () => ws.readyState === WebSocket.OPEN && state.transport === transport && transport.isReady());
                  } catch { ws.close(4003, "Credential authority unavailable; reconnect"); return; }
                }
                console.log(
                  `[bridge] secure handshake complete (peer: ${pubHex.slice(0, 12)}..., trusted: ${trusted}, device: ${state.deviceId})`,
                );
                if (!trusted) {
                  console.warn(
                    `[bridge] rejecting untrusted direct secure peer ${pubHex.slice(0, 12)}...; pair via the QR relay first`,
                  );
                  ws.close(4003, "Untrusted peer");
                  return;
                }

                // Push existing sessions through the encrypted channel.
                for (const session of bridge.listSessions()) {
                  transport.send(JSON.stringify({
                    seq: 0,
                    event: { event: "session:update", session },
                  }));
                }

                // Subscribe to future events — forwarded encrypted with seq.
                state.unsub = bridge.onEvent((sequenced) => {
                  logBridgeEvent(sequenced.event, sequenced.seq);
                  transport.send(JSON.stringify({
                    seq: sequenced.seq,
                    event: sequenced.event,
                  }));
                });
              },

              onMessage: (message) => {
                // Decrypted JSON-RPC message from the phone.
                let req: RPCRequest;
                try {
                  req = JSON.parse(message);
                } catch {
                  transport.send(
                    JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }),
                  );
                  return;
                }

                handleRPC(bridge, req, state).then((res) => {
                  transport.send(JSON.stringify(res));
                });
              },

              onError: (err) => {
                console.error("[bridge] secure transport error:", err.message);
              },

              onClose: () => {
                state.unsub?.();
              },
            },
            { trustOnComplete: false },
          );

          state.transport = transport;
        } else {
          // Plaintext mode — push existing sessions with seq wrapper.
          for (const session of bridge.listSessions()) {
            ws.send(JSON.stringify({
              seq: 0,
              event: { event: "session:update", session },
            }));
          }

          // Subscribe to all future events, wrapped with seq.
          state.unsub = bridge.onEvent((sequenced) => {
            ws.send(JSON.stringify({
              seq: sequenced.seq,
              event: sequenced.event,
            }));
          });
        }
      },

      message(ws, raw) {
        const state = socketState.get(ws);

        if (secure && state?.transport) {
          // Feed raw bytes into the SecureTransport (handshake or encrypted data).
          const data = typeof raw === "string" ? raw : new Uint8Array(raw);
          state.transport.receive(data);
        } else {
          // Plaintext mode — handle JSON-RPC directly.
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          let req: RPCRequest;
          try {
            req = JSON.parse(text);
          } catch {
            ws.send(JSON.stringify({ id: null, error: { code: -32700, message: "Parse error" } }));
            return;
          }

          const connState = socketState.get(ws);
          handleRPC(bridge, req, connState).then((res) => {
            ws.send(JSON.stringify(res));
          });
        }
      },

      close(ws) {
        console.log("[bridge] client disconnected");
        const state = socketState.get(ws);
        state?.unsub?.();
      },
    },
  });

  const mode = secure ? "secure (Noise)" : "plaintext";
  console.log(`[bridge] listening on ws://localhost:${port} (${mode})`);

  return {
    stop() {
      server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// RPC handler — also used by relay-client.ts for relayed connections
// ---------------------------------------------------------------------------

function normalizeBridgeRpcContext(input?: string | BridgeRpcContext): BridgeRpcContext {
  if (!input) return {};
  if (typeof input === "string") return { deviceId: input };
  return input;
}

export async function handleRPC(
  bridge: Bridge,
  req: RPCRequest,
  rpcContext?: string | BridgeRpcContext,
): Promise<RPCResponse> {
  const context = normalizeBridgeRpcContext(rpcContext);
  const rpcStart = Date.now();
  const paramsSnippet = summarizeRPCParams(req.method, req.params);
  log.debug("rpc:req", `→ ${req.method}${paramsSnippet}`);
  const result = await handleRPCInner(bridge, req, context);
  const elapsed = Date.now() - rpcStart;
  if (result.error) {
    log.error("rpc:res", `✗ ${req.method} — ${result.error.message} (${elapsed}ms)`);
  } else {
    const size = summarizeRPCResult(req.method, result.result);
    log.debug("rpc:res", `✓ ${req.method}${size} (${elapsed}ms)`);
  }
  return result;
}

async function handleRPCInner(
  bridge: Bridge,
  req: RPCRequest,
  rpcContext: BridgeRpcContext = {},
): Promise<RPCResponse> {
  try {
    switch (req.method) {
      case "session/create": {
        const p = req.params as { adapterType: string; name?: string; cwd?: string; options?: Record<string, unknown> };
        const session = await bridge.createSession(p.adapterType, {
          name: p.name,
          cwd: p.cwd,
          options: p.options,
        });
        return { id: req.id, result: session };
      }

      case "session/list": {
        return { id: req.id, result: bridge.listSessions() };
      }

      case "session/close": {
        const p = req.params as { sessionId: string };
        await bridge.closeSession(p.sessionId);
        return { id: req.id, result: { ok: true } };
      }

      case "prompt/send": {
        const prompt = req.params as Prompt;
        log.info("prompt", `sending to session ${prompt.sessionId}`, { text: prompt.text?.slice(0, 80) });
        bridge.send(prompt);
        log.info("prompt", "send() returned — adapter should be streaming");
        return { id: req.id, result: { ok: true } };
      }

      case "turn/interrupt": {
        const p = req.params as { sessionId: string };
        bridge.interrupt(p.sessionId);
        return { id: req.id, result: { ok: true } };
      }

      case "question/answer": {
        const answer = req.params as QuestionAnswer;
        try {
          bridge.answerQuestion(answer);
        } catch (error) {
          return sessionRegistryErrorResponse(req.id, error)
            ?? { id: req.id, error: { code: -32000, message: error instanceof Error ? error.message : "Internal error" } };
        }
        return { id: req.id, result: { ok: true } };
      }

      // -- Reconnect / buffer ------------------------------------------------

      case "sync/replay": {
        const p = (req.params ?? {}) as { lastSeq?: number; sessionId?: string };
        if (typeof p.lastSeq !== "number") {
          return { id: req.id, error: { code: -32602, message: "lastSeq is required" } };
        }

        const sessionId = resolveSyncSessionId(bridge, p.sessionId);
        if (!sessionId) {
          return { id: req.id, result: { events: [] } };
        }

        const events = replaySyncEvents(bridge, sessionId, p.lastSeq);
        return { id: req.id, result: { events } };
      }

      case "sync/status": {
        const p = (req.params ?? {}) as { sessionId?: string };
        const sessionCount = bridge.listSessions().length;
        const sessionId = resolveSyncSessionId(bridge, p.sessionId);
        if (!sessionId) {
          return {
            id: req.id,
            result: {
              currentSeq: 0,
              oldestBufferedSeq: 0,
              sessionCount,
            },
          };
        }

        return {
          id: req.id,
          result: {
            ...readSyncStatus(bridge, sessionId),
            sessionCount,
          },
        };
      }

      // -- Snapshot / status -------------------------------------------------

      case "session/snapshot": {
        const p = req.params as { sessionId: string };
        const snapshot = bridge.getSessionSnapshot(p.sessionId);
        if (!snapshot) {
          return { id: req.id, error: { code: -32001, message: `No session: ${p.sessionId}` } };
        }
        return { id: req.id, result: snapshot };
      }

      case "bridge/status": {
        const sessions = bridge.getSessionSummaries();
        return { id: req.id, result: { sessions } };
      }

      // -- Approval -----------------------------------------------------------

      case "action/decide": {
        const p = req.params as {
          sessionId: string;
          turnId: string;
          blockId: string;
          version: number;
          decision: "approve" | "deny";
          reason?: string;
        };

        // Look up the block's current approval state for version validation.
        const snapshot = bridge.getSessionSnapshot(p.sessionId);
        if (!snapshot) {
          return { id: req.id, error: { code: -32001, message: `No session: ${p.sessionId}` } };
        }

        const turn = snapshot.turns.find((t) => t.id === p.turnId);
        if (!turn) {
          return { id: req.id, error: { code: -32001, message: `No turn: ${p.turnId}` } };
        }

        const blockState = turn.blocks.find((b) => b.block.id === p.blockId);
        if (!blockState || blockState.block.type !== "action") {
          return { id: req.id, error: { code: -32001, message: `No action block: ${p.blockId}` } };
        }

        const action = (blockState.block as ActionBlock).action;
        if (!action.approval || action.approval.version !== p.version) {
          return { id: req.id, error: { code: -32010, message: "Stale approval version" } };
        }

        try {
          bridge.decide({
            sessionId: p.sessionId,
            turnId: p.turnId,
            blockId: p.blockId,
            version: p.version,
            decision: p.decision,
            reason: p.reason,
          });
        } catch (error) {
          return sessionRegistryErrorResponse(req.id, error)
            ?? { id: req.id, error: { code: -32000, message: error instanceof Error ? error.message : "Internal error" } };
        }
        return { id: req.id, result: { ok: true } };
      }

      // -- Session resume ------------------------------------------------------

      case "session/resume": {
        const p = req.params as {
          sessionPath: string;
          adapterType?: string;
          name?: string;
        };

        const sessionFilename = basename(p.sessionPath, ".jsonl");
        const parentDir = p.sessionPath.substring(0, p.sessionPath.lastIndexOf("/"));
        const dirName = basename(parentDir);

        // Reconstruct CWD from Claude Code's path encoding: -Users-foo-dev-bar → /Users/foo/dev/bar
        let cwd: string;
        if (dirName.startsWith("-")) {
          const candidate = "/" + dirName.slice(1).replace(/-/g, "/");
          try {
            statSync(candidate);
            cwd = candidate;
          } catch {
            // Fallback: use workspace root or process cwd
            const config = resolveConfig();
            cwd = config.workspace?.root
              ? resolveWorkspaceRoot(config.workspace.root)
              : process.cwd();
          }
        } else {
          cwd = process.cwd();
        }

        const adapterType = p.adapterType ?? "claude-code";
        const name = p.name ?? extractProjectName(p.sessionPath);

        const session = await bridge.createSession(adapterType, {
          name,
          cwd,
          options: { resume: sessionFilename },
        });
        return { id: req.id, result: session };
      }

      // -- Workspace discovery ------------------------------------------------

      case "workspace/info": {
        const config = resolveConfig();
        const configuredRoot = config.workspace?.root;
        if (!configuredRoot) {
          return { id: req.id, result: { configured: false } };
        }
        try {
          const root = resolveWorkspaceRoot(configuredRoot);
          return { id: req.id, result: { configured: true, root } };
        } catch (err: any) {
          return { id: req.id, error: { code: -32002, message: err.message } };
        }
      }

      case "workspace/list": {
        const p0 = req.params as { path?: string } | undefined;
        const config = resolveConfig();
        const configuredRoot = config.workspace?.root;
        if (!configuredRoot) {
          return { id: req.id, error: { code: -32002, message: "No workspace root configured" } };
        }

        const p = req.params as { path?: string } | undefined;

        try {
          const root = resolveWorkspaceRoot(configuredRoot);
          const browsePath = resolveWorkspacePath(root, p?.path);
          const entries = listDirectories(browsePath);
          return { id: req.id, result: { root, path: browsePath, entries } };
        } catch (err: any) {
          return { id: req.id, error: { code: -32000, message: err.message } };
        }
      }

      case "workspace/open": {
        const p = req.params as { path: string; adapter?: string; name?: string };
        const config = resolveConfig();
        const configuredRoot = config.workspace?.root;

        if (!configuredRoot) {
          return { id: req.id, error: { code: -32002, message: "No workspace root configured" } };
        }

        const root = resolveWorkspaceRoot(configuredRoot);
        const projectPath = resolveWorkspacePath(root, p.path);
        const stat = statSync(projectPath);
        if (!stat.isDirectory()) {
          return { id: req.id, error: { code: -32000, message: "Workspace target is not a directory" } };
        }

        const adapterType = p.adapter ?? "claude-code";
        const name = p.name ?? basename(projectPath);

        const session = await bridge.createSession(adapterType, {
          name,
          cwd: projectPath,
        });
        return { id: req.id, result: session };
      }

      // -- Broker-native mobile surface --------------------------------------

      case "mobile/home": {
        const p = req.params as {
          workspaceLimit?: number;
          agentLimit?: number;
          sessionLimit?: number;
        } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileHome({
            currentDirectory: resolveMobileCurrentDirectory(),
            workspaceLimit: p?.workspaceLimit,
            agentLimit: p?.agentLimit,
            sessionLimit: p?.sessionLimit,
          }),
        };
      }

      case "mobile/workspaces": {
        const p = req.params as { query?: string; limit?: number } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileWorkspaces(p, resolveMobileCurrentDirectory()),
        };
      }

      case "mobile/agents": {
        const p = req.params as { query?: string; limit?: number } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileAgents(p, resolveMobileCurrentDirectory()),
        };
      }

      case "mobile/sessions": {
        const p = req.params as { query?: string; limit?: number } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileSessions(p, resolveMobileCurrentDirectory()),
        };
      }

      case "mobile/mesh/status": {
        return {
          id: req.id,
          result: await getMobileMeshStatus(),
        };
      }

      case "mobile/mesh/nodes": {
        return {
          id: req.id,
          result: await getMobileMeshNodes(),
        };
      }

      case "mobile/session/snapshot": {
        const p = req.params as {
          conversationId?: string;
          sessionId?: string;
          beforeTurnId?: string | null;
          limit?: number | null;
        };
        const conversationId = p?.conversationId ?? p?.sessionId;
        if (!conversationId) {
          return { id: req.id, error: { code: -32602, message: "conversationId is required" } };
        }
        return {
          id: req.id,
          result: await getScoutMobileSessionSnapshot(
            conversationId,
            {
              beforeTurnId: p?.beforeTurnId ?? null,
              limit: typeof p?.limit === "number" ? p.limit : null,
            },
            resolveMobileCurrentDirectory(),
          ),
        };
      }

      case "mobile/artifacts/present": {
        const p = req.params as {
          sessionId?: string;
          sourcePath?: string;
          entryPath?: string | null;
          title?: string | null;
          ttlMs?: number | null;
        };
        if (!p?.sessionId || !p?.sourcePath) {
          return { id: req.id, error: { code: -32602, message: "sessionId and sourcePath are required" } };
        }
        if (!rpcContext.secureTransport || !rpcContext.trustedPeer || !rpcContext.deviceId) {
          return {
            id: req.id,
            error: {
              code: -32001,
              message: "Artifact presentation requires a trusted paired device over the encrypted bridge.",
            },
          };
        }
        const snapshot = bridge.getSessionSnapshot(p.sessionId);
        const workspaceRoot = snapshot?.session.cwd?.trim();
        if (!snapshot || !workspaceRoot) {
          return { id: req.id, error: { code: -32004, message: `No workspace-backed session: ${p.sessionId}` } };
        }
        try {
          const grant = createArtifactPresentation(
            {
              sourcePath: isAbsolute(p.sourcePath) ? p.sourcePath : resolve(workspaceRoot, p.sourcePath),
              entryPath: p.entryPath,
              title: p.title,
              ttlMs: p.ttlMs,
            },
            { allowedRoot: workspaceRoot },
          );
          return {
            id: req.id,
            result: {
              ...grant,
              port: resolveConfig().port + 2,
            },
          };
        } catch (error) {
          return {
            id: req.id,
            error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
          };
        }
      }

      case "mobile/session/create": {
        const p = req.params as {
          workspaceId: string;
          harness?: AgentHarness;
          agentName?: string;
          worktree?: string | null;
          profile?: string | null;
          branch?: string;
          model?: string;
          forceNew?: boolean;
          seed?: {
            instructions?: string | null;
            fromMessageId?: string | null;
            fromConversationId?: string | null;
            attachments?: Array<{
              id?: string;
              mediaType: string;
              fileName?: string;
              blobKey?: string;
              url?: string;
            }>;
          } | null;
        };
        return {
          id: req.id,
          result: await createScoutSession(p, resolveMobileCurrentDirectory(), rpcContext.deviceId),
        };
      }

      case "mobile/message/send": {
        const p = req.params as {
          agentId: string;
          body: string;
          clientMessageId?: string | null;
          replyToMessageId?: string | null;
          referenceMessageIds?: string[];
          harness?: AgentHarness;
        };
        return {
          id: req.id,
          result: await sendScoutMobileMessage(p, resolveMobileCurrentDirectory(), rpcContext.deviceId),
        };
      }

      case "mobile/activity": {
        const p = req.params as {
          agentId?: string;
          actorId?: string;
          conversationId?: string;
          limit?: number;
        } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileActivity(p),
        };
      }

      case "mobile/fleet": {
        const p = req.params as { limit?: number } | undefined;
        return {
          id: req.id,
          result: await getScoutFleet({ limit: p?.limit }),
        };
      }

      case "mobile/service-budgets": {
        // No params; the phone just asks for the current usage-quota readout.
        return {
          id: req.id,
          result: await getScoutMobileServiceBudgets(),
        };
      }

      case "mobile/terminal-sessions": {
        // No params; the phone just asks for the recent terminal sessions.
        return {
          id: req.id,
          result: await getScoutMobileTerminals(),
        };
      }

      // -- Comms (channels + DMs) ---------------------------------------------

      case "mobile/comms/conversations": {
        const p = req.params as { kind?: string; limit?: number } | undefined;
        return {
          id: req.id,
          result: await getScoutMobileConversations(p ?? {}),
        };
      }

      case "mobile/comms/messages": {
        const p = req.params as { conversationId?: string; limit?: number };
        if (!p?.conversationId) {
          return { id: req.id, error: { code: -32602, message: "conversationId is required" } };
        }
        return {
          id: req.id,
          result: await getScoutMobileConversationMessages(
            p.conversationId,
            typeof p.limit === "number" ? p.limit : 200,
          ),
        };
      }

      case "mobile/comms/send": {
        const p = req.params as {
          conversationId?: string;
          body?: string;
          attachments?: Array<{
            id?: string;
            mediaType: string;
            fileName?: string;
            blobKey?: string;
            url?: string;
          }>;
          replyToMessageId?: string | null;
          clientMessageId?: string | null;
        };
        if (!p?.conversationId || (!p?.body && !p?.attachments?.length)) {
          return { id: req.id, error: { code: -32602, message: "conversationId and body or attachments are required" } };
        }
        return {
          id: req.id,
          result: await sendScoutMobileComms(
            {
              conversationId: p.conversationId,
              body: p.body ?? "",
              attachments: p.attachments,
              replyToMessageId: p.replyToMessageId ?? null,
              clientMessageId: p.clientMessageId ?? null,
            },
            resolveMobileCurrentDirectory(),
            rpcContext.deviceId,
          ),
        };
      }

      case "mobile/attachments/upload": {
        const p = req.params as { data?: string; mediaType?: string; fileName?: string | null };
        if (!p?.data || !p?.mediaType) {
          return { id: req.id, error: { code: -32602, message: "data and mediaType are required" } };
        }
        if (!rpcContext.secureTransport || !rpcContext.trustedPeer || !rpcContext.deviceId) {
          return {
            id: req.id,
            error: {
              code: -32001,
              message: "Attachment upload requires a trusted paired device over the encrypted bridge.",
            },
          };
        }
        const fileServerPort = resolveConfig().port + 2;
        return {
          id: req.id,
          result: storePairingAttachmentBlob(
            {
              data: p.data,
              mediaType: p.mediaType,
              fileName: p.fileName ?? undefined,
            },
            { origin: pairingFileServerOrigin(fileServerPort) },
          ),
        };
      }

      case "mobile/attachments/fetch": {
        const p = req.params as { id?: string };
        if (!p?.id) {
          return { id: req.id, error: { code: -32602, message: "id is required" } };
        }
        if (!rpcContext.secureTransport || !rpcContext.trustedPeer || !rpcContext.deviceId) {
          return {
            id: req.id,
            error: {
              code: -32001,
              message: "Attachment fetch requires a trusted paired device over the encrypted bridge.",
            },
          };
        }
        const blob = readPairingAttachmentBlob(p.id);
        if (!blob) {
          return { id: req.id, error: { code: -32004, message: "Attachment is gone or expired." } };
        }
        return { id: req.id, result: blob };
      }

      case "mobile/comms/read": {
        const p = req.params as { conversationId?: string; lastReadMessageId?: string | null };
        if (!p?.conversationId) {
          return { id: req.id, error: { code: -32602, message: "conversationId is required" } };
        }
        return {
          id: req.id,
          result: await markScoutMobileConversationRead({
            conversationId: p.conversationId,
            lastReadMessageId: p.lastReadMessageId ?? null,
          }),
        };
      }

      // -- Terminal (in-app SSH/PTY) ------------------------------------------

      case "mobile/terminal/provision": {
        const p = req.params as { sshPublicKey?: string; deviceClass?: string };
        if (!p?.sshPublicKey) {
          return { id: req.id, error: { code: -32602, message: "sshPublicKey is required" } };
        }
        if (!rpcContext.secureTransport || !rpcContext.trustedPeer || !rpcContext.deviceId) {
          return {
            id: req.id,
            error: {
              code: -32001,
              message: "Terminal provisioning requires a trusted paired device over the encrypted bridge.",
            },
          };
        }
        return {
          id: req.id,
          result: await provisionMobileTerminalAccess(p.sshPublicKey, rpcContext.deviceId, p.deviceClass, rpcContext.credentialBinding),
        };
      }

      case "mobile/terminal/status": {
        const p = req.params as { sessionName?: string } | null;
        if (!rpcContext.secureTransport || !rpcContext.trustedPeer || !rpcContext.deviceId) {
          return {
            id: req.id,
            error: {
              code: -32001,
              message: "Terminal status requires a trusted paired device over the encrypted bridge.",
            },
          };
        }
        try {
          return {
            id: req.id,
            result: await readMobileTerminalStatus(p?.sessionName, rpcContext.deviceId, rpcContext.credentialBinding),
          };
        } catch (error) {
          if (error instanceof InvalidMobileTerminalSessionError) {
            return { id: req.id, error: { code: -32602, message: error.message } };
          }
          throw error;
        }
      }

      // -- Session History Discovery ------------------------------------------

      case "history/discover": {
        const p = req.params as { maxAge?: number; limit?: number; project?: string } | null;
        const maxAgeDays = p?.maxAge ?? 14;
        const limit = p?.limit ?? 250;
        const projectFilter = p?.project;

        let sessions = await discoverSessionFiles(maxAgeDays, limit);
        if (projectFilter) {
          const filter = projectFilter.toLowerCase();
          sessions = sessions.filter((s) => s.project.toLowerCase().includes(filter));
        }
        return { id: req.id, result: { sessions } };
      }

      case "history/search": {
        const p = req.params as { query: string; maxAge?: number; limit?: number };

        const maxAge = p.maxAge ?? 14;
        const limit = p.limit ?? 50;

        const candidateLimit = Math.max(limit * 10, 1000);
        const config = resolveConfig();
        const workspaceRoot = config.workspace?.root
          ? resolveWorkspaceRoot(config.workspace.root)
          : null;
        const matches = await readSessionSearch({
          home: homedir(),
          workspaceRoot,
          maxAgeDays: maxAge,
          limit,
          query: p.query,
          candidateLimit,
        });

        return { id: req.id, result: { query: p.query, matches: matches.slice(0, limit) } };
      }

      case "history/read": {
        const p = req.params as { path: string };

        // Safety: only allow reading .jsonl files
        if (!p.path.endsWith(".jsonl")) {
          return { id: req.id, error: { code: -32000, message: "Only .jsonl files can be read" } };
        }

        try {
          const content = readFileSync(p.path, "utf-8");
          const lines = content.split("\n").filter((l) => l.trim().length > 0);
          // Return raw lines (phone parses them) — limit to last 500 lines for large files
          const trimmed = lines.length > 500 ? lines.slice(-500) : lines;
          return { id: req.id, result: { path: p.path, lineCount: lines.length, lines: trimmed } };
        } catch (err: any) {
          return { id: req.id, error: { code: -32000, message: `Cannot read file: ${err.message}` } };
        }
      }

      default:
        return { id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
    }
  } catch (err: any) {
    return { id: req.id, error: { code: -32000, message: err.message ?? "Internal error" } };
  }
}

function logBridgeEvent(event: unknown, seq: number): void {
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  const eventType = e.event as string ?? "unknown";
  const sessionId = (e.sessionId ?? (e.session as any)?.id ?? "") as string;
  const shortSession = sessionId ? sessionId.slice(0, 20) : "";

  switch (eventType) {
    case "session:update":
      log.info("event", `↓ session:update ${shortSession} status=${(e.session as any)?.status ?? "?"}`, { seq });
      break;
    case "turn:start":
      log.info("event", `↓ turn:start ${shortSession} turn=${e.turnId ?? "?"}`, { seq });
      break;
    case "turn:end":
      log.info("event", `↓ turn:end ${shortSession} turn=${e.turnId ?? "?"}`, { seq });
      break;
    case "block:start":
      log.debug("event", `↓ block:start ${shortSession} type=${(e.block as any)?.type ?? "?"}`, { seq });
      break;
    case "block:delta":
      // Too noisy to log every delta — skip
      break;
    case "block:end":
      log.debug("event", `↓ block:end ${shortSession}`, { seq });
      break;
    default:
      log.info("event", `↓ ${eventType} ${shortSession}`, { seq });
  }
}

function summarizeRPCResult(method: string, result: unknown): string {
  if (!result) return "";
  if (Array.isArray(result)) return ` → ${result.length} items`;
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    switch (method) {
      case "mobile/session/snapshot": {
        const turns = Array.isArray(r.turns) ? r.turns.length : 0;
        const name = (r.session as any)?.name ?? "";
        return ` → ${turns} turns${name ? ` "${name.toString().slice(0, 40)}"` : ""}`;
      }
      case "mobile/home": {
        const s = r.sessions, a = r.agents, w = r.workspaces;
        return ` → ${Array.isArray(s) ? s.length : 0} sessions, ${Array.isArray(a) ? a.length : 0} agents, ${Array.isArray(w) ? w.length : 0} workspaces`;
      }
      case "mobile/session/create": {
        const conv = (r.session as any)?.conversationId ?? "";
        return conv ? ` → ${conv}` : "";
      }
      case "history/discover": {
        const sessions = Array.isArray(r.sessions) ? r.sessions.length : 0;
        return ` → ${sessions} sessions`;
      }
      default:
        if (r.ok) return " → ok";
        return "";
    }
  }
  return "";
}

function summarizeRPCParams(method: string, params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  switch (method) {
    case "mobile/session/snapshot": {
      const id = (p.conversationId ?? p.sessionId) as string | undefined;
      const before = p.beforeTurnId ? ` before=${p.beforeTurnId}` : "";
      const limit = p.limit ? ` limit=${p.limit}` : "";
      return ` session=${id ?? "?"}${before}${limit}`;
    }
    case "mobile/sessions":
    case "mobile/workspaces":
    case "mobile/agents": {
      const parts: string[] = [];
      if (p.query) parts.push(`q="${p.query}"`);
      if (p.limit) parts.push(`limit=${p.limit}`);
      return parts.length ? ` ${parts.join(" ")}` : "";
    }
    case "mobile/activity": {
      const parts: string[] = [];
      if (p.agentId) parts.push(`agent=${p.agentId}`);
      if (p.actorId) parts.push(`actor=${p.actorId}`);
      if (p.conversationId) parts.push(`conv=${p.conversationId}`);
      if (p.limit) parts.push(`limit=${p.limit}`);
      return parts.length ? ` ${parts.join(" ")}` : "";
    }
    case "mobile/fleet": {
      return p.limit ? ` limit=${p.limit}` : "";
    }
    case "mobile/message/send": {
      const body = typeof p.body === "string" ? p.body.slice(0, 60) : "";
      return ` agent=${p.agentId ?? "?"} "${body}${body.length >= 60 ? "…" : ""}"`;
    }
    case "mobile/session/create": {
      return ` workspace=${p.workspaceId ?? "?"} harness=${p.harness ?? "default"}`;
    }
    case "mobile/home": {
      return "";
    }
    case "workspace/open": {
      return ` path=${p.path ?? "?"}`;
    }
    case "history/discover": {
      return ` maxAge=${p.maxAge ?? 14}d limit=${p.limit ?? 250}`;
    }
    case "history/search": {
      return ` q="${(p.query as string)?.slice(0, 40) ?? ""}"`;
    }
    default:
      return Object.keys(p).length > 0 ? ` ${JSON.stringify(p).slice(0, 80)}` : "";
  }
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

interface DirectoryEntry {
  name: string;
  path: string;
  markers: string[];
}

function resolveMobileCurrentDirectory(): string {
  const config = resolveConfig();
  const configuredRoot = config.workspace?.root;
  if (!configuredRoot) {
    return process.cwd();
  }

  try {
    return resolveWorkspaceRoot(configuredRoot);
  } catch {
    return process.cwd();
  }
}

function resolveWorkspaceRoot(root: string): string {
  const expandedRoot = root.replace(/^~/, homedir());
  return realpathSync(expandedRoot);
}

export function resolveWorkspacePath(root: string, requestedPath?: string): string {
  const normalizedRoot = resolveWorkspaceRoot(root);
  const expandedPath = requestedPath?.replace(/^~/, homedir());
  const candidate = expandedPath
    ? isAbsolute(expandedPath)
      ? expandedPath
      : join(normalizedRoot, expandedPath)
    : normalizedRoot;
  const resolvedCandidate = realpathSync(candidate);
  const rel = relative(normalizedRoot, resolvedCandidate);

  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedCandidate;
  }

  throw new Error("Path escapes workspace root");
}

const MARKER_FILES: [string, string][] = [
  [".git",            "git"],
  ["package.json",    "node"],
  ["Package.swift",   "swift"],
  ["Cargo.toml",      "rust"],
  ["go.mod",          "go"],
  ["pyproject.toml",  "python"],
  ["setup.py",        "python"],
  ["Gemfile",         "ruby"],
  ["build.gradle",    "java"],
  ["pom.xml",         "java"],
  ["CMakeLists.txt",  "cpp"],
  ["Makefile",        "make"],
  [".xcodeproj",      "xcode"],
];

function listDirectories(dirPath: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];

  for (const name of readdirSync(dirPath)) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === ".build" || name === "target") continue;

    const fullPath = join(dirPath, name);
    try {
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;

      const children = new Set(readdirSync(fullPath));
      const markers: string[] = [];
      const seen = new Set<string>();

      for (const [file, marker] of MARKER_FILES) {
        // Handle both exact matches and suffix matches (e.g. .xcodeproj)
        const found = file.startsWith(".")
          ? [...children].some(c => c.endsWith(file))
          : children.has(file);

        if (found && !seen.has(marker)) {
          markers.push(marker);
          seen.add(marker);
        }
      }

      entries.push({ name, path: fullPath, markers });
    } catch {
      continue;
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Session history discovery
// ---------------------------------------------------------------------------

interface DiscoveredSession {
  path: string;
  project: string;
  agent: string;       // "claude-code" | "codex" | "aider" | "unknown"
  modifiedAt: number;  // epoch ms
  sizeBytes: number;
  lineCount: number;   // approximate, from wc -l
}

/**
 * Discover JSONL session files across known agent log locations.
 * Uses fast POSIX commands (find + stat) — no deep parsing.
 */
async function discoverSessionFiles(maxAgeDays: number, limit: number): Promise<DiscoveredSession[]> {
  const config = resolveConfig();
  const workspaceRoot = config.workspace?.root
    ? resolveWorkspaceRoot(config.workspace.root)
    : null;
  const sessions = await readSessionFileScan({
    home: homedir(),
    workspaceRoot,
    maxAgeDays,
    limit,
  });
  return sessions.map((session) => ({
    ...session,
    lineCount: 0,
  }));
}

function extractProjectName(filePath: string): string {
  // Claude Code pattern: ~/.claude/projects/-Users-arach-dev-PROJECT/...
  const claudeMatch = filePath.match(/\.claude\/projects\/[^/]*-dev-([^/]+)/);
  if (claudeMatch?.[1]) return claudeMatch[1];

  // Generic: use parent directory name
  const parts = filePath.split("/");
  return parts[parts.length - 2] || "unknown";
}


// HTTP file serving has moved to fileserver.ts — independent start/stop lifecycle.
