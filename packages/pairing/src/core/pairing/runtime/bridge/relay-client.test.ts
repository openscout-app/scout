import { afterEach, expect, test } from "bun:test";
import { generateKeyPair } from "@openscout/runtime/pairing-security";

import type { Bridge } from "./bridge.ts";
import { connectToRelay } from "./relay-client.ts";

/**
 * A relay the bridge connects out to, as mobile-relay.ts is: it records what
 * the bridge sends and speaks for the clients in the room. No handshake runs
 * here, so the machine's trust store is never read or written.
 */
function fakeRelay() {
  const fromBridge: unknown[] = [];
  let bridge: { send(data: string): void } | null = null;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("Expected WebSocket upgrade", { status: 426 })),
    websocket: {
      open(socket) {
        bridge = socket;
        opened();
      },
      message(_socket, message) {
        fromBridge.push(JSON.parse(String(message)));
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/v1/relay`,
    ready,
    fromBridge,
    fromClient(clientId: string, payload: string) {
      bridge?.send(JSON.stringify({ phase: "relay", event: "message", clientId, payload }));
    },
    raw(data: string) {
      bridge?.send(data);
    },
    stop: () => server.stop(true),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function bridgeOn(relay: ReturnType<typeof fakeRelay>) {
  const connection = connectToRelay(relay.url, generateKeyPair(), {} as Bridge, {});
  cleanups.push(() => connection.disconnect(), relay.stop);
  return connection;
}

test("a client whose session the bridge no longer holds is told to shake hands again", async () => {
  const relay = fakeRelay();
  bridgeOn(relay);
  await relay.ready;

  // A frame from a session the bridge lost when it dropped off the relay and came back.
  relay.fromClient("client-a", JSON.stringify({ phase: "transport", payload: "AAAA" }));
  await wait(50);

  expect(relay.fromBridge).toEqual([
    { phase: "relay", event: "close", clientId: "client-a", code: 4002, reason: "Transport reset" },
  ]);
});

test("a relay without client ids gets no close it can't route", async () => {
  const relay = fakeRelay();
  bridgeOn(relay);
  await relay.ready;

  relay.raw(JSON.stringify({ phase: "transport", payload: "AAAA" }));
  await wait(50);

  expect(relay.fromBridge).toEqual([]);
});
