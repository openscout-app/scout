import { expect, test } from "bun:test";
import { createScoutCommandContext } from "../context.ts";
import { runNamedSkillCommand, runSkillsCommand } from "./skills.ts";

test("skills and run use the broker catalog, preserve the brief, and print the native receipt link", async () => {
  const calls: string[] = [], output: string[] = [];
  let input;
  const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/skills") return Response.json({ skills: [
      { name: "review", description: "Review a change.", path: "~/.agents/skills/review/SKILL.md" },
    ] });
    input = await req.json();
    return Response.json({ receipt: { requestId: "run-1", flightId: "flt-test", targetAgentId: "reviewer" }, followUrl: "http://runtime.test/work/w" });
  } });
  try {
    const ctx = createScoutCommandContext({ cwd: "/project", env: { OPENSCOUT_BROKER_URL: broker.url.origin }, stdout: t => output.push(t), stderr: () => {} });
    await runSkillsCommand(ctx, ["--harness", "codex", "--on", "worker"]);
    expect(output.pop()).toContain("review  Review a change.  ~/.agents/skills/review/SKILL.md");
    const brief = "Review a.md, not a=b.";
    await runNamedSkillCommand(ctx, ["review", brief, "--harness", "codex", "--on", "worker", "--project", "/code", "--request-id", "run-1"]);
    expect(input).toMatchObject({ name: "review", brief, currentDirectory: "/project", requestId: "run-1",
      target: { harness: "codex", host: "worker", project: "/code" } });
    expect(output.pop()).toContain("Follow the task: http://runtime.test/work/w");
    await expect(runNamedSkillCommand(ctx, ["review"])).rejects.toThrow("brief");
    expect(calls).toEqual(["GET /v1/skills?harness=codex&host=worker", "POST /v1/skills/run"]);
  } finally { await broker.stop(true); }
});
