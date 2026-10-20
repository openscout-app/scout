import { signLocalAdminRequest } from "../mesh-access-local-auth.js";
import { randomBytes } from "node:crypto";
import { afterEach, expect } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  CHAT_ID_PREFIX,
  type InvocationRequest,
  type FlightRecord,
  type RuntimeSnapshot,
  directChannelNaturalKey,
  isOpaqueChannelId,
  namedChannelNaturalKey,
} from "@openscout/protocol";

import { DEFAULT_BROKER_HOST, buildDefaultBrokerUrl } from "../broker-process-manager";

const runtimeDir = join(import.meta.dir, "..", "..");

export type BrokerHarness = {
  baseUrl: string;
  controlHome: string;
  nodeId: string;
  child: ReturnType<typeof Bun.spawn>;
  outputDrain: Promise<void>[];
  localAdminKey?: string;
};

export type TestConversationIdentity = {
  id: string;
  metadata?: Record<string, unknown>;
  participantIds?: string[];
};

// A port the OS just confirmed free. A random pick in 38000-40000 sat inside
// Linux's ephemeral range, so CI runners' own outgoing connections took it.
function freePort(): number {
  const probe = Bun.serve({ hostname: DEFAULT_BROKER_HOST, port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
}

export function createBrokerDaemonTestHarness() {
  function expectOpaqueDirectConversation(
    conversation: TestConversationIdentity | undefined,
    input: {
      participantIds: string[];
    },
  ): void {
    expect(conversation?.id.startsWith(CHAT_ID_PREFIX)).toBe(true);
    expect(isOpaqueChannelId(conversation?.id)).toBe(true);
    expect(conversation?.metadata?.naturalKey).toBe(directChannelNaturalKey(input.participantIds));
    expect(conversation?.metadata?.legacyId).toBeUndefined();
    expect(conversation?.metadata?.legacyConversationId).toBeUndefined();
    expect(conversation?.participantIds).toEqual([...input.participantIds].sort());
  }

  function expectOpaqueNamedConversation(
    conversation: TestConversationIdentity | undefined,
    input: {
      channel: string;
      participantIds: string[];
    },
  ): void {
    expect(conversation?.id.startsWith(CHAT_ID_PREFIX)).toBe(true);
    expect(isOpaqueChannelId(conversation?.id)).toBe(true);
    expect(conversation?.metadata?.channel).toBe(input.channel);
    expect(conversation?.metadata?.naturalKey).toBe(namedChannelNaturalKey(input.channel));
    expect(conversation?.metadata?.legacyId).toBeUndefined();
    expect(conversation?.metadata?.legacyConversationId).toBeUndefined();
    expect(conversation?.participantIds).toEqual([...input.participantIds].sort());
  }

  const harnesses = new Set<BrokerHarness>();
  const adminKeys = new Map<string, string>();
  const brokerKeys = new Map<string, string>();
  const adminHeaders = async (url: string, method: string, path: string, body?: string): Promise<Record<string, string>> => {
    if (!adminKeys.has(url)) return {};
    if (!brokerKeys.has(url)) {
      const response = await fetch(url + "/v1/node");
      const node = await response.json() as { card: { keyId: string } };
      brokerKeys.set(url, node.card.keyId);
    }
    return signLocalAdminRequest(adminKeys.get(url)!, { method, path, body, destinationKeyId: brokerKeys.get(url)! });
  };
  const hangingServers = new Set<ReturnType<typeof Bun.serve>>();
  const pairingHomes = new Set<string>();
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    for (const harness of harnesses) {
      harness.child.kill();
      const exited = await Promise.race([
        harness.child.exited.then(() => true).catch(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        harness.child.kill("SIGKILL");
        await harness.child.exited.catch(() => {});
      }
      await Promise.all(harness.outputDrain);
      rmSync(harness.controlHome, { recursive: true, force: true });
    }
    harnesses.clear();
    for (const server of hangingServers) {
      server.stop(true);
    }
    hangingServers.clear();
    for (const home of pairingHomes) {
      rmSync(home, { recursive: true, force: true });
    }
    pairingHomes.clear();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.clear();
  });

  async function startBroker(input: {
    controlHome?: string;
    env?: Record<string, string | undefined>;
    waitForMutationReady?: boolean;
    protectedLocal?: boolean;
    preload?: string;
  } = {}): Promise<BrokerHarness> {
    const controlHome = input.controlHome ?? mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const port = freePort();
    const baseUrl = buildDefaultBrokerUrl(DEFAULT_BROKER_HOST, port);
    const localAdminKey = input.protectedLocal ? randomBytes(32).toString("hex") : undefined;
    const adminKeyFile = join(controlHome, "admin-key");
    if (localAdminKey) { writeFileSync(adminKeyFile, localAdminKey, { mode: 0o600 }); adminKeys.set(baseUrl, localAdminKey); }
    const derivedNodeId = `node-${basename(controlHome).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
    const child = Bun.spawn({
      cmd: ["bun", "run", "--preload", join(import.meta.dir, "broker-storage-preload.ts"),
        ...(input.preload ? ["--preload", input.preload] : []), "src/broker-daemon.ts"],
      cwd: runtimeDir,
      env: {
        ...process.env,
        OPENSCOUT_CONTROL_HOME: controlHome,
        OPENSCOUT_BROKER_HOST: DEFAULT_BROKER_HOST,
        OPENSCOUT_ADVERTISE_SCOPE: "local",
        OPENSCOUT_LOCAL_ADMIN_KEY_FILE: undefined,
        OPENSCOUT_BROKER_PORT: String(port),
        OPENSCOUT_BROKER_URL: baseUrl,
        OPENSCOUT_BROKER_SOCKET_PATH: join(controlHome, "broker.sock"),
        OPENSCOUT_PROBES_SOCKET: join(controlHome, "missing-probes.sock"),
        OPENSCOUT_NODE_ID: derivedNodeId,
        OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS: "0",
        OPENSCOUT_RELAY_HUB: join(controlHome, "relay"),
        OPENSCOUT_SUPPORT_DIRECTORY: join(controlHome, "support"),
        // Arm the daemon's parent watcher (broker-daemon.ts) with the test runner's pid so a
        // leaked broker exits on its own within ~2s. `afterEach` cleanup never runs when the
        // runner is SIGKILLed, which once stranded 26 live test brokers for four days.
        OPENSCOUT_PARENT_PID: String(process.pid),
        // A supervisor pins the instance on what it launches; unpinned, a
        // broker run from this checkout would take the dev default.
        OPENSCOUT_INSTANCE: "prod",
        ...input.env,
        ...(localAdminKey ? { OPENSCOUT_LOCAL_ADMIN_KEY_FILE: adminKeyFile } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let outputTail = "";
    const retainOutput = (text: string) => { outputTail = (outputTail + text).slice(-16_384); };
    const outputDrain = [drainProcessOutput(child.stdout, retainOutput), drainProcessOutput(child.stderr, retainOutput)];

    try {
      await waitForHealth(baseUrl, input.waitForMutationReady !== false);
    } catch (error) {
      child.kill();
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
      if (!exited) { child.kill("SIGKILL"); await child.exited; }
      await Promise.all(outputDrain);
      temporaryDirectories.add(controlHome);
      throw new Error(`Owned broker failed startup: ${String(error)}\n${outputTail}`);
    }
    const node = await getJson<{ id: string }>(baseUrl, "/v1/node");
    const harness = { baseUrl, controlHome, nodeId: node.id, child, outputDrain, localAdminKey };
    harnesses.add(harness);
    return harness;
  }

  function writeRelayAgentRegistry(
    supportDirectory: string,
    agents: Record<string, unknown>,
  ): void {
    mkdirSync(supportDirectory, { recursive: true });
    writeFileSync(join(supportDirectory, "rpc-runtime-cutover-v1"), "test\n", "utf8");
    writeFileSync(
      join(supportDirectory, "relay-agents.json"),
      `${JSON.stringify({ version: 1, agents }, null, 2)}\n`,
      "utf8",
    );
  }

  function writeFakeTmuxBin(binDirectory: string): string {
    mkdirSync(binDirectory, { recursive: true });
    const logPath = join(binDirectory, "tmux.log");
    const tmuxPath = join(binDirectory, "tmux");
    writeFileSync(
      tmuxPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "cmd=\"${1:-}\"",
        "if [ $# -gt 0 ]; then shift; fi",
        "if [ -n \"${OPENSCOUT_FAKE_TMUX_LOG:-}\" ]; then",
        "  printf '%s %s\\n' \"$cmd\" \"$*\" >> \"$OPENSCOUT_FAKE_TMUX_LOG\"",
        "fi",
        "case \"$cmd\" in",
        "  has-session)",
        "    exit 0",
        "    ;;",
        "  capture-pane)",
        // Simulate the Claude activity marker that appears after a submitted
        // prompt. A permanently blank pane is ambiguous to dispatch verification
        // and correctly triggers the stalled-composer path.
        "    printf '● Working…\\n'",
        "    exit 0",
        "    ;;",
        "  list-sessions)",
        "    printf '%s|1|0|0\\n' \"${OPENSCOUT_FAKE_TMUX_SESSION:-relay-card-active-claude}\"",
        "    exit 0",
        "    ;;",
        "  load-buffer)",
        "    cat >/dev/null",
        "    exit 0",
        "    ;;",
        "  new-session)",
        "    printf '%%1\\n'",
        "    exit 0",
        "    ;;",
        "  paste-buffer|send-keys|delete-buffer|pipe-pane)",
        "    exit 0",
        "    ;;",
        "  *)",
        "    exit 0",
        "    ;;",
        "esac",
      ].join("\n") + "\n",
      "utf8",
    );
    chmodSync(tmuxPath, 0o755);
    return logPath;
  }

  async function drainProcessOutput(stream: ReadableStream<Uint8Array> | null, retain?: (text: string) => void): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        retain?.(decoder.decode(value, { stream: true }));
      }
    } catch {} finally { reader.releaseLock(); }
  }

  async function waitForHealth(baseUrl: string, waitForMutationReady: boolean): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/health`, { headers: await adminHeaders(baseUrl, "GET", "/health") });
        if (response.ok) {
          const health = await response.json() as {
            ok?: boolean;
            startup?: { state?: string; mutationsAdmitted?: boolean };
          };
          if (
            health.ok
            && (!waitForMutationReady
              || !health.startup
              || (health.startup.state === "ready" && health.startup.mutationsAdmitted === true))
          ) {
            return;
          }
          lastError = new Error("broker is alive but still restoring");
        } else {
          lastError = new Error(`health returned ${response.status}`);
        }
      } catch (error) {
        lastError = error;
      }
      await Bun.sleep(100);
    }
    throw lastError ?? new Error("broker did not become healthy");
  }

  async function waitFor<T>(
    load: () => Promise<T>,
    predicate: (value: T) => boolean,
    options: { attempts?: number; intervalMs?: number } = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 40;
    const intervalMs = options.intervalMs ?? 100;
    let last: T | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        last = await load();
        if (predicate(last)) {
          return last;
        }
      } catch {
        // Broker bootstrap is asynchronous after the HTTP listener comes up.
      }
      await Bun.sleep(intervalMs);
    }
    if (last !== undefined) {
      return last;
    }
    throw new Error("waitFor did not receive a value");
  }

  async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...await adminHeaders(baseUrl, "POST", path, JSON.stringify(body)),
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

  async function postJsonStatus(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...await adminHeaders(baseUrl, "POST", path, JSON.stringify(body)),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  async function getJson<T>(baseUrl: string, path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { ...await adminHeaders(baseUrl, "GET", path), accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  async function requestJson(baseUrl: string, path: string, init: RequestInit = {}): Promise<{
    status: number;
    ok: boolean;
    body: unknown;
  }> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...await adminHeaders(baseUrl, init.method ?? "GET", path, typeof init.body === "string" ? init.body : undefined),
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

  function startHangingPeerServer(): string {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    hangingServers.add(server);
    return `http://127.0.0.1:${server.port}`;
  }

  function startA2AResponder(
    handler: (body: Record<string, unknown>) => Record<string, unknown>,
  ): string {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          ...handler(body),
        });
      },
    });
    hangingServers.add(server);
    return `http://127.0.0.1:${server.port}/a2a`;
  }

  function startPairingBridgeServer(input: {
    sessions: Array<{
      id: string;
      name: string;
      adapterType: string;
      status: "connecting" | "active" | "idle" | "error" | "closed";
      cwd?: string;
      model?: string;
      providerMeta?: Record<string, unknown>;
    }>;
  }): { port: number } {
    const sessions = new Map(input.sessions.map((session) => [
      session.id,
      {
        session,
        turns: [],
        currentTurnId: undefined,
      },
    ]));

    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const payload = JSON.parse(String(message)) as {
            id?: number;
            method?: string;
            params?: { path?: string; input?: Record<string, unknown> };
          };
          const requestId = payload.id ?? null;
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
                data: [...sessions.values()].map((entry) => entry.session),
              },
            });
            return;
          }

          if (payload.method === "query" && path === "session.snapshot") {
            const sessionId = typeof payload.params?.input?.sessionId === "string"
              ? payload.params.input.sessionId
              : "";
            const snapshot = sessions.get(sessionId);
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
              : `thread-${sessions.size + 1}`;
            const sessionId = `pairing-${threadId.slice(0, 8)}`;
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

          if (payload.method === "mutation" && path === "prompt.send") {
            const inputValue = payload.params?.input ?? {};
            const sessionId = typeof inputValue.sessionId === "string" ? inputValue.sessionId : "";
            const text = typeof inputValue.text === "string" ? inputValue.text : "";
            const snapshot = sessions.get(sessionId);
            if (!snapshot) {
              respond({ error: { message: `unknown session ${sessionId}` } });
              return;
            }
            const turnId = `turn-${snapshot.turns.length + 1}`;
            const now = Date.now();
            snapshot.turns.push({
              id: turnId,
              status: "completed",
              blocks: [{
                status: "completed",
                block: {
                  id: `block-${turnId}`,
                  turnId,
                  status: "completed",
                  index: 0,
                  type: "text",
                  text: `Pairing reply: ${text.slice(0, 80)}`,
                },
              }],
              startedAt: now,
              endedAt: now,
            });
            snapshot.currentTurnId = turnId;
            respond({
              result: {
                type: "data",
                data: { ok: true },
              },
            });
            return;
          }

          respond({ error: { message: `unsupported path ${path}` } });
        },
      },
    });
    hangingServers.add(server);
    return { port: server.port };
  }

  function configurePairingHome(port: number): string {
    const home = mkdtempSync(join(tmpdir(), "openscout-pairing-home-"));
    pairingHomes.add(home);
    const pairingRoot = join(home, ".scout", "pairing");
    mkdirSync(pairingRoot, { recursive: true });
    writeFileSync(join(pairingRoot, "config.json"), JSON.stringify({ port, secure: false }), "utf8");
    writeFileSync(join(pairingRoot, "runtime.json"), JSON.stringify({ status: "paired" }), "utf8");
    return home;
  }

  function nextSseBlock(buffer: string): { block: string; rest: string } | null {
    const lfIndex = buffer.indexOf("\n\n");
    const crlfIndex = buffer.indexOf("\r\n\r\n");

    if (lfIndex === -1 && crlfIndex === -1) {
      return null;
    }

    if (crlfIndex === -1 || (lfIndex !== -1 && lfIndex < crlfIndex)) {
      return {
        block: buffer.slice(0, lfIndex),
        rest: buffer.slice(lfIndex + 2),
      };
    }

    return {
      block: buffer.slice(0, crlfIndex),
      rest: buffer.slice(crlfIndex + 4),
    };
  }

  async function waitForThreadEvent(
    baseUrl: string,
    watchId: string,
    predicate: (event: { id?: string; kind?: string; payload?: { message?: { id?: string } } }) => boolean,
    options: {
      triggerOnHello?: () => Promise<void>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ id?: string; kind?: string; payload?: { message?: { id?: string } } }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let matched: { id?: string; kind?: string; payload?: { message?: { id?: string } } } | null = null;
    let triggered = false;

    try {
      const response = await fetch(`${baseUrl}/v1/thread-watches/${encodeURIComponent(watchId)}/stream`, {
        headers: {
          ...await adminHeaders(baseUrl, "GET", `/v1/thread-watches/${encodeURIComponent(watchId)}/stream`),
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`/v1/thread-watches/${watchId}/stream returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const next = nextSseBlock(buffer);
          if (!next) {
            break;
          }
          buffer = next.rest;

          let eventName = "";
          const dataLines: string[] = [];
          for (const line of next.block.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
          }

          if (eventName === "hello" && options.triggerOnHello && !triggered) {
            triggered = true;
            await options.triggerOnHello();
            continue;
          }

          if (eventName !== "thread.event" || dataLines.length === 0) {
            continue;
          }

          const event = JSON.parse(dataLines.join("\n")) as {
            id?: string;
            kind?: string;
            payload?: { message?: { id?: string } };
          };
          if (predicate(event)) {
            matched = event;
            await reader.cancel();
            controller.abort();
            return event;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError" && matched)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (matched) {
      return matched;
    }
    throw new Error(`timed out waiting for thread event on watch ${watchId}`);
  }

  async function readInvocationStreamSnapshot(baseUrl: string, invocationId: string): Promise<{
    invocationId: string;
    invocation: { id: string; targetAgentId?: string } | null;
    flight: { id: string; invocationId: string; targetAgentId?: string; state?: string } | null;
    deliveries: unknown[];
    dispatches: unknown[];
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${baseUrl}/v1/invocations/${encodeURIComponent(invocationId)}/stream`, {
        headers: {
          ...await adminHeaders(baseUrl, "GET", `/v1/invocations/${encodeURIComponent(invocationId)}/stream`),
          accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`/v1/invocations/${invocationId}/stream returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const next = nextSseBlock(buffer);
          if (!next) {
            break;
          }
          buffer = next.rest;

          let eventName = "";
          const dataLines: string[] = [];
          for (const line of next.block.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
          }

          if (eventName === "snapshot" && dataLines.length > 0) {
            await reader.cancel();
            return JSON.parse(dataLines.join("\n")) as {
              invocationId: string;
              invocation: { id: string; targetAgentId?: string } | null;
              flight: { id: string; invocationId: string; targetAgentId?: string; state?: string } | null;
              deliveries: unknown[];
              dispatches: unknown[];
            };
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    throw new Error(`timed out waiting for invocation stream snapshot for ${invocationId}`);
  }

  async function seedHangingReceiver(harness: BrokerHarness, agentId: string) {
    // A real, owned receive route. Acceptance tests must not rely on card-only
    // wakePolicy: it does not prove a launcher or a reachable existing session.
    await postJson(harness.baseUrl, "/v1/endpoints", {
      id: `endpoint-test-${agentId}`, agentId, nodeId: harness.nodeId,
      harness: "http", transport: "http", state: "idle",
      address: `${startHangingPeerServer()}/a2a`, metadata: { source: "test" },
    });
  }

  async function seedQueuedInvocation(harness: BrokerHarness, invocation: InvocationRequest) {
    // Model an already accepted peer job; recovery must handle its temporarily
    // absent local endpoint without weakening fresh user-facing admission.
    const snapshot = await getJson<RuntimeSnapshot>(harness.baseUrl, "/v1/snapshot");
    const result = await postJson<{ flight: FlightRecord }>(harness.baseUrl, "/v1/mesh/invocations", {
      originNode: snapshot.nodes[harness.nodeId],
      actors: [snapshot.actors[invocation.requesterId]],
      agents: [snapshot.agents[invocation.targetAgentId]],
      ...(invocation.conversationId ? { conversation: snapshot.conversations[invocation.conversationId] } : {}),
      invocation,
    });
    return { accepted: true, invocationId: invocation.id, flightId: result.flight.id,
      targetAgentId: result.flight.targetAgentId, state: result.flight.state, flight: result.flight };
  }

  async function seedBasicConversation(harness: BrokerHarness) {
    await postJson(harness.baseUrl, "/v1/actors", {
      id: "operator",
      kind: "person",
      displayName: "Operator",
      handle: "operator",
      labels: ["test"],
      metadata: { source: "test" },
    });

    await postJson(harness.baseUrl, "/v1/agents", {
      id: "fabric",
      kind: "agent",
      definitionId: "fabric",
      displayName: "Fabric",
      handle: "fabric",
      labels: ["test"],
      selector: "@fabric",
      defaultSelector: "@fabric",
      metadata: { source: "test" },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local",
    });

    await postJson(harness.baseUrl, "/v1/conversations", {
      // Explicit historical fixture, not an implicit broadcast/default room.
      // Keep exercising old records: retirement must not require data migration.
      id: "channel.shared",
      kind: "channel",
      title: "shared",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: harness.nodeId,
      participantIds: ["operator", "fabric"],
      metadata: { surface: "test" },
    });
  }

  return {
    configurePairingHome,
    expectOpaqueDirectConversation,
    expectOpaqueNamedConversation,
    getJson,
    harnesses,
    postJson,
    postJsonStatus,
    readInvocationStreamSnapshot,
    requestJson,
    seedBasicConversation,
    seedHangingReceiver,
    seedQueuedInvocation,
    startA2AResponder,
    startBroker,
    startHangingPeerServer,
    startPairingBridgeServer,
    temporaryDirectories,
    waitFor,
    waitForThreadEvent,
    writeFakeTmuxBin,
    writeRelayAgentRegistry,
  };
}
