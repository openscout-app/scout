import { randomUUID } from "node:crypto";
import { open, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform, release, arch, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { loadOpenScoutRuntimeBuildIdentity } from "./build-info.js";
import { detectCodingAgentHost } from "./coding-agent-host.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";

const LOG_BYTES = 64 * 1024;
const JOURNAL_BYTES = 128 * 1024 * 1024;
export const MAX_REPORT_BYTES = 1024 * 1024;
const LOGS = ["base/broker.stderr.log", "base/broker.stdout.log", "broker/stderr.log", "probes/stderr.log", "base/edge.stderr.log", "base/pairing.stderr.log", "web/supervised-web.log"];
export type DiagnosticSection = { id: string; title: string; entries: { label: string; value: string }[] };
export type DiagnosticReport = {
  id: string; timestamp: string;
  system: { os: string; osVersion: string; chip: string; memory: string };
  apps: Record<string, { running: boolean; pid?: number; version?: string }>;
  context: { source: string; userDescription: string; reportSections: DiagnosticSection[]; lastError?: string };
  logs: string[];
};
export type DiagnosticReceipt = { id: string; status: "uploaded" | "saved"; localPath: string; error?: string };
/** Which Scout surface filed the report, so triage can tell an agent's MCP
 * note from an operator's CLI note without reading the body. */
export type DiagnosticClient = "cli" | "mcp" | "scoutbot" | "ios" | "macos" | "web";
/** Who filed it, when the filer is an agent rather than the operator. Every
 * field is optional and goes through the same redaction as the note. */
export type DiagnosticReporter = {
  agentId?: string; agentName?: string; harness?: string; project?: string; host?: string; sessionId?: string;
};
export type DiagnosticOptions = {
  message?: string; diagnostics?: boolean; localOnly?: boolean; version?: string;
  client?: DiagnosticClient; reporter?: DiagnosticReporter;
  supportDirectory?: string; controlHome?: string; endpoint?: string;
  fetch?: typeof fetch;
};

/** The cloud list shows `context.source`; unlabelled callers keep the v1 string. */
/** The harness a report came from. OPENSCOUT_AGENT marks a Scout-managed
 *  agent, not which harness runs it, so look past it to the harness's own
 *  signal and fall back to "scout" only when nothing else matches. */
export function reporterHarness(env: Record<string, string | undefined>): string | undefined {
  const { OPENSCOUT_AGENT: _agent, OPENSCOUT_MANAGED_AGENT: _managed, ...harnessEnv } = env;
  return (detectCodingAgentHost(harnessEnv) ?? detectCodingAgentHost(env))?.harness;
}

export function diagnosticSource(client?: DiagnosticClient): string {
  return client ? `Scout ${client} v1` : "Scout diagnostics v1";
}

/** Applied to notes, errors and diagnostic output before either disk or network. */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED AUTH]")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|osn_session_)[A-Za-z0-9_-]+/g, "[REDACTED TOKEN]")
    // Start only at a whole credential key, not every suffix of a long word.
    .replace(/(["']?)(?<![\w.-])(?=[\w.-]*(?:token|secret|password|credential|api[_-]?key|authorization|cookie))([\w.-]+)\1(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1$2$1$3[REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
      try { const u = new URL(raw); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.toString(); } catch { return "[URL]"; }
    })
    .split(homedir()).join("~")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
}

async function readBounded(path: string, max: number, tail = false) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    const bytes = Buffer.alloc(Math.min(stat.size, max));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, tail ? Math.max(0, stat.size - max) : 0);
    let text = bytes.subarray(0, bytesRead).toString("utf8");
    if (tail && stat.size > max) text = text.slice(text.indexOf("\n") + 1);
    return { text, size: stat.size, truncated: stat.size > max, modifiedAt: stat.mtime.toISOString() };
  } finally { await file.close(); }
}

function shape(value: unknown): unknown {
  if (!value || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, v]) => [key.slice(0, 100), v === null ? "null" : Array.isArray(v) ? "array" : typeof v]));
}

// Only diagnostic lines from Scout service logs. Never read harness logs or echo
// arbitrary stdout, request bodies, prompts, tool results or conversation text.
export function diagnosticLogLines(text: string): string[] {
  return text.split("\n").filter((line) =>
    !/prompt|message.?body|userDescription|tool.?result|transcript|payload\s*[:=]/i.test(line)
    && (/^\[broker\] sqlite projection unavailable/.test(line)
      || /^\[scout-perf\] slow api (GET|POST|PUT|DELETE) /.test(line)
      || /^\[openscout-runtime\] (mesh gate enforce: denied|peer .*agent snapshot exceeded)/.test(line)
      || /^\[scoutd[^\]]*\] .*?(failed|exit|restart|timeout)/i.test(line)
      || /^\[openscout\] system probe .*?(timed out|failed|fallback)/i.test(line)
      || /^(?:TypeError|ReferenceError|SyntaxError|TimeoutError|SQLiteError):/.test(line)
      || /^\s+at (?:\S+ \()?[^\n]+:\d+:\d+\)?$/.test(line))
  ).slice(-100).map((line) => redactDiagnosticText(line).slice(0, 800));
}

