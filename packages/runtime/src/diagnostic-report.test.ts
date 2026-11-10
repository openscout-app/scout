import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { collectDiagnosticReport, submitDiagnosticReport, submitPreparedDiagnosticReport, diagnosticLogLines, redactDiagnosticText, reporterHarness } from "./diagnostic-report";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-report-")); roots.push(root);
  const supportDirectory = join(root, "support"), controlHome = join(root, "control");
  await mkdir(join(supportDirectory, "logs/base"), { recursive: true });
  await mkdir(controlHome);
  return { supportDirectory, controlHome };
}
test("captures the Mini failure shape without exporting journal bodies; tolerates missing broker/SQLite", async () => {
  const opts = await fixture();
  await writeFile(join(opts.controlHome, "broker-journal.jsonl"), [
    { kind: "message.create", message: { body: "PRIVATE CONVERSATION" } },
    { kind: "node.upsert", node: { nodeId: "studio-lab-3", endpoints: ["https://127.0.0.1:43111?token=secret"] } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n");
  await writeFile(join(opts.supportDirectory, "logs/base/broker.stderr.log"), "[broker] sqlite projection unavailable (degraded): NOT NULL constraint failed: nodes.id\nPRIVATE TOOL OUTPUT\n");
  const report = await collectDiagnosticReport(opts);
  const text = JSON.stringify(report);
  expect(text).toContain("invalidNodes\\\":1");
  expect(text).toContain("nodes.id");
  expect(text).toContain("nodeId");
  expect(text).not.toContain("PRIVATE CONVERSATION");
  expect(text).not.toContain("PRIVATE TOOL OUTPUT");
  expect(text).not.toContain("token=secret");
  expect(report.context.lastError).toContain("nodes.id");
});
test("redacts common credentials, home paths, URL credentials and queries", () => {
  const output = redactDiagnosticText('Bearer abc123 password="private pass" api_key=abcdef sk-proj-secret123 https://user:pass@host/a?auth=secret#key /Users/alice/work');
  for (const secret of ["abc123", "private pass", "abcdef", "secret123", "user:pass", "auth=secret", "alice"]) expect(output).not.toContain(secret);
});
test("bounds tails and filters transcript/payload lines", () => {
  const text = Array.from({ length: 200 }, (_, i) => `[broker] sqlite projection unavailable: failure ${i}`).join("\n") + '\nTypeError: payload="PRIVATE"\n';
  const lines = diagnosticLogLines(text);
  expect(lines).toHaveLength(100);
  expect(lines[0]).toContain("100");
  expect(lines.join("\n")).not.toContain("PRIVATE");
});
test("private local copy exists before upload and survives rejection", async () => {
  const opts = await fixture();
  const receipt = await submitDiagnosticReport({ ...opts, message: "token=verysecret", diagnostics: false,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const path = join(opts.supportDirectory, "reports", `${body.id}.json`);
      expect(await readFile(path, "utf8")).not.toContain("verysecret");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      throw new Error("offline");
    }) as typeof fetch,
  });
  expect(receipt.status).toBe("saved");
  expect(receipt.error).toContain("offline");
  expect(await readFile(receipt.localPath, "utf8")).toContain(receipt.id);
});
test("only matching server acknowledgement reports success", async () => {
  const opts = await fixture();
  const fake = (async (_url, init) => Response.json({ success: true, id: JSON.parse(String(init?.body)).id })) as typeof fetch;
  expect((await submitDiagnosticReport({ ...opts, diagnostics: false, fetch: fake })).status).toBe("uploaded");
  const wrong = (async () => Response.json({ success: true, id: "wrong" })) as typeof fetch;
  expect((await submitDiagnosticReport({ ...opts, diagnostics: false, fetch: wrong })).status).toBe("saved");
});
test("sends the exact prepared preview and retries its private copy without recollecting", async () => {
  const opts = await fixture();
  const report = await collectDiagnosticReport({ ...opts, client: "web", diagnostics: false, message: "api_key=secret feedback" });
  delete report.apps.collector!.pid;
  const preview = JSON.stringify(report, null, 2);
  let calls = 0;
  const send = (async (_url, init) => {
    expect(init?.body).toBe(preview);
    expect(String(init?.body)).not.toContain("secret");
    expect(String(init?.body)).not.toContain('"pid"');
    if (++calls === 1) throw new Error("offline");
    return Response.json({ success: true, id: report.id });
  }) as typeof fetch;
  const first = await submitPreparedDiagnosticReport(report, { ...opts, fetch: send });
  expect(first.status).toBe("saved");
  await writeFile(join(opts.supportDirectory, "logs/base/broker.stderr.log"), "TypeError: NEW PRIVATE LOG\n");
  const second = await submitPreparedDiagnosticReport(report, { ...opts, fetch: send });
  expect(second.status).toBe("uploaded");
  expect(second.localPath).toBe(first.localPath);
  expect(await readFile(second.localPath, "utf8")).toBe(preview);
  expect((await stat(second.localPath)).mode & 0o777).toBe(0o600);
});
test("prepared submissions refuse unsafe IDs and changed saved copies before upload", async () => {
  const opts = await fixture();
  const report = await collectDiagnosticReport({ ...opts, diagnostics: false });
  const never = (() => { throw new Error("must not upload"); }) as typeof fetch;
  await expect(submitPreparedDiagnosticReport({ ...report, id: "../outside" }, { ...opts, fetch: never })).rejects.toThrow("Invalid diagnostic report ID");
  const saved = await submitPreparedDiagnosticReport(report, { ...opts, localOnly: true });
  await writeFile(saved.localPath, "changed");
  await expect(submitPreparedDiagnosticReport(report, { ...opts, fetch: never })).rejects.toThrow("does not match");
  expect(await readFile(saved.localPath, "utf8")).toBe("changed");
});
test("local-only and note-only never read logs or upload", async () => {
  const opts = await fixture();
  const receipt = await submitDiagnosticReport({ ...opts, diagnostics: false, localOnly: true, message: "UX feedback", fetch: (() => { throw new Error("must not fetch"); }) as typeof fetch });
  const report = JSON.parse(await readFile(receipt.localPath, "utf8"));
  expect(report.logs).toEqual([]);
  expect(report.context.reportSections).toEqual([]);
});
test("reads SQLite evidence without changing application data", async () => {
  const opts = await fixture();
  const path = join(opts.controlHome, "control-plane.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE nodes (id TEXT, name TEXT, last_seen_at INTEGER); INSERT INTO nodes VALUES ('mini', 'mini', 123)");
  db.close();
  const before = await readFile(path);
  const report = await collectDiagnosticReport(opts);
  expect(JSON.stringify(report)).toContain("mini");
  expect(await readFile(path)).toEqual(before);
});
test("labels the filing client and records a redacted sender without reading logs", async () => {
  const opts = await fixture();
  const receipt = await submitDiagnosticReport({
    ...opts, diagnostics: false, localOnly: true, message: "chat composer clips on iPhone",
    client: "mcp",
    reporter: { agentName: "openscout-bartok", harness: "codex", project: "openscout", host: "arts mini", sessionId: " ", agentId: undefined },
  });
  const report = JSON.parse(await readFile(receipt.localPath, "utf8"));
  expect(report.context.source).toBe("Scout mcp v1");
  expect(report.logs).toEqual([]);
  expect(report.context.reportSections).toEqual([{
    id: "reporter", title: "Sender",
    entries: [
      { label: "agentName", value: "openscout-bartok" },
      { label: "harness", value: "codex" },
      { label: "project", value: "openscout" },
      { label: "host", value: "arts mini" },
    ],
  }]);
});
test("unlabelled callers keep the v1 source string", async () => {
  const opts = await fixture();
  const receipt = await submitDiagnosticReport({ ...opts, diagnostics: false, localOnly: true, message: "note" });
  expect(JSON.parse(await readFile(receipt.localPath, "utf8")).context.source).toBe("Scout diagnostics v1");
});

test("reporterHarness names the harness under a Scout-managed agent", () => {
  expect(reporterHarness({ OPENSCOUT_AGENT: "hudson.main", CLAUDECODE: "1" })).toBe("claude");
  expect(reporterHarness({ OPENSCOUT_AGENT: "hudson.main" })).toBe("scout");
  expect(reporterHarness({})).toBeUndefined();
});
