import { test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { signLocalAdminRequest } from "../mesh-access-local-auth";

import {
  SessionRegistry,
  createEchoAdapter,
  type SessionState as PairingBridgeSessionState,
} from "@openscout/agent-sessions";
import type {
  ActorIdentity,
  AgentCapability,
  AgentClass,
  AgentDefinition,
  AgentEndpoint,
  AgentHarness,
  ConversationDefinition,
  DeliveryIntent,
  MessageRecord,
  NodeDefinition,
  ShareMode,
  VisibilityScope,
} from "@openscout/protocol";
import { DEFAULT_BROKER_HOST, buildDefaultBrokerUrl } from "../broker-process-manager";

const runtimeDir = join(import.meta.dir, "..", "..");
const scenarioAttributionAudiences = new Map<string, string>();

export type ScenarioBroker = {
  baseUrl: string;
  controlHome: string;
  nodeId: string;
  child: ReturnType<typeof Bun.spawn>;
  attributionKey: string;
};

type PairingBridgeSession = {
  id: string;
  name: string;
  adapterType: string;
  status: "connecting" | "active" | "idle" | "error" | "closed";
  cwd?: string;
  model?: string;
  providerMeta?: Record<string, unknown>;
  adapterBacked?: boolean;
  /** Synthetic response for a non-adapter fixture; never invokes a harness. */
  response?: string;
  adapterOptions?: Record<string, unknown>;
};

export type ScenarioActorInput = {
  id: string;
  kind?: ActorIdentity["kind"];
  displayName?: string;
  handle?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
};

export type ScenarioAgentInput = {
  id: string;
  definitionId?: string;
  displayName?: string;
  handle?: string;
  selector?: string;
  defaultSelector?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  agentClass?: AgentClass;
  capabilities?: AgentCapability[];
  wakePolicy?: AgentDefinition["wakePolicy"];
  homeNodeId?: string;
  authorityNodeId?: string;
  advertiseScope?: AgentDefinition["advertiseScope"];
  harness?: AgentHarness;
  transport?: AgentEndpoint["transport"];
  endpointId?: string;
  endpointNodeId?: string;
  endpointState?: AgentEndpoint["state"];
  sessionId?: string;
  projectRoot?: string;
  cwd?: string;
  branch?: string;
  workspaceQualifier?: string;
  endpointMetadata?: Record<string, unknown>;
};

export type ScenarioConversationInput = {
  id: string;
  kind: ConversationDefinition["kind"];
  title: string;
  visibility?: VisibilityScope;
  shareMode?: ShareMode;
  authorityNodeId?: string;
  participantIds: string[];
  metadata?: Record<string, unknown>;
};

export type ScenarioMessageInput = {
  id: string;
  conversationId: string;
  actorId: string;
  body: string;
  originNodeId?: string;
  class?: MessageRecord["class"];
  mentions?: MessageRecord["mentions"];
  audience?: MessageRecord["audience"];
  visibility?: MessageRecord["visibility"];
  policy?: MessageRecord["policy"];
  createdAt?: number;
  metadata?: MessageRecord["metadata"];
};

async function allocateFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a free port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.once("error", reject);
  });
}

function defaultTransportForHarness(harness: AgentHarness | undefined): AgentEndpoint["transport"] | undefined {
  switch (harness) {
    case "codex":
      return "codex_app_server";
    case "claude":
      return "claude_stream_json";
    default:
      return undefined;
  }
}

function directConversationIdForActors(sourceId: string, targetId: string): string {
  if (sourceId === targetId) {
    return `dm.${sourceId}`;
  }
  if (sourceId === "operator" || targetId === "operator") {
    const peerId = sourceId === "operator" ? targetId : sourceId;
    return `dm.operator.${peerId}`;
  }
  return `dm.${[sourceId, targetId].sort().join(".")}`;
}

/** Listener health is recovery-safe, not permission to mutate. Keep the
 * existing six-second startup budget and wait for the advertised capability. */
