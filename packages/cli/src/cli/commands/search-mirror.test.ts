import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScoutCommandContext } from "../context.ts";
import { runSearchCommand } from "./search.ts";

test("scout search indexes a mirrored Claude session under its repo label", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-search-mirror-"));
  const mirror = join(root, "mirror");
  const local = join(root, "local");
  const label = "cloud-project";
  const env = {
    OPENSCOUT_SUPPORT_DIRECTORY: root,
    OPENSCOUT_CONTROL_HOME: join(root, "control"),
    OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT: local,
    OPENSCOUT_HUB_CLAUDE_MIRROR_ROOT: mirror,
  };
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  try {
    Object.assign(process.env, env);
    mkdirSync(local);
    mkdirSync(join(mirror, label), { recursive: true });
    writeFileSync(join(root, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
    const base = { cwd: "/home/user/repo", sessionId: "mirror-session", timestamp: new Date().toISOString() };
    writeFileSync(join(mirror, label, "mirror-session.jsonl"), [
      JSON.stringify({ ...base, type: "user", message: { role: "user", content: "Find mirrortestneedle in the cloud transcript." } }),
      JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Found the requested fixture." }] } }),
      "",
    ].join("\n"));
    const output: string[] = [];
    const context = createScoutCommandContext({ outputMode: "json", stdout: (line) => output.push(line), stderr: () => {} });
    await runSearchCommand(context, ["index", "--source", "sessions", "--harness", "claude", "--hours", "1"]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ indexed: 1, sessions: [{ project: label }] });
    output.length = 0;
    await runSearchCommand(context, ["query", "mirrortestneedle", "--harness", "claude", "--hours", "1"]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      hits: expect.arrayContaining([expect.objectContaining({
        sourceRefs: expect.arrayContaining([expect.objectContaining({ sessionId: base.sessionId })]),
      })]),
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
