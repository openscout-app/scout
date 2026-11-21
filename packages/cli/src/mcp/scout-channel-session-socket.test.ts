import { expect, test } from "bun:test";

import { ClaudeChannelSocketInUseError, type ClaudeChannelHost } from "@openscout/runtime/in-place";

import { startSessionSocketBinding } from "./scout-channel.ts";

const A = "7d4f98dc-a46e-4759-b118-ee15960643fc";
const B = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

function harness(hosts: Array<ClaudeChannelHost | null>, failFirst = 0) {
  const events: string[] = [];
  const notifications: unknown[] = [];
  let host = hosts.shift() ?? null;
  let failures = failFirst;
  const controller = new AbortController();
  const binding = startSessionSocketBinding({
    server: { notification: async (message: unknown) => { notifications.push(message); } } as never,
    env: {},
    signal: controller.signal,
    intervalMs: 60_000,
    log: () => undefined,
    findHost: async () => host,
    serve: async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new ClaudeChannelSocketInUseError(input.sessionId);
      }
      events.push(`serve:${input.sessionId}:${input.hostPid}`);
      void input.deliver("hello");
      return { path: `/x/${input.sessionId}`, sessionId: input.sessionId, close: async () => { events.push(`close:${input.sessionId}`); } };
    },
  });
  return {
    events,
    notifications,
    binding,
    next: () => { host = hosts.shift() ?? null; },
    stop: () => controller.abort(),
  };
}

test("the socket follows the host's session: served, moved on /clear, closed when gone", async () => {
  const run = harness([
    { pid: 300, sessionId: A, channelLoaded: true },
    { pid: 300, sessionId: B, channelLoaded: true },
    null,
  ]);
  await run.binding.sync();
  expect(run.binding.current()?.sessionId).toBe(A);
  run.next();
  await run.binding.sync();
  expect(run.binding.current()?.sessionId).toBe(B);
  run.next();
  await run.binding.sync();
  expect(run.binding.current()).toBeNull();
  expect(run.events).toEqual([`serve:${A}:300`, `close:${A}`, `serve:${B}:300`, `close:${B}`]);
  expect(run.notifications[0]).toEqual({
    method: "notifications/claude/channel",
    params: { content: "hello", meta: { delivery: "session", session_id: A } },
  });
  run.stop();
});

test("a Claude started without the channel gets no socket; a held path is tried again", async () => {
  const off = harness([{ pid: 300, sessionId: A, channelLoaded: false }]);
  await off.binding.sync();
  expect(off.binding.current()).toBeNull();
  expect(off.events).toEqual([]);
  off.stop();

  const held = harness([{ pid: 300, sessionId: A, channelLoaded: true }], 1);
  await held.binding.sync();
  expect(held.binding.current()).toBeNull();
  await held.binding.sync();
  expect(held.binding.current()?.sessionId).toBe(A);
  held.stop();
});
