import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTailEventsForSession } from "./service.js";
import type { DiscoverySnapshot } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("exact session Tail history", () => {
  for (const source of ["claude", "codex"] as const) {
    test(`reads ${source} history when opted in without changing Observe's source selection`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "openscout-tail-history-"));
      directories.push(directory);
      const sessionId = `${source}-quiet-task`;
      const transcriptPath = join(directory, "session.jsonl");
      const records = ["earlier reply", "latest reply"].map((text, index) => {
        const timestamp = `2026-04-27T15:00:0${index}.000Z`;
        return source === "claude" ? {
          type: "assistant", timestamp,
          message: { id: `message-${index}`, content: [{ type: "text", text }] },
        } : {
          type: "response_item", timestamp,
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
        };
      });
      const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await writeFile(transcriptPath, content);
      const discovery: DiscoverySnapshot = {
        generatedAt: Date.now(),
        processes: [],
        transcripts: [{ source, transcriptPath, sessionId, cwd: directory, project: "fixture",
          harness: "unattributed", mtimeMs: Date.now(), size: Buffer.byteLength(content) }],
        totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0, transcripts: 1 },
      };

      expect(await readTailEventsForSession(sessionId, { discovery })).toBeNull();
      const result = await readTailEventsForSession(sessionId, { discovery, includeAllSources: true, limit: 1 });
      expect(result?.events).toHaveLength(1);
      expect(result?.events[0]).toMatchObject({ source, sessionId, kind: "assistant", summary: "latest reply" });
      expect(await readTailEventsForSession("another-task", { discovery, includeAllSources: true })).toBeNull();
    });
  }
  test("finds an old Claude subagent under its parent's folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "scout-old-subagent-"));
    directories.push(root);
    const previousRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = root;
    try {
      const parentId = "9b1f63d2-5c1e-4c55-8d0e-0c3a7a4f2e11";
      const project = join(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT!, "-work-project");
      const subagents = join(project, parentId, "subagents");
      mkdirSync(subagents, { recursive: true });
      const parentPath = join(project, `${parentId}.jsonl`);
      writeFileSync(parentPath, JSON.stringify({
        type: "assistant", timestamp: "2026-10-11T15:09:01.000Z", sessionId: parentId, cwd: "/work/project",
        message: { id: "message-1", content: [{ type: "text", text: "the parent" }] },
      }) + "\n");
      const childPath = join(subagents, "agent-worker123.jsonl");
      writeFileSync(childPath, JSON.stringify({
        type: "assistant", timestamp: "2026-10-11T15:10:01.000Z", sessionId: parentId, cwd: "/work/project",
        message: { id: "message-2", content: [{ type: "text", text: "the child's reply" }] },
      }) + "\n");
      const threeDaysAgo = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(parentPath, threeDaysAgo, threeDaysAgo);
      utimesSync(childPath, threeDaysAgo, threeDaysAgo);

      const result = await readTailEventsForSession("worker123", { discovery: { generatedAt: Date.now(), processes: [], transcripts: [], totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0, transcripts: 0 } }, includeAllSources: true });
      expect(result?.events.map((event) => event.summary)).toEqual(["the child's reply"]);
      expect(result?.transcript.parentSessionId).toBe(parentId);
      expect(await readTailEventsForSession("worker123", { discovery: { generatedAt: Date.now(), processes: [], transcripts: [], totals: { total: 0, scoutManaged: 0, hudsonManaged: 0, unattributed: 0, transcripts: 0 } } })).toBeNull();
    } finally {
      if (previousRoot === undefined) delete process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT;
      else process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = previousRoot;
    }
  });

});