async function journalHealth(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const deadline = Date.now() + 3000;
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder();
    let offset = 0, pending = "", lines = 0, malformed = 0, invalidNodes = 0;
    const examples: unknown[] = [];
    while (offset < Math.min(stat.size, JOURNAL_BYTES) && Date.now() < deadline) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, JOURNAL_BYTES - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1); lines++;
        try {
          const entry = JSON.parse(line);
          if (entry.kind === "node.upsert" && (!["id", "meshId", "name", "advertiseScope"].every((key) => typeof entry.node?.[key] === "string" && entry.node[key].trim()) || !Number.isFinite(entry.node?.registeredAt))) {
            invalidNodes++;
            if (examples.length < 10) examples.push({ line: lines, kind: entry.kind, shape: shape(entry.node) });
          }
        } catch { malformed++; }
      }
      // Bound an individual corrupt/huge record without retaining its body.
      if (pending.length > 2 * 1024 * 1024) return { size: stat.size, bytesScanned: offset, lines, malformed, invalidNodes, examples, incomplete: true, reason: "Oversized record" };
    }
    return { size: stat.size, bytesScanned: offset, lines, malformed, invalidNodes, examples, incomplete: offset < stat.size || pending.length > 0 };
  } finally { await file.close(); }
}

function databaseHealth(path: string): unknown {
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 100");
    const result: Record<string, unknown> = {};
    const queries: Record<string, string> = {
      recentDeliveryStates: "SELECT status, count(*) AS count FROM (SELECT status FROM deliveries ORDER BY created_at DESC LIMIT 1000) GROUP BY status",
      recentDeliveries: "SELECT id, message_id, invocation_id, status, transport, created_at FROM deliveries ORDER BY created_at DESC LIMIT 20",
      checkpoints: "SELECT projection_id, projection_version, barrier_id, updated_at FROM broker_journal_projection_checkpoints LIMIT 10",
      nodes: "SELECT id, name, last_seen_at FROM nodes ORDER BY last_seen_at DESC LIMIT 30",
      peers: "SELECT node_id, tier, revoked_at, last_seen_at FROM trusted_peers LIMIT 30",
    };
    for (const [key, sql] of Object.entries(queries)) {
      try { result[key] = db.query(sql).all(); } catch (e) { result[key] = String(e); }
    }
    return result;
  } finally { db.close(); }
}

