import { afterEach, expect, test } from "bun:test";

import { deliverDirectSessionInput } from "./session.ts";

const session = "session-direct-send";
const native = "0d4b8f7e-1c2a-4e3b-9f5d-6a7b8c9d0e1f";
const nodeId = "node-direct-send";
const endpoint = {
  id: "managed-worker", agentId: session, nodeId, harness: "claude", transport: "tmux",
  state: "active", sessionId: session, pane: "%17",
  metadata: { cardless: true, tmuxSession: session, externalSessionId: native },
};

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

/** A local broker that serves the bounded reads and records every request. */
function startBroker(): { url: string; requests: string[] } {
  const requests: string[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/v1/node") return Response.json({ id: nodeId, meshId: "mesh", name: "test" });
      if (url.pathname === "/v1/endpoints") return Response.json({ endpoints: [endpoint] });
      if (url.pathname === "/v1/flights" && url.searchParams.get("active") === "1") return Response.json({ flights: [] });
      return Response.json({ error: "unexpected read" }, { status: 500 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

function probes(prompts: string[]) {
  return {
    order: [],
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    codexThreadPids: async () => [],
    codexHeldByApp: async () => false,
    scoutLaunchedTmuxSessions: async () => new Set([session]),
    managedTmuxPane: async () => ({ target: "%17", socketPath: "/tmp/scout-test-tmux.sock" }),
    readTmuxTail: async () => "❯ \n",
    promptTmux: async (target: string) => { prompts.push(target); },
  };
}

test("direct input reads endpoints and active flights, never the full snapshot", async () => {
  const broker = startBroker();
  const prompts: string[] = [];
  const result = await deliverDirectSessionInput({}, { sessionId: native, harness: "claude", body: "Hi" }, broker.url, probes(prompts));
  expect(result).toMatchObject({ ok: true, via: "tmux" });
  expect(prompts).toEqual(["%17"]);
  expect(broker.requests.sort()).toEqual(["/v1/endpoints", "/v1/flights?active=1", "/v1/node"]);
});

test("direct input refuses the caller's own pane on the caller's tmux server", async () => {
  const broker = startBroker();
  const prompts: string[] = [];
  const input = { sessionId: native, harness: "claude", body: "Hi" };
  const own = { TMUX: "/tmp/scout-test-tmux.sock,4242,0", TMUX_PANE: "%17" };
  expect(await deliverDirectSessionInput(own, input, broker.url, probes(prompts))).toEqual({ ok: false, code: "not_live" });
  // %17 on another tmux server is a different pane.
  const elsewhere = { TMUX: "/tmp/scout-other-tmux.sock,4242,0", TMUX_PANE: "%17" };
  expect(await deliverDirectSessionInput(elsewhere, input, broker.url, probes(prompts))).toMatchObject({ ok: true });
  expect(prompts).toEqual(["%17"]);
});
