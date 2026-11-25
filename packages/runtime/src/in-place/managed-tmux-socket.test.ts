import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEndpoint } from "@openscout/protocol";
import { resetScoutdProbeClientForTests } from "../system-probes/scoutd-client.js";
import { deliverInPlace, type DeliverInPlaceDeps } from "./deliver.js";
import { inspectSessionInputRoute } from "./session-input-route.js";

const session = "session-managed-socket";
const native = "5b0f6a3e-2f0c-4c55-9a8e-6c7f1d2e3a4b";
const nodeId = "node-test";

/**
 * A tmux server with one Scout-marked pane, %17. It logs every call, shows an
 * empty composer until a submit key arrives, then shows harness activity.
 */
function writeFakeTmux(directory: string): string {
  const path = join(directory, "tmux");
  writeFileSync(path, [
    "#!/bin/sh",
    "dir=\"$(dirname \"$0\")\"",
    "printf '%s\\n' \"$*\" >> \"$dir/calls.log\"",
    "if [ \"$1\" = \"-S\" ]; then shift 2; fi",
    "case \"$1\" in",
    `  list-panes) printf '${session}|1|%%17|0|%s\\n' "$dir/tmux.sock" ;;`,
    "  capture-pane)",
    "    if [ -f \"$dir/submitted\" ]; then printf '● Reading file...\\n  notes.md\\n╭────────╮\\n│ >      │\\n╰────────╯\\n';",
    "    else printf '❯ \\n'; fi ;;",
    "  load-buffer) cat > \"$dir/buffer\" ;;",
    "  paste-buffer) ;;",
    "  send-keys) case \"$*\" in *Enter*) : > \"$dir/submitted\" ;; esac ;;",
    "  *) exit 64 ;;",
    "esac",
  ].join("\n") + "\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

let directory = "";
const previous: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-tmux-socket-")));
  writeFileSync(join(directory, "tmux.sock"), "");
  for (const key of ["PATH", "OPENSCOUT_TMUX_BIN", "OPENSCOUT_PROBES_SOCKET"]) previous[key] = process.env[key];
  process.env.OPENSCOUT_TMUX_BIN = writeFakeTmux(directory);
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
  // Run tmux locally: a running scoutd would address this host's real panes.
  process.env.OPENSCOUT_PROBES_SOCKET = join(directory, "missing-probes.sock");
  resetScoutdProbeClientForTests();
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetScoutdProbeClientForTests();
  rmSync(directory, { recursive: true, force: true });
});

function deps(overrides: Partial<DeliverInPlaceDeps> = {}): DeliverInPlaceDeps {
  const endpoint = {
    id: "managed-worker", agentId: session, nodeId, harness: "claude", transport: "tmux",
    state: "active", sessionId: session, pane: "%17",
    metadata: { cardless: true, tmuxSession: session, externalSessionId: native },
  } as AgentEndpoint;
  return {
    order: [],
    findHerdrPane: async () => null,
    findClaudeRecord: async () => null,
    codexThreadPids: async () => [],
    codexHeldByApp: async () => false,
    scoutLaunchedTmuxSessions: async () => new Set([session]),
    managedTmuxContext: async () => ({ nodeId, snapshot: { endpoints: { [endpoint.id]: endpoint }, flights: {} } }),
    ...overrides,
  };
}

const calls = () => readFileSync(join(directory, "calls.log"), "utf8").trim().split("\n");

test("a direct send finds the marked pane and stays on its tmux socket", async () => {
  const socket = join(directory, "tmux.sock");
  const result = await deliverInPlace({ sessionId: native, harness: "claude", body: "Follow up on the review" }, deps());
  expect(result).toMatchObject({ ok: true, via: "tmux", location: `tmux ${session} · %17` });
  expect(readFileSync(join(directory, "buffer"), "utf8")).toBe("Follow up on the review");
  const log = calls();
  // The pane lookup names the session; every later call addresses the observed socket.
  expect(log[0]).toStartWith(`list-panes -s -t ${session} -F`);
  const paneCalls = log.slice(1);
  expect(paneCalls.map(call => call.split(" ")[2])).toEqual(expect.arrayContaining(["capture-pane", "load-buffer", "paste-buffer", "send-keys"]));
  for (const call of paneCalls) expect(call).toStartWith(`-S ${socket} `);
  expect(paneCalls.filter(call => call.includes(" send-keys ")).every(call => call.includes("-t %17"))).toBe(true);
});

test("inspection uses the verified managed tmux socket without submitting input", async () => {
  const route = await inspectSessionInputRoute({ sessionId: native, harness: "claude" }, deps());
  expect(route).toMatchObject({ kind: "live_host", via: "tmux", provenance: "observed", location: `tmux ${session} · %17` });
  const log = calls();
  expect(log).toHaveLength(2);
  expect(log[0]).toStartWith(`list-panes -s -t ${session} -F`);
  expect(log[1]).toStartWith(`-S ${join(directory, "tmux.sock")} capture-pane`);
  expect(existsSync(join(directory, "buffer"))).toBe(false);
});

test("the caller's own pane is refused only on the same tmux server", async () => {
  const input = { sessionId: native, harness: "claude", body: "Hello" };
  // A symlinked socket path names the same server.
  symlinkSync(join(directory, "tmux.sock"), join(directory, "linked.sock"));
  const sameServer = { target: "%17", socketPath: join(directory, "linked.sock") };
  expect(await deliverInPlace(input, deps({ ownTmuxPane: sameServer }))).toEqual({ ok: false, code: "not_live" });
  expect(existsSync(join(directory, "buffer"))).toBe(false);
  // No caller socket: a matching pane ID cannot be told apart, so refuse.
  expect(await deliverInPlace(input, deps({ ownTmuxPane: { target: "%17", socketPath: null } })))
    .toEqual({ ok: false, code: "not_live" });
  expect(existsSync(join(directory, "buffer"))).toBe(false);
  // The same pane ID on another server is a different pane.
  const otherServer = { target: "%17", socketPath: join(directory, "other.sock") };
  expect(await deliverInPlace(input, deps({ ownTmuxPane: otherServer }))).toMatchObject({ ok: true, via: "tmux" });
  expect(readFileSync(join(directory, "buffer"), "utf8")).toBe("Hello");
});
