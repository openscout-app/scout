import { afterEach, expect, test } from "bun:test";
import { createScoutCommandContext } from "../context.ts";
import { findScoutCommandRegistration } from "../registry.ts";
import { renderScoutHelp } from "../help.ts";
import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";
import { loadScoutCommandHandler } from "./index.ts";
import { parseQuarantineCommandOptions, renderQuarantineCommandHelp, runQuarantineCommand } from "./quarantine.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const record = { id: "quarantine-one", status: "open", kind: "journal", reason: "invalid framing", bytes: 12,
  digest: "abc", createdAt: 1, acknowledgedAt: null, scope: { recordIds: [], sessionIds: ["session-one"], invocationIds: [], actorIds: [] } };
function context(json = false) {
  const output: string[] = [];
  return { output, value: createScoutCommandContext({ env: { OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" },
    outputMode: json ? "json" : "plain", stdout: line => output.push(line) }) };
}

test("quarantine is discoverable and diagnostic operations never restart the broker", async () => {
  expect(findScoutCommandRegistration("quarantine")?.summary).toContain("preserved");
  expect(await loadScoutCommandHandler("quarantine")).toBe(runQuarantineCommand);
  expect(renderScoutHelp()).toContain("quarantine");
  expect(renderScoutHelp("test", true)).toContain("quarantine");
  expect(renderQuarantineCommandHelp()).toContain("never retries work");
  expect(shouldEnsureBrokerUptodateForCommand("quarantine")).toBe(false);
  expect(shouldEnsureBrokerUptodateForCommand("quarantine", ["acknowledge", "id"])).toBe(false);
});

test("list defaults and invalid limits, status or extra operands fail before requests", async () => {
  expect(parseQuarantineCommandOptions([])).toMatchObject({ command: "list", status: "open", limit: 50 });
  for (const args of [["--limit", "0"], ["--limit=101"], ["--limit", "1.5"], ["--status", "done"],
    ["--session"], ["show"], ["show", "id", "extra"], ["acknowledge", "id", "--status", "open"], ["list", "id"], ["--unknown"]]) {
    expect(() => parseQuarantineCommandOptions(args)).toThrow();
  }
  let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error("no request expected"); }) as unknown as typeof fetch;
  const output = context(); await runQuarantineCommand(output.value, ["--help"]);
  expect(calls).toBe(0); expect(output.output[0]).toContain("scout quarantine show");
});

test("list sends bounded filters and JSON keeps structured metadata", async () => {
  const requested: Request[] = [];
  const result = { status: { openCount: 2, acknowledgedCount: 3, samples: [record] }, records: [record] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(new Request(input, init)); return Response.json(result);
  }) as unknown as typeof fetch;
  const output = context(true);
  await runQuarantineCommand(output.value, ["list", "--session", "session/雪 ?", "--status", "acknowledged", "--limit", "7"]);
  const url = new URL(requested[0]!.url);
  expect(requested).toHaveLength(1); expect(requested[0]!.method).toBe("GET");
  expect(url.pathname).toBe("/v1/quarantine");
  expect(Object.fromEntries(url.searchParams)).toEqual({ status: "acknowledged", limit: "7", sessionId: "session/雪 ?" });
  expect(JSON.parse(output.output[0]!)).toEqual(result);
});

test("show preserves exact base64 evidence and acknowledgement sends one empty POST", async () => {
  const requested: Request[] = [];
  const evidence = { ...record, encoding: "base64", payload: "AP9cdWZmZmQ=", source: { path: "/fixture/input", startByte: 2, endByte: 14 } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requested.push(request);
    return Response.json({ record: request.method === "POST" ? { ...record, status: "acknowledged" } : evidence });
  }) as unknown as typeof fetch;
  const show = context(); await runQuarantineCommand(show.value, ["show", "record/one", "--json"]);
  expect(JSON.parse(show.output[0]!)).toEqual({ record: evidence });
  expect(new URL(requested[0]!.url).pathname).toBe("/v1/quarantine/record%2Fone");
  const acknowledge = context(); await runQuarantineCommand(acknowledge.value, ["acknowledge", "record/one"]);
  expect(requested).toHaveLength(2); expect(requested[1]!.method).toBe("POST");
  expect(new URL(requested[1]!.url).pathname).toBe("/v1/quarantine/record%2Fone/acknowledge");
  expect(await requested[1]!.text()).toBe("");
  expect(acknowledge.output[0]).toContain("Evidence remains stored; no work was retried");
});

test("404 and unavailable storage remain explicit errors without automatic mutation or retry", async () => {
  for (const status of [404, 503]) {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: "unavailable" }, { status }); }) as unknown as typeof fetch;
    await expect(runQuarantineCommand(context().value, ["show", "absent"])).rejects.toThrow(`HTTP ${status}`);
    expect(calls).toBe(1);
  }
});

test("defer and retry issue one explicit decision request and never dispatch agent work", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init); requests.push(req);
    return Response.json({ record: { ...record, status: req.url.endsWith("defer") ? "deferred" : "resolved" }, outcome: "resolved", detail: null });
  }) as unknown as typeof fetch;
  const deferred = context(); await runQuarantineCommand(deferred.value, ["defer", "record-one"]);
  expect(deferred.output[0]).toContain("remains quarantined");
  const retried = context(); await runQuarantineCommand(retried.value, ["retry", "record-one"]);
  expect(retried.output[0]).toContain("no task was rerun");
  expect(requests.map(req => [req.method, new URL(req.url).pathname])).toEqual([
    ["POST", "/v1/quarantine/record-one/defer"], ["POST", "/v1/quarantine/record-one/retry"],
  ]);
  expect(parseQuarantineCommandOptions(["list", "--status", "deferred"]).status).toBe("deferred");
});
