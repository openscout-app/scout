import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  OBSERVED_HARNESS_TOPOLOGY_META_KEY,
  type AgentSessionStreamEvent,
} from "../../protocol/primitives.ts";
import { createAdapter } from "./adapter.ts";

const tempPaths = new Set<string>();
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function writeFakeClaudeExecutable(baseDirectory: string, body: string): string {
  const executablePath = join(baseDirectory, "claude");
  writeFileSync(executablePath, body, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function createEventCollector() {
  const events: AgentSessionStreamEvent[] = [];
  const listeners = new Set<() => void>();

  return {
    events,
    push(event: AgentSessionStreamEvent) {
      events.push(event);
      for (const listener of listeners) {
        listener();
      }
    },
    async waitFor(predicate: (events: AgentSessionStreamEvent[]) => boolean, timeoutMs = 5_000): Promise<void> {
      if (predicate(events)) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for events after ${timeoutMs}ms.`));
        }, timeoutMs);

        const check = () => {
          if (!predicate(events)) {
            return;
          }
          clearTimeout(timeout);
          listeners.delete(check);
          resolve();
        };

        listeners.add(check);
      });
    },
  };
}

describe("ClaudeCodeAdapter", () => {
  test("infers the owning project cwd for a resume id", async () => {
    const resumeId = crypto.randomUUID();
    const projectRoot = join(tmpdir(), `openscoutclaude${crypto.randomUUID().replace(/-/g, "")}`);
    const slug = `-${projectRoot.replace(/^\//u, "").replace(/\//g, "-")}`;
    const sessionDir = join(homedir(), ".claude", "projects", slug);
    const sessionPath = join(sessionDir, `${resumeId}.jsonl`);

    tempPaths.add(projectRoot);
    tempPaths.add(sessionDir);

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(sessionPath, "", "utf8");

    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Test",
      cwd: "/Users/guest/dev/openscout",
      options: {
        resume: resumeId,
      },
    });
    expect(adapter.session.cwd).toBe(projectRoot);
    expect(adapter.session.providerMeta).toEqual(
      expect.objectContaining({
        resumeSessionPath: sessionPath,
        resumeProjectCwd: projectRoot,
      }),
    );
  });

  test("emits text deltas from stream_event output", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-stream-"));
    tempPaths.add(tempRoot);

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
import readline from "node:readline";

console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-test",
  cwd: process.cwd(),
  model: "claude-test",
}));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }));
  console.log(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  }));
  console.log(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
  }));
  console.log(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
  }));
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
  break;
}
`);

    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;

    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Stream Test",
      cwd: tempRoot,
      env: {
        PATH: process.env.PATH,
      },
    });

    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    adapter.send({ sessionId: adapter.session.id, text: "say hi" });

    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    const textStart = collector.events.find(
      (event) => event.event === "block:start" && event.block.type === "text",
    );
    const deltas = collector.events
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const turnEnd = collector.events.find((event) => event.event === "turn:end");

    expect(textStart).toBeDefined();
    expect(deltas).toBe("hello world");
    expect(turnEnd).toEqual(expect.objectContaining({ event: "turn:end", status: "completed" }));

    await adapter.shutdown();
  });

  test("answers modern nested AskUserQuestion tool calls", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-question-"));
    tempPaths.add(tempRoot);

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = rl[Symbol.asyncIterator]();
await lines.next();
console.log(JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "question-tool-1",
      name: "AskUserQuestion",
      input: {
        questions: [{
          header: "Proceed",
          question: "Continue?",
          options: [{ label: "Yes", description: "Continue the task." }],
          multiSelect: false,
        }],
      },
    }],
  },
}));
const answerLine = await lines.next();
const answer = JSON.parse(answerLine.value);
const answerContent = answer?.message?.content?.[0];
if (
  answer.type !== "user"
  || answer.message?.role !== "user"
  || answerContent?.type !== "tool_result"
  || answerContent.tool_use_id !== "question-tool-1"
) {
  process.exit(9);
}
console.log(JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: answerContent.tool_use_id,
      content: answerContent.content,
      is_error: false,
    }],
  },
}));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
`);

    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;

    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Question Test",
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    adapter.send({ sessionId: adapter.session.id, text: "ask me" });
    await collector.waitFor((events) => events.some(
      (event) => event.event === "block:start" && event.block.type === "question",
    ));
    const questionStart = collector.events.find(
      (event) => event.event === "block:start" && event.block.type === "question",
    );
    if (!questionStart || questionStart.event !== "block:start") {
      throw new Error("Expected question block.");
    }

    adapter.answerQuestion({ blockId: questionStart.block.id, answer: ["Yes"] });
    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "block:question:answer",
      blockId: questionStart.block.id,
      answer: ["Yes"],
    }));
    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "block:end",
      blockId: questionStart.block.id,
      status: "completed",
    }));

    await adapter.shutdown();
  });

  test("does not invent completion when the transport closes without a result", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-eof-"));
    tempPaths.add(tempRoot);

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  console.log(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
  }));
  rl.close();
  process.exit(0);
  break;
}
`);

    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;
    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude EOF Test",
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    adapter.send({ sessionId: adapter.session.id, text: "start" });
    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "stopped",
    }));
    expect(collector.events).not.toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "completed",
    }));

    await adapter.shutdown();
  });

  test("classifies a nonzero transport exit as failed after stdout closes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-exit-error-"));
    tempPaths.add(tempRoot);

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  console.log(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
  }));
  rl.close();
  process.exit(7);
  break;
}
`);

    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;
    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Exit Error Test",
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));
    adapter.on("error", () => undefined);

    await adapter.start();
    adapter.send({ sessionId: adapter.session.id, text: "start" });
    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    expect(collector.events).toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "failed",
    }));
    expect(collector.events).not.toContainEqual(expect.objectContaining({
      event: "turn:end",
      status: "stopped",
    }));

    await adapter.shutdown();
  });

  test("attaches provider quota observations from rate limit events", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-quota-"));
    tempPaths.add(tempRoot);

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-quota",
  cwd: process.cwd(),
  model: "claude-test",
}));
console.log(JSON.stringify({
  type: "rate_limit_event",
  timestamp: "2026-06-08T12:00:00.000Z",
  rate_limits: {
    plan_type: "max",
    primary: {
      used_percent: 30,
      window_minutes: 300,
      reset_after_seconds: 900,
    },
    secondary: {
      remaining_percent: 64,
      window_ms: 604800000,
    },
  },
}));
`);

    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;

    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Quota Test",
      cwd: tempRoot,
      env: {
        PATH: process.env.PATH,
      },
    });

    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    await collector.waitFor((events) =>
      events.some((event) => {
        if (event.event !== "session:update") return false;
        const observeQuota = event.session.providerMeta?.observeQuota;
        return event.session.providerMeta?.provider === "anthropic"
          && Boolean(observeQuota && typeof observeQuota === "object" && Array.isArray((observeQuota as { windows?: unknown }).windows));
      })
    );

    expect(adapter.session.providerMeta).toEqual(expect.objectContaining({
      provider: "anthropic",
      observeQuota: expect.objectContaining({
        provider: "anthropic",
        capturedAt: Date.parse("2026-06-08T12:00:00.000Z"),
        planType: "max",
        windows: [
          expect.objectContaining({
            label: "5h",
            windowKind: "primary",
            usedPercent: 30,
          }),
          expect.objectContaining({
            label: "weekly",
            windowKind: "secondary",
            percentRemaining: 64,
          }),
        ],
      }),
    }));

    await adapter.shutdown();
  });

  test("attaches observed Claude agent-team topology to session metadata", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-topology-"));
    const tempHome = mkdtempSync(join(tmpdir(), "openscout-claude-home-"));
    tempPaths.add(tempRoot);
    tempPaths.add(tempHome);

    const teamDir = join(tempHome, ".claude", "teams", "review-team");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({
      name: "review-team",
      cwd: tempRoot,
      lead: {
        sessionId: "lead-session-topology",
      },
      members: [
        {
          name: "Coverage",
          agentId: "coverage-1",
          agentType: "test-reviewer",
        },
      ],
    }), "utf8");

    writeFakeClaudeExecutable(tempRoot, `#!/usr/bin/env bun
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "lead-session-topology",
  cwd: ${JSON.stringify(tempRoot)},
  model: "claude-test",
}));
await new Promise(() => {});
`);

    process.env.HOME = tempHome;
    process.env.PATH = `${tempRoot}:${originalPath ?? ""}`;

    const adapter = createAdapter({
      sessionId: `claude-test-${crypto.randomUUID()}`,
      name: "Claude Topology Test",
      cwd: tempRoot,
      env: {
        HOME: tempHome,
        PATH: process.env.PATH,
      },
    });

    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    await collector.waitFor((events) =>
      events.some((event) =>
        event.event === "session:update"
        && Boolean(event.session.providerMeta?.[OBSERVED_HARNESS_TOPOLOGY_META_KEY])
      ));

    const update = [...collector.events].reverse().find((event) =>
      event.event === "session:update"
      && Boolean(event.session.providerMeta?.[OBSERVED_HARNESS_TOPOLOGY_META_KEY])
    );
    const topology = update?.event === "session:update"
      ? update.session.providerMeta?.[OBSERVED_HARNESS_TOPOLOGY_META_KEY]
      : null;

    expect(topology).toEqual(expect.objectContaining({
      ownership: "harness_observed",
      source: "claude-code-agent-teams",
      groups: [expect.objectContaining({ name: "review-team" })],
      agents: expect.arrayContaining([
        expect.objectContaining({ role: "lead", externalSessionId: "lead-session-topology" }),
        expect.objectContaining({ name: "Coverage", type: "test-reviewer" }),
      ]),
    }));

    await adapter.shutdown();
  });
});