export async function collectDiagnosticReport(options: DiagnosticOptions = {}): Promise<DiagnosticReport> {
  const paths = resolveOpenScoutSupportPaths();
  const support = options.supportDirectory ?? paths.supportDirectory;
  const control = options.controlHome ?? paths.controlHome;
  const sections: DiagnosticSection[] = [];
  const report: DiagnosticReport = {
    id: randomUUID(), timestamp: new Date().toISOString(),
    system: { os: platform(), osVersion: release(), chip: arch(), memory: String(totalmem()) },
    apps: { collector: { running: true, pid: process.pid, version: options.version ?? loadOpenScoutRuntimeBuildIdentity().version ?? undefined } },
    context: { source: diagnosticSource(options.client), userDescription: (options.message ?? "").slice(0, 8000), reportSections: sections }, logs: [],
  };
  const reporterEntries = Object.entries(options.reporter ?? {})
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([label, value]) => ({ label, value: (value as string).trim().slice(0, 200) }));
  if (reporterEntries.length) sections.push({ id: "reporter", title: "Sender", entries: reporterEntries });
  if (options.diagnostics !== false) {
    const add = (id: string, data: unknown) => {
      const value = JSON.stringify(data);
      sections.push({ id, title: id, entries: [{ label: "Evidence", value: value.length > 16_000 ? value.slice(0, 16_000) + " [TRUNCATED]" : value }] });
    };
    add("collection", { collectorBuild: loadOpenScoutRuntimeBuildIdentity(), databaseNote: "Read-only persisted projection; may be stale when replay is degraded. Delivery counts sample the latest 1000 records.", hostUptimeSeconds: uptime(), logTailBytes: LOG_BYTES, logLinesPerSource: 100, journalByteLimit: JOURNAL_BYTES, journalTimeLimitMs: 3000, observedAt: report.timestamp });
    for (const name of LOGS) {
      try {
        const tail = await readBounded(join(support, "logs", name), LOG_BYTES, true);
        const lines = diagnosticLogLines(tail.text);
        add(name, { size: tail.size, modifiedAt: tail.modifiedAt, truncated: tail.truncated, includedLines: lines.length });
        report.logs.push(...lines.map((line) => `[${name}] ${line}`));
      } catch (e) { add(name, { unavailable: String(e) }); }
    }
    // State/config allowlists intentionally omit arbitrary metadata and credentials.
    for (const [name, keys] of [
      ["runtime/scoutd-state.json", ["version", "gitSha", "scoutdPid", "startedAtMs", "updatedAtMs", "basePid", "baseState", "probePid", "probeState", "restartCount", "probeRestartCount", "restartBackoffMs"]],
      ["settings.json", ["brokerPort", "webPort", "pairingPort", "defaultHarness", "meshEnabled"]],
    ] as const) {
      try {
        const file = await readBounded(join(support, name), 64 * 1024);
        const data = JSON.parse(file.text);
        if (name === "runtime/scoutd-state.json") {
          for (const [service, key] of [["scoutd", "scoutdPid"], ["base", "basePid"], ["probes", "probePid"]]) {
            const pid = data[key];
            if (Number.isInteger(pid) && pid > 0) {
              let running = false;
              try { process.kill(pid, 0); running = true; } catch { /* stale service state */ }
              report.apps[service] = { running, pid, version: typeof data.version === "string" ? data.version : undefined };
            }
          }
          add("runtime-build", data.runtimeBuild ? Object.fromEntries(Object.entries(data.runtimeBuild).filter(([k]) => ["version", "commit", "buildId", "packageName", "path"].includes(k))) : { unavailable: "No runtime build identity in state file" });
        }
        add(name, { modifiedAt: file.modifiedAt, fields: Object.fromEntries(keys.filter((k) => ["string", "number", "boolean"].includes(typeof data[k])).map((k) => [k, data[k]])), shape: shape(data) });
      } catch (e) { add(name, { unavailable: String(e) }); }
    }
    try { add("journal-health", await journalHealth(join(control, "broker-journal.jsonl"))); } catch (e) { add("journal-health", { unavailable: String(e) }); }
    try { add("database-health", databaseHealth(join(control, "control-plane.sqlite"))); } catch (e) { add("database-health", { unavailable: String(e) }); }
    report.context.lastError = [...report.logs].reverse().find((line) => /projection unavailable|Error:/.test(line));
  }
  // Redact string leaves without changing JSON syntax (sections contain serialized evidence).
  const clean = (value: unknown): unknown => typeof value === "string" ? redactDiagnosticText(value)
    : Array.isArray(value) ? value.map(clean)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value;
  const redacted = clean(report) as DiagnosticReport;
  // JSON escaping can expand a bounded text excerpt. Trim oldest log evidence
  // rather than lose the entire report when the final envelope is too large.
  if (Buffer.byteLength(JSON.stringify(redacted, null, 2)) > MAX_REPORT_BYTES) {
    redacted.context.reportSections.push({ id: "envelope-limit", title: "Collection limit", entries: [{ label: "Truncated", value: "Oldest included log lines removed to fit 1 MiB" }] });
    while (redacted.logs.length && Buffer.byteLength(JSON.stringify(redacted, null, 2)) > MAX_REPORT_BYTES) redacted.logs.splice(0, 25);
  }
  return redacted;
}

export async function submitDiagnosticReport(options: DiagnosticOptions = {}): Promise<DiagnosticReceipt> {
  const report = await collectDiagnosticReport(options);
  return submitPreparedDiagnosticReport(report, options);
}

/** Send an already collected, redacted report without collecting more data.
 * A UI can minimize and preview a collector result, obtain consent, then send
 * those exact bytes. Never pass an untrusted request body as the report. */
export async function submitPreparedDiagnosticReport(
  report: DiagnosticReport,
  options: Pick<DiagnosticOptions, "supportDirectory" | "localOnly" | "endpoint" | "fetch"> = {},
): Promise<DiagnosticReceipt> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(report.id)) throw new Error("Invalid diagnostic report ID");
  const body = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new Error("Diagnostic report exceeds 1 MiB limit");
  const directory = join(options.supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory, "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = join(directory, `${report.id}.json`);
  try {
    await writeFile(localPath, body, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Retry an offline submission using the identical private copy. A changed,
    // linked, public or foreign copy must never be silently overwritten.
    const file = await open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())
        || stat.size !== Buffer.byteLength(body) || await file.readFile("utf8") !== body)
        throw new Error("Saved diagnostic report does not match the prepared report");
    } finally { await file.close(); }
  }
  const saved: DiagnosticReceipt = { id: report.id, status: "saved", localPath };
  if (options.localOnly) return saved;
  try {
    const endpoint = new URL(options.endpoint ?? process.env.OPENSCOUT_FEEDBACK_REPORT_URL ?? "https://api.openscout.app/api/feedback");
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))) throw new Error("Report endpoint must use HTTPS (HTTP allowed on loopback only)");
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    const payload = await response.json() as { success?: boolean; id?: string };
    if (!response.ok || payload.success !== true || payload.id !== report.id) throw new Error(`Report upload was not acknowledged (${response.status})`);
    return { ...saved, status: "uploaded" };
  } catch (e) { return { ...saved, error: redactDiagnosticText(String(e)).slice(0, 500) }; }
}

export function formatDiagnosticReceipt(receipt: DiagnosticReceipt): string {
  return `${receipt.status === "uploaded" ? "Report uploaded" : "Report saved locally"}: ${receipt.id}\nLocal copy: ${receipt.localPath}${receipt.error ? `\nUpload failed: ${receipt.error}` : ""}`;
}