export async function waitForScenarioMutationReady(baseUrl: string, deps: {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
} = {}): Promise<void> {
  const read = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? Bun.sleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + 6_000;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      const response = await read(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - now()))),
      });
      if (response.ok) {
        const health = await response.json() as {
          ok?: boolean;
          startup?: { state?: string; mutationsAdmitted?: boolean; phase?: string };
        };
        if (health?.ok === true && health.startup?.state === "ready" && health.startup.mutationsAdmitted === true) return;
        lastError = new Error(`broker mutations not ready: ${health?.startup?.state ?? "missing startup"}/${health?.startup?.phase ?? "unknown phase"}`);
      } else {
        lastError = new Error(`health returned ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    if (now() < deadline) await sleep(Math.min(100, deadline - now()));
  }
  throw new Error("broker did not admit mutations within 6000ms", { cause: lastError });
}

export class RuntimeScenarioHarness {
  private readonly brokers = new Set<ScenarioBroker>();
  private readonly servers = new Set<ReturnType<typeof Bun.serve>>();
  private readonly pairingRegistries = new Set<SessionRegistry>();
  private readonly tempRoots = new Set<string>();

  async dispose(): Promise<void> {
    for (const broker of this.brokers) {
      broker.child.kill();
      await broker.child.exited.catch(() => undefined);
      rmSync(broker.controlHome, { recursive: true, force: true });
    }
    this.brokers.clear();

    for (const server of this.servers) {
      server.stop(true);
    }
    this.servers.clear();

    for (const registry of this.pairingRegistries) {
      await registry.shutdown().catch(() => undefined);
    }
    this.pairingRegistries.clear();

    for (const root of this.tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    this.tempRoots.clear();
  }

  async startBroker(input: {
    controlHome?: string;
    env?: Record<string, string | undefined>;
  } = {}): Promise<ScenarioBroker> {
    const controlHome = input.controlHome ?? mkdtempSync(join(tmpdir(), "openscout-runtime-scenario-"));
    const brokerSocketPath = input.env?.OPENSCOUT_BROKER_SOCKET_PATH ?? join(controlHome, "broker.sock");
    const port = await allocateFreePort();
    const baseUrl = buildDefaultBrokerUrl(DEFAULT_BROKER_HOST, port);
    const derivedNodeId = `node-${basename(controlHome).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
    const attributionKey = randomBytes(32).toString("hex");
    writeFileSync(join(controlHome, "attribution-key"), attributionKey, { mode: 0o600 });
    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/broker-daemon.ts"],
      cwd: runtimeDir,
      env: {
        ...process.env,
        OPENSCOUT_CONTROL_HOME: controlHome,
        // NODE_ENV=test is inherited by the real daemon. Its user-data guard
        // requires this explicit redirect even when HOME is already temporary.
        OPENSCOUT_SUPPORT_DIRECTORY: join(controlHome, "support"),
        OPENSCOUT_BROKER_HOST: DEFAULT_BROKER_HOST,
        OPENSCOUT_BROKER_PORT: String(port),
        OPENSCOUT_BROKER_URL: baseUrl,
        OPENSCOUT_BROKER_SOCKET_PATH: brokerSocketPath,
        OPENSCOUT_NODE_ID: derivedNodeId,
        OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS: "0",
        // Same daemon, same leak: "0" disables the parent watcher
        // (broker-daemon.ts only arms it for parentPid > 0), so a broker spawned
        // here outlives a SIGKILLed runner exactly as one spawned by
        // broker-daemon-harness did. `afterEach` never runs on SIGKILL.
        OPENSCOUT_PARENT_PID: String(process.pid),
        // A supervisor pins the instance on what it launches; unpinned, a
        // broker run from this checkout would take the dev default.
        OPENSCOUT_INSTANCE: "prod",
        OPENSCOUT_ATTRIBUTION_KEY_FILE: join(controlHome, "attribution-key"),
        ...input.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Retain cleanup custody even if readiness fails before startBroker returns.
    const broker = { baseUrl, controlHome, nodeId: derivedNodeId, child, attributionKey };
    this.brokers.add(broker);
    await waitForScenarioMutationReady(baseUrl);
    const node = await this.get<NodeDefinition>(baseUrl, "/v1/node");
    broker.nodeId = node.id;
    return broker;
  }

  startHangingPeerServer(): string {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    this.servers.add(server);
    return `http://127.0.0.1:${server.port}`;
  }

  async startPairingBridgeServer(input: {
    sessions: PairingBridgeSession[];
    adapterBackedTypes?: string[];
  }): Promise<{ port: number }> {
    const adapterBackedTypes = new Set([
      ...(input.adapterBackedTypes ?? []),
      ...input.sessions
        .filter((session) => session.adapterBacked)
        .map((session) => session.adapterType),
    ]);
    const registry = adapterBackedTypes.size > 0
      ? new SessionRegistry({
        adapters: {
          echo: createEchoAdapter,
        },
      })
      : null;
    if (registry) {
      this.pairingRegistries.add(registry);
    }

    const sessions = new Map<string, PairingBridgeSessionState>();

    for (const inputSession of input.sessions) {
      if (inputSession.adapterBacked) {
        if (!registry) {
          throw new Error("adapter-backed session requested without a registry");
        }
        await registry.createSession(inputSession.adapterType, {
          sessionId: inputSession.id,
          name: inputSession.name,
          cwd: inputSession.cwd,
          options: inputSession.adapterOptions,
        });
        continue;
      }

      sessions.set(inputSession.id, {
        session: inputSession,
        turns: [],
        currentTurnId: undefined,
      });
    }

    const listSessions = () => [
      ...sessions.values().map((entry) => entry.session),
      ...(registry?.listSessions() ?? []),
    ];

    const sessionSnapshot = (sessionId: string) => {
      return sessions.get(sessionId) ?? registry?.getSessionSnapshot(sessionId) ?? null;
    };

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, upgradedServer) {
        if (new URL(request.url).pathname === "/health") return Response.json({ mode: "plaintext" });
        if (upgradedServer.upgrade(request)) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          let requestId: number | null = null;
          void (async () => {
            const payload = JSON.parse(String(message)) as {
              id?: number;
              method?: string;
              params?: { path?: string; input?: Record<string, unknown> };
            };
            requestId = payload.id ?? null;
            const path = payload.params?.path;

            const respond = (body: unknown) => {
              ws.send(JSON.stringify({
                id: requestId,
                jsonrpc: "2.0",
                ...body,
              }));
            };

            if (!path) {
              respond({ error: { message: "unsupported" } });
              return;
            }

            if (payload.method === "query" && path === "session.list") {
              respond({
                result: {
                  type: "data",
                  data: listSessions(),
                },
              });
              return;
            }

            if (payload.method === "query" && path === "session.snapshot") {
              const sessionId = typeof payload.params?.input?.sessionId === "string"
                ? payload.params.input.sessionId
                : "";
              const snapshot = sessionSnapshot(sessionId);
              if (!snapshot) {
                respond({ error: { message: `unknown session ${sessionId}` } });
                return;
              }
              respond({
                result: {
                  type: "data",
                  data: snapshot,
                },
              });
              return;
            }

            if (payload.method === "mutation" && path === "prompt.send") {
              const inputValue = payload.params?.input ?? {};
              const sessionId = typeof inputValue.sessionId === "string" ? inputValue.sessionId : "";
              const text = typeof inputValue.text === "string" ? inputValue.text : "";
              const snapshot = sessionSnapshot(sessionId);
              if (!snapshot) {
                respond({ error: { message: `unknown session ${sessionId}` } });
                return;
              }

              if (registry?.getSessionSnapshot(sessionId)) {
                registry.send({ sessionId, text });
              } else {
                const turnId = `turn-${snapshot.turns.length + 1}`;
                const now = Date.now();
                snapshot.turns.push({
                  id: turnId,
                  status: "completed",
                  startedAt: now,
                  endedAt: now,
                  blocks: [
                    {
                      status: "completed",
                      block: {
                        id: `${turnId}-text`,
                        turnId,
                        type: "text",
                        status: "completed",
                        index: 0,
                        text: input.sessions.find(session => session.id === sessionId)?.response ?? `Echo: ${text}`,
                      },
                    },
                  ],
                });
                snapshot.currentTurnId = undefined;
              }

              respond({
                result: {
                  type: "data",
                  data: { ok: true },
                },
              });
              return;
            }

            if (payload.method === "mutation" && path === "session.create") {
              const inputValue = payload.params?.input ?? {};
              const adapterType = typeof inputValue.adapterType === "string" ? inputValue.adapterType : "codex";
              const name = typeof inputValue.name === "string" ? inputValue.name : `${adapterType} attached`;
              const cwd = typeof inputValue.cwd === "string" ? inputValue.cwd : undefined;
              const options = typeof inputValue.options === "object" && inputValue.options
                ? inputValue.options as Record<string, unknown>
                : {};
              const threadId = typeof options.threadId === "string"
                ? options.threadId
                : `thread-${listSessions().length + 1}`;
              const sessionId = `pairing-${threadId.slice(0, 8)}`;

              if (registry && adapterBackedTypes.has(adapterType)) {
                const session = await registry.createSession(adapterType, {
                  sessionId,
                  name,
                  cwd,
                  options,
                });
                respond({
                  result: {
                    type: "data",
                    data: session,
                  },
                });
                return;
              }

              const session = {
                id: sessionId,
                name,
                adapterType,
                status: "idle" as const,
                cwd,
                providerMeta: {
                  threadId,
                },
              };
              sessions.set(sessionId, {
                session,
                turns: [],
                currentTurnId: undefined,
              });
              respond({
                result: {
                  type: "data",
                  data: session,
                },
              });
              return;
            }

            respond({ error: { message: `unsupported path ${path}` } });
          })().catch((error) => {
            ws.send(JSON.stringify({
              id: requestId,
              jsonrpc: "2.0",
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }));
          });
        },
      },
    });

    this.servers.add(server);
    return { port: server.port };
  }

  configurePairingHome(port: number): string {
    const home = mkdtempSync(join(tmpdir(), "openscout-pairing-home-"));
    this.tempRoots.add(home);
    const pairingRoot = join(home, ".scout", "pairing");
    mkdirSync(pairingRoot, { recursive: true });
    writeFileSync(join(pairingRoot, "config.json"), JSON.stringify({ port, secure: false }), "utf8");
    writeFileSync(join(pairingRoot, "runtime.json"), JSON.stringify({ status: "paired" }), "utf8");
    return home;
  }

  async post<T>(brokerOrBaseUrl: ScenarioBroker | string, path: string, body: unknown): Promise<T> {
    const baseUrl = typeof brokerOrBaseUrl === "string" ? brokerOrBaseUrl : brokerOrBaseUrl.baseUrl;
    let attributionHeaders: Record<string, string> = {};
    if (typeof brokerOrBaseUrl !== "string") {
      let destinationKeyId = scenarioAttributionAudiences.get(baseUrl);
      if (!destinationKeyId) {
        const node = await this.get<{ card: { keyId: string } }>(brokerOrBaseUrl, "/v1/node");
        destinationKeyId = node.card.keyId;
        scenarioAttributionAudiences.set(baseUrl, destinationKeyId);
      }
      attributionHeaders = signLocalAdminRequest(brokerOrBaseUrl.attributionKey, {
        method: "POST", path, body: JSON.stringify(body), destinationKeyId,
      });
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...attributionHeaders,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  async get<T>(brokerOrBaseUrl: ScenarioBroker | string, path: string): Promise<T> {
    const baseUrl = typeof brokerOrBaseUrl === "string" ? brokerOrBaseUrl : brokerOrBaseUrl.baseUrl;
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  async request(
    brokerOrBaseUrl: ScenarioBroker | string,
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    const baseUrl = typeof brokerOrBaseUrl === "string" ? brokerOrBaseUrl : brokerOrBaseUrl.baseUrl;
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    return {
      status: response.status,
      ok: response.ok,
      body,
    };
  }

  async snapshot<T extends Record<string, unknown>>(broker: ScenarioBroker): Promise<T> {
    return this.get<T>(broker, "/v1/snapshot");
  }

  async listMessages(broker: ScenarioBroker, conversationId: string): Promise<MessageRecord[]> {
    return this.get<MessageRecord[]>(
      broker,
      `/v1/messages?conversationId=${encodeURIComponent(conversationId)}`,
    );
  }

  async listDeliveries(
    broker: ScenarioBroker,
    filters: { transport?: DeliveryIntent["transport"]; status?: DeliveryIntent["status"] } = {},
  ): Promise<DeliveryIntent[]> {
    const search = new URLSearchParams();
    if (filters.transport) search.set("transport", filters.transport);
    if (filters.status) search.set("status", filters.status);
    const suffix = search.toString();
    return this.get<DeliveryIntent[]>(broker, `/v1/deliveries${suffix ? `?${suffix}` : ""}`);
  }

  async listEvents<T = Record<string, unknown>>(broker: ScenarioBroker, limit = 100): Promise<T[]> {
    return this.get<T[]>(broker, `/v1/events?limit=${limit}`);
  }

  async registerNode(broker: ScenarioBroker, input: Partial<NodeDefinition> & Pick<NodeDefinition, "id">): Promise<void> {
    await this.post(broker, "/v1/nodes", {
      meshId: "openscout",
      name: input.id,
      advertiseScope: "local",
      registeredAt: Date.now(),
      ...input,
    });
  }

  async registerActor(broker: ScenarioBroker, input: ScenarioActorInput): Promise<void> {
    await this.post(broker, "/v1/actors", {
      id: input.id,
      kind: input.kind ?? "person",
      displayName: input.displayName ?? input.id,
      handle: input.handle,
      labels: input.labels ?? ["scenario"],
      metadata: {
        source: "scenario",
        ...(input.metadata ?? {}),
      },
    } satisfies ActorIdentity);
  }

  async seedOperator(broker: ScenarioBroker, input: Omit<ScenarioActorInput, "id" | "kind"> & { id?: string } = {}): Promise<void> {
    await this.registerActor(broker, {
      id: input.id ?? "operator",
      kind: "person",
      displayName: input.displayName ?? "Operator",
      handle: input.handle ?? "operator",
      labels: input.labels,
      metadata: input.metadata,
    });
  }

  async registerAgent(broker: ScenarioBroker, input: ScenarioAgentInput): Promise<{
    actor: ActorIdentity;
    agent: AgentDefinition;
    endpoint: AgentEndpoint | null;
  }> {
    const definitionId = input.definitionId ?? input.id;
    const displayName = input.displayName ?? input.id;
    const handle = input.handle ?? definitionId;
    const selector = input.selector ?? `@${handle}`;
    const metadata = {
      source: "scenario",
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.workspaceQualifier ? { workspaceQualifier: input.workspaceQualifier } : {}),
      ...(input.metadata ?? {}),
    };

    const actor: ActorIdentity = {
      id: input.id,
      kind: "agent",
      displayName,
      handle,
      labels: input.labels ?? ["scenario"],
      metadata,
    };
    await this.post(broker, "/v1/actors", actor);

    const agent: AgentDefinition = {
      id: input.id,
      kind: "agent",
      definitionId,
      displayName,
      handle,
      selector,
      defaultSelector: input.defaultSelector ?? selector,
      labels: input.labels ?? ["scenario"],
      metadata,
      agentClass: input.agentClass ?? "general",
      capabilities: input.capabilities ?? ["chat", "invoke", "deliver"],
      wakePolicy: input.wakePolicy ?? "on_demand",
      homeNodeId: input.homeNodeId ?? input.authorityNodeId ?? broker.nodeId,
      authorityNodeId: input.authorityNodeId ?? broker.nodeId,
      advertiseScope: input.advertiseScope ?? "local",
    };
    await this.post(broker, "/v1/agents", agent);

    const harness = input.harness;
    const transport = input.transport ?? defaultTransportForHarness(harness);
    if (!harness || !transport) {
      return { actor, agent, endpoint: null };
    }

    const endpoint: AgentEndpoint = {
      id: input.endpointId ?? `endpoint.${input.id}`,
      agentId: input.id,
      nodeId: input.endpointNodeId ?? broker.nodeId,
      harness,
      transport,
      state: input.endpointState ?? "idle",
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      metadata: {
        source: "scenario",
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.workspaceQualifier ? { workspaceQualifier: input.workspaceQualifier } : {}),
        ...(input.endpointMetadata ?? {}),
      },
    };
    await this.post(broker, "/v1/endpoints", endpoint);
    return { actor, agent, endpoint };
  }

  async registerConversation(
    broker: ScenarioBroker,
    input: ScenarioConversationInput,
  ): Promise<ConversationDefinition> {
    const conversation: ConversationDefinition = {
      id: input.id,
      kind: input.kind,
      title: input.title,
      visibility: input.visibility ?? "private",
      shareMode: input.shareMode ?? "local",
      authorityNodeId: input.authorityNodeId ?? broker.nodeId,
      participantIds: [...input.participantIds].sort(),
      metadata: {
        surface: "scenario",
        ...(input.metadata ?? {}),
      },
    };
    await this.post(broker, "/v1/conversations", conversation);
    return conversation;
  }

  async ensureDirectConversation(
    broker: ScenarioBroker,
    input: {
      sourceId: string;
      targetId: string;
      conversationId?: string;
      title?: string;
      visibility?: VisibilityScope;
      shareMode?: ShareMode;
      authorityNodeId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ConversationDefinition> {
    const participantIds = [...new Set([input.sourceId, input.targetId])].sort();
    return this.registerConversation(broker, {
      id: input.conversationId ?? directConversationIdForActors(input.sourceId, input.targetId),
      kind: "direct",
      title: input.title ?? `${input.sourceId} <> ${input.targetId}`,
      visibility: input.visibility ?? "private",
      shareMode: input.shareMode ?? "local",
      authorityNodeId: input.authorityNodeId ?? broker.nodeId,
      participantIds,
      metadata: input.metadata,
    });
  }

  async postMessage(
    broker: ScenarioBroker,
    input: ScenarioMessageInput,
  ): Promise<{ ok: boolean; message: MessageRecord; deliveries?: DeliveryIntent[]; mesh?: Record<string, unknown> }> {
    const message: MessageRecord = {
      id: input.id,
      conversationId: input.conversationId,
      actorId: input.actorId,
      originNodeId: input.originNodeId ?? broker.nodeId,
      class: input.class ?? "agent",
      body: input.body,
      mentions: input.mentions,
      audience: input.audience,
      visibility: input.visibility ?? "private",
      policy: input.policy ?? "durable",
      createdAt: input.createdAt ?? Date.now(),
      metadata: input.metadata,
    };
    return this.post(broker, "/v1/messages", message);
  }

  async waitFor<T>(
    load: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = 4_000,
  ): Promise<T> {
    const startedAt = Date.now();
    let last: T | undefined;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        last = await load();
        if (predicate(last)) {
          return last;
        }
      } catch {
        // Broker bootstrap can lag slightly during scenario setup.
      }
      await Bun.sleep(100);
    }

    if (last !== undefined) {
      return last;
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms.`);
  }


}

export function runtimeScenario(
  name: string,
  run: (scenario: RuntimeScenarioHarness) => Promise<void>,
  timeoutMs = 20_000,
): void {
  test(name, async () => {
    const scenario = new RuntimeScenarioHarness();
    try {
      await run(scenario);
    } finally {
      await scenario.dispose();
    }
  }, timeoutMs);
}
