import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { draftPlay, parsePlay, renderPlay } from "../../lib/core/plays.ts";
import { runNamedPlayCommand, runPlayCommand, runPlaysCommand } from "./play.ts";

const homes: string[] = [];
afterEach(async () => { for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "playbook-"));
  homes.push(home);
  const output: string[] = [];
  const ctx = createScoutCommandContext({ cwd: home, env: { HOME: home }, outputMode: "json", stdout: text => output.push(text) });
  return { ctx, home, result: () => JSON.parse(output.pop()!) };
}

const markdown = [
  "---", "name: report", 'description: "Write a report: Markdown."', "inputs:", "  path:", "  format: Markdown",
  "target:", "  project: ~/work", "  host: worker", "  harness: codex", "delivery: A {{format}} file.",
  "---", "Read {{path}}.", "---", "Summarize the findings.",
].join("\r\n");

test("fills YAML defaults, procedure and delivery once; remote paths belong to the target", () => {
  const play = parsePlay("report", markdown);
  const run = renderPlay(play, { path: "dir/{{format}} $1" }, { host: "other" }, "/local");
  expect(run.target).toEqual({ project: "~/work", host: "other", harness: "codex" });
  expect(run.body).toContain("Read dir/{{format}} $1.\n---\nSummarize the findings.");
  expect(run.body).toEndWith("Delivery: A Markdown file.");
  expect(() => parsePlay("another", markdown)).toThrow("name must match");
  expect(() => parsePlay("report", markdown.replace("  host:", "  hostname:"))).toThrow("hostname");
  expect(() => renderPlay(play, { path: "a", typo: "b" }, {}, "/local")).toThrow("typo");
  expect(() => renderPlay({ ...play, delivery: "{{typo}}" }, { path: "a" }, {}, "/local")).toThrow("typo");
});

test("new, list, show and dry-run use the same operator playbook and never overwrite a play", async () => {
  const { ctx, home, result } = await fixture();
  await runPlaysCommand(ctx, []);
  expect(result()).toEqual([]);
  await runPlayCommand(ctx, ["new", "report"]);
  const { path } = result();
  expect(path).toBe(join(home, ".scout", "plays", "report.md"));
  await runPlayCommand(ctx, ["show", "report"]);
  expect(result().markdown).toBe(await readFile(path, "utf8"));
  await runPlaysCommand(ctx, []);
  expect(result()).toMatchObject([{ name: "report", inputs: { path: null } }]);
  await expect(runPlayCommand(ctx, ["new", "report"])).rejects.toThrow("already exists");
  await expect(runPlayCommand(ctx, ["new", "../outside"])).rejects.toThrow("Invalid play name");
  await expect(runNamedPlayCommand(ctx, ["report"])).rejects.toThrow("Missing required input for report: path");
  await expect(runNamedPlayCommand(ctx, ["report", "path=foo", "--on", "elsewhere"])).rejects.toThrow("--project");
  await runNamedPlayCommand(ctx, ["report", "path=a b=c", "--project", "repo", "--dry-run"]);
  expect(result()).toMatchObject({ target: { project: join(home, "repo") }, body: expect.stringContaining("Inspect a b=c.") });
});

test("save drafts the original brief by invocation or flight id; repeated paths become one input", async () => {
  const { ctx, result } = await fixture();
  const brief = 'Read "docs/a b.md" and assets/renders. Compare assets/renders again.\nDelivery: Post to https://example.org/report.';
  const requests: string[] = [];
  const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    if (path === "/v1/invocations/inv-original") return Response.json({ invocation: { id: "inv-original", task: brief }, flight: { output: "private reply" } });
    if (path === "/v1/flights/flt-original") return Response.json({ flight: { id: "flt-original", invocationId: "inv-original" } });
    return new Response(null, { status: 404 });
  } });
  const prev = process.env.OPENSCOUT_BROKER_URL;
  process.env.OPENSCOUT_BROKER_URL = broker.url.href;
  try {
    for (const [name, id] of [["first", "inv-original"], ["second", "flt-original"]]) {
      await runPlayCommand(ctx, ["save", name, "--from", id]);
      const play = parsePlay(name, await readFile(result().path, "utf8"));
      expect(play.inputs).toEqual({ path: null, path2: null, url: null });
      expect(play.delivery).toBe("Post to {{url}}.");
      expect(play.procedure).toBe('Read "{{path}}" and {{path2}}. Compare {{path2}} again.\nDelivery: Post to {{url}}.');
    }
    expect(requests).toEqual(["/v1/invocations/inv-original", "/v1/flights/flt-original", "/v1/invocations/inv-original"]);
    expect(parsePlay("notes", draftPlay("notes", "Explain this design.")).inputs).toEqual({});
  } finally {
    if (prev === undefined) delete process.env.OPENSCOUT_BROKER_URL; else process.env.OPENSCOUT_BROKER_URL = prev;
    await broker.stop(true);
  }
});
