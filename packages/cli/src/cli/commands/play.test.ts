import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScoutCommandContext } from "../context.ts";
import { draftPlay, parsePlay } from "@openscout/runtime/playbook";
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

test("new, show and offline dry-run use the operator playbook and never overwrite a play", async () => {
  const { ctx, home, result } = await fixture();
  await runPlayCommand(ctx, ["new", "report"]);
  const { path } = result();
  expect(path).toBe(join(home, ".scout", "plays", "report.md"));
  await runPlayCommand(ctx, ["show", "report"]);
  expect(result().markdown).toBe(await readFile(path, "utf8"));
  await expect(runPlayCommand(ctx, ["new", "report"])).rejects.toThrow("already exists");
  await expect(runPlayCommand(ctx, ["new", "../outside"])).rejects.toThrow("Invalid play name");
  await expect(runNamedPlayCommand(ctx, ["report", "--dry-run"])).rejects.toThrow("Missing required input for report: path");
  await expect(runNamedPlayCommand(ctx, ["report", "path=foo", "--on", "elsewhere", "--dry-run"])).rejects.toThrow("--project");
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
      expect(play.inputs.map(field => field.name)).toEqual(["path", "path2", "url"]);
      expect(play.delivery).toBe("Post to {{url}}.");
      expect(play.procedure).toBe('Read "{{path}}" and {{path2}}. Compare {{path2}} again.\nDelivery: Post to {{url}}.');
    }
    expect(requests).toEqual(["/v1/invocations/inv-original", "/v1/flights/flt-original", "/v1/invocations/inv-original"]);
    expect(parsePlay("notes", draftPlay("notes", "Explain this design.")).inputs).toEqual([]);
  } finally {
    if (prev === undefined) delete process.env.OPENSCOUT_BROKER_URL; else process.env.OPENSCOUT_BROKER_URL = prev;
    await broker.stop(true);
  }
});


test("list and run call the broker, not the CLI playbook", async () => {
  const { ctx, result } = await fixture();
  const calls: string[] = [];
  const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push(`${req.method} ${path}`);
    if (path === "/v1/plays") return Response.json({ plays: [{ name: "remote-book", description: "Only on the runtime", inputs: [] }] });
    const input = await req.json();
    expect(input).toMatchObject({ name: "remote-book", inputs: { owner: "A" }, requestId: "run-1", currentDirectory: ctx.cwd });
    expect(input).not.toHaveProperty("body");
    return Response.json({ receipt: { requestId: "run-1", flightId: "flt-test" }, followUrl: "http://runtime.test/work/w" });
  } });
  ctx.env.OPENSCOUT_BROKER_URL = broker.url.origin;
  try {
    await runPlaysCommand(ctx, []);
    expect(result()[0].name).toBe("remote-book");
    await runNamedPlayCommand(ctx, ["remote-book", "owner=A", "--request-id", "run-1"]);
    expect(result().receipt.flightId).toBe("flt-test");
    expect(calls).toEqual(["GET /v1/plays", "POST /v1/plays/run"]);
  } finally { await broker.stop(true); }
});
