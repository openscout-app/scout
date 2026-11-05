import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScoutCommandContext } from "../context.ts";
import { parseRosterImportFile, renderRosterCommandHelp, runRosterCommand } from "./roster.ts";

const originalFetch = globalThis.fetch;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalExitCode = process.exitCode;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = originalExitCode;
  if (originalBrokerUrl === undefined) delete process.env.OPENSCOUT_BROKER_URL;
  else process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
});

type Captured = { url: string; method?: string; body?: unknown };

function mockBroker(respond: (request: Captured) => { status?: number; body: unknown }): Captured[] {
  process.env.OPENSCOUT_BROKER_URL = "http://127.0.0.1:24400";
  const requests: Captured[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = { url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(request);
    const { status = 200, body } = respond(request);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return requests;
}

describe("scout roster", () => {
  test("documents the forms and the import format", () => {
    const help = renderRosterCommandHelp();
    expect(help).toContain("scout roster project <name> <code>");
    expect(help).toContain("scout roster import <file|-> [--dry-run]");
    expect(help).toContain("OS-003");
    expect(help).toContain("\"agentId\", \"number\", \"projectCode\"");
  });

  test("project sends the code, and --reset sends null", async () => {
    const requests = mockBroker(() => ({
      body: { project: { projectKey: "peal-bach", name: "peal-bach", code: "PB", codeSource: "operator", defaultCode: "PB", createdAt: 1, updatedAt: 1 } },
    }));
    const output: string[] = [];
    const context = createScoutCommandContext({ cwd: "/work", stdout: (line) => output.push(line) });
    await runRosterCommand(context, ["project", "peal-bach", "pb"]);
    await runRosterCommand(context, ["project", "peal-bach", "--reset"]);
    expect(requests.map((request) => [request.url, request.method, request.body])).toEqual([
      ["http://127.0.0.1:24400/v1/roster/projects/code", "POST", { project: "peal-bach", code: "pb" }],
      ["http://127.0.0.1:24400/v1/roster/projects/code", "POST", { project: "peal-bach", code: null }],
    ]);
    expect(output[0]).toBe("peal-bach is PB (operator)");
  });

  test("a held code fails with the broker's message naming the holder", async () => {
    mockBroker(() => ({ status: 409, body: { error: "project_code_held", detail: 'OS is held by project "openscout"', heldBy: "openscout" } }));
    const context = createScoutCommandContext({ cwd: "/work", stdout: () => {} });
    await expect(runRosterCommand(context, ["project", "openscout-labs", "OS"])).rejects.toThrow('OS is held by project "openscout"');
  });

  test("import reads a file and reports conflicts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-roster-"));
    const file = join(dir, "roster.json");
    writeFileSync(file, JSON.stringify([{ agentId: "agent.a", number: "003", projectCode: "OS" }, { agentId: "agent.b", number: 3 }]));
    const requests = mockBroker(() => ({
      body: {
        dryRun: true,
        imported: [{ agentId: "agent.a", number: 3, code: "OS-003" }],
        renumbered: [],
        projectCodes: [],
        conflicts: [{ agentId: "agent.b", number: 3, reason: "duplicate_number", detail: "003 is also claimed by agent.a earlier in the import", heldBy: "agent.a" }],
      },
    }));
    const output: string[] = [];
    const context = createScoutCommandContext({ cwd: dir, stdout: (line) => output.push(line) });
    await runRosterCommand(context, ["import", "roster.json", "--dry-run"]);
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:24400/v1/roster/import",
      method: "POST",
      body: { dryRun: true, entries: [{ agentId: "agent.a", number: "003", projectCode: "OS" }, { agentId: "agent.b", number: 3 }] },
    });
    expect(output[0]).toContain("Dry run: nothing was written.");
    expect(output[0]).toContain("agent.b: duplicate_number: 003 is also claimed by agent.a");
  });

  test("the import file is a list or { entries }", () => {
    expect(parseRosterImportFile('[{"agentId":"a","number":1}]')).toEqual([{ agentId: "a", number: 1 }]);
    expect(parseRosterImportFile('{"entries":[{"agentId":"a","number":1}]}')).toEqual([{ agentId: "a", number: 1 }]);
    expect(() => parseRosterImportFile('{"agents":{}}')).toThrow(/must be a list/);
    expect(() => parseRosterImportFile("nope")).toThrow(/not JSON/);
  });

  test("resolve prints the agent, or the diagnostic and a failing exit code", async () => {
    mockBroker((request) => (request.body as { address: string }).address === "os003"
      ? { body: { address: "os003", resolved: true, entry: { agentId: "agent.c", number: 3, numberText: "003", projectKey: "openscout", project: "openscout", projectCode: "OS", code: "OS-003", label: "OS 003", source: "auto", assignedAt: 1 } } }
      : { body: { address: "XQ-003", resolved: false, diagnostic: { code: "unknown_project_code", detail: "no project has code XQ; scout roster lists the codes" } } });
    const output: string[] = [];
    const context = createScoutCommandContext({ cwd: "/work", stdout: (line) => output.push(line) });
    await runRosterCommand(context, ["resolve", "os003"]);
    expect(output[0]).toContain("OS 003");
    expect(output[0]).toContain("agent.c");
    await runRosterCommand(context, ["resolve", "XQ-003"]);
    expect(output[1]).toBe("no project has code XQ; scout roster lists the codes");
    expect(process.exitCode).toBe(1);
  });
});
