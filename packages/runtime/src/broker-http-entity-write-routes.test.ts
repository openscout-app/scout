import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import {
  handleBrokerHttpEntityWriteRoute,
  type BrokerHttpEntityWriteRouteDeps,
} from "./broker-http-entity-write-routes.js";
import { ThreadWatchProtocolError } from "./thread-events.js";

class FakeResponse extends EventEmitter {
  body = "";
  headers: Record<string, string> | undefined;
  status: number | undefined;
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.writableEnded = true;
  }
}

function createHarness(overrides: Partial<BrokerHttpEntityWriteRouteDeps> = {}) {
  const commands: unknown[] = [];
  const flights: unknown[] = [];
  const deps = {
    brokerService: {
      executeCommand: async (command: unknown) => {
        commands.push(command);
        return { ok: true, command };
      },
      openThreadWatch: async (body: unknown) => ({ ok: true, watchId: "watch-1", body }),
      renewThreadWatch: async (body: unknown) => ({ ok: true, watchId: "watch-1", body }),
      closeThreadWatch: async (body: unknown) => ({ ok: true, watchId: "watch-1", body }),
    },
    recordFlight: async (flight: unknown) => {
      flights.push(flight);
    },
    ...overrides,
  } as unknown as BrokerHttpEntityWriteRouteDeps;

  return {
    commands,
    deps,
    flights,
  };
}

async function requestRoute(
  deps: BrokerHttpEntityWriteRouteDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ handled: boolean; body: unknown; response: FakeResponse }> {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    method: string;
    url: string;
  };
  request.headers = { host: "broker.test" };
  request.method = method;
  request.url = path;
  const response = new FakeResponse();

  const handled = handleBrokerHttpEntityWriteRoute({
    method,
    url: new URL(path, "http://broker.test"),
    request: request as never,
    response: response as never,
    deps,
  });
  request.end(body === undefined ? undefined : JSON.stringify(body));

  return {
    handled: await handled,
    body: response.body ? JSON.parse(response.body) : null,
    response,
  };
}

describe("handleBrokerHttpEntityWriteRoute", () => {
  test("returns false for routes outside the entity write surface", async () => {
    const harness = createHarness();
    const result = await requestRoute(harness.deps, "GET", "/v1/nodes");

    expect(result.handled).toBe(false);
    expect(result.response.status).toBeUndefined();
  });

  test("upserts agents through the canonical command path", async () => {
    const harness = createHarness();
    const agent = {
      id: "agent-1",
      displayName: "Agent 1",
      authorityNodeId: "node-1",
    };

    const result = await requestRoute(harness.deps, "POST", "/v1/agents", agent);

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ ok: true, agentId: "agent-1" });
    expect(harness.commands).toEqual([{ kind: "agent.upsert", agent }]);
  });

  test("records flights through the supplied durable write dependency", async () => {
    const harness = createHarness();
    const flight = {
      id: "flight-1",
      invocationId: "invocation-1",
      targetAgentId: "agent-1",
      state: "queued",
      createdAt: 100,
      updatedAt: 100,
    };

    const result = await requestRoute(harness.deps, "POST", "/v1/flights", flight);

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ ok: true, flightId: "flight-1" });
    expect(harness.flights).toEqual([{ ...flight, requesterId: "operator", metadata: {
      attribution: { actorId: "operator", rootActorId: "operator", source: "system" },
    } }]);
  });

  test("records flight mirrors through the authenticated mesh route", async () => {
    const harness = createHarness();
    const flight = {
      id: "flight-mesh-1",
      invocationId: "invocation-mesh-1",
      targetAgentId: "agent-1",
      state: "completed",
      createdAt: 100,
      updatedAt: 200,
    };

    const result = await requestRoute(harness.deps, "POST", "/v1/mesh/flights", flight);

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ ok: true, flightId: "flight-mesh-1" });
    expect(harness.flights).toEqual([{ ...flight, requesterId: "local-unverified", metadata: {
      attribution: { actorId: "local-unverified", rootActorId: "local-unverified", source: "unverified" },
    } }]);
  });

  test("maps thread watch protocol errors through the thread-watch response shape", async () => {
    const harness = createHarness({
      brokerService: {
        executeCommand: async () => ({ ok: true }),
        openThreadWatch: async () => {
          throw new ThreadWatchProtocolError(403, {
            error: "not_authorized",
            message: "denied",
          });
        },
      },
    } as Partial<BrokerHttpEntityWriteRouteDeps>);

    const result = await requestRoute(harness.deps, "POST", "/v1/thread-watches/open", {
      conversationId: "conversation-1",
    });

    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(403);
    expect(result.body).toEqual({ error: "not_authorized", message: "denied" });
  });

  test("reports malformed JSON as a bad request for handled routes", async () => {
    const harness = createHarness();
    const request = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
      method: string;
      url: string;
    };
    request.headers = { host: "broker.test" };
    request.method = "POST";
    request.url = "/v1/actors";
    const response = new FakeResponse();

    const handled = handleBrokerHttpEntityWriteRoute({
      method: "POST",
      url: new URL("/v1/actors", "http://broker.test"),
      request: request as never,
      response: response as never,
      deps: harness.deps,
    });
    request.end("{bad-json");

    expect(await handled).toBe(true);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: "bad_request" });
  });
});
