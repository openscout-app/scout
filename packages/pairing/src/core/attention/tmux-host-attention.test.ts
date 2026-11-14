import { describe, expect, test } from "bun:test";

import type { WebAgent } from "../../shared/api/web.ts";
import {
  collectTmuxHostAttention,
  detectClaudeTmuxHostAttention,
} from "./tmux-host-attention.ts";

const SESSION_ID = "relay-paper-screen-fable-work-hud-013-voice-settings-arachs-mac-mini-local-claude";

function agent(overrides: Partial<WebAgent> = {}): WebAgent {
  return {
    id: "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
    definitionId: "paper-screen-fable",
    name: "Paper Screen Fable",
    handle: "paper-screen-fable",
    agentClass: "general",
    harness: "claude",
    state: "working",
    projectRoot: "/Users/guest/dev/hudson",
    cwd: "/Users/guest/dev/hudson",
    updatedAt: 1,
    createdAt: 1,
    transport: "tmux",
    selector: "@paper-screen-fable",
    defaultSelector: "@paper-screen-fable",
    nodeQualifier: "local",
    workspaceQualifier: "work-hud-013-voice-settings",
    wakePolicy: "on_demand",
    capabilities: ["chat", "invoke", "deliver"],
    project: "Hudson",
    branch: "work/hud-013-voice-settings",
    role: "Agent",
    model: "fable",
    harnessSessionId: null,
    terminalSurface: {
      backend: "tmux",
      sessionName: SESSION_ID,
      paneId: SESSION_ID,
      socketDir: null,
    },
    harnessLogPath: null,
    conversationId: null,
    authorityNodeId: null,
    authorityNodeName: null,
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

import { livePermissionPrompt } from "../../../../runtime/src/test-helpers/tmux-host-attention-fixture.test.ts";

describe("Claude tmux host attention", () => {
  test("detects the active permission prompt from the reported pane", () => {
    expect(detectClaudeTmuxHostAttention(livePermissionPrompt, {
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
      now: 1_700_000_000_000,
    })).toEqual({
      id: `tmux-host-permission:agent-1:${SESSION_ID}`,
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
      title: "Claude needs permission",
      summary: "Permission rule Bash(curl:*) requires confirmation.",
      detail: "curl -s -m 5 http://127.0.0.1:29980/api/files",
      updatedAt: 1_700_000_000_000,
      sourceLabel: "Claude terminal prompt",
    });
  });

  test("scans live Claude tmux panes even when broker state is available", async () => {
    const captures: string[] = [];
    const { items, read } = await collectTmuxHostAttention([
      agent(),
      agent({ id: "idle", state: "available" }),
      agent({ id: "retired", state: "available", retiredFromFleet: true }),
      agent({ id: "codex", harness: "codex" }),
    ], async (candidate) => {
      captures.push(candidate.id);
      return livePermissionPrompt;
    }, { nodeId: "node-1", now: 1_700_000_000_000 });

    expect(read.observations[0]?.ref.nodeId).toBe("node-1");
    expect(read.observations[0]?.prompt?.promptVersion).toMatch(/^sha256:/);
    expect(captures).toEqual([
      "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
      "idle",
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        agentId: "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
        title: "Claude needs permission",
      }),
      expect.objectContaining({
        agentId: "idle",
        title: "Claude needs permission",
      }),
    ]);
  });

  test("bounds a stalled pane capture", async () => {
    const { items, read } = await collectTmuxHostAttention(
      [agent()],
      async () => await new Promise<string>(() => {}),
      { nodeId: "node-1", captureTimeoutMs: 5 },
    );

    expect(items).toEqual([]);
    expect(read.observations[0]?.availability).toBe("unavailable");
    expect(read.observations[0]?.reason).toBe("capture_timeout");
  });

  test("bounds host scans and prioritizes active recent sessions", async () => {
    const captures: string[] = [];
    const agents = Array.from({ length: 30 }, (_, index) => agent({
      id: `agent-${index}`,
      state: index === 29 ? "working" : "available",
      updatedAt: index,
    }));

    await collectTmuxHostAttention(agents, async (candidate) => {
      captures.push(candidate.id);
      return null;
    }, { nodeId: "node-1", maxCandidates: 5, captureConcurrency: 1 });

    expect(captures).toEqual([
      "agent-29",
      "agent-28",
      "agent-27",
      "agent-26",
      "agent-25",
    ]);
  });
  test("unknown identity and remote refs cannot trigger local captures", async () => {
    let calls = 0;
    const capture = async () => { calls++; return livePermissionPrompt; };
    const unknown = await collectTmuxHostAttention([agent()], capture, { nodeId: null });
    expect(unknown.items).toEqual([]);
    expect(unknown.read.availability).toBe("unknown");
    const remote = await collectTmuxHostAttention([agent({ homeNodeId: "other-node" })], capture, { nodeId: "node-1" });
    expect(remote.items).toEqual([]);
    expect(remote.read.observations[0]?.reason).toBe("nonlocal_ref");
    expect(calls).toBe(0);
  });

  test("preserves explicit capture truncation through the adopter", async () => {
    const result = await collectTmuxHostAttention([agent()], async () => ({ body: livePermissionPrompt, truncated: true }), { nodeId: "node-1" });
    expect(result.items).toEqual([]);
    expect(result.read.observations[0]?.availability).toBe("partial");
    expect(result.read.observations[0]?.reason).toBe("capture_truncated");
  });

});
