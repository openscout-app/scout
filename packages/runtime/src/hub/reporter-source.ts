/**
 * The Scout Hub reporter, as the exact text `scout hub connect claude-code`
 * writes to `.claude/scout/report.mjs` in a repo. It runs inside a vendor's
 * sandbox from a Claude Code hook, so it is one file with no dependencies.
 *
 * Keep it free of backticks and dollar-brace sequences: it lives in a raw
 * template literal. reporter.test.ts runs this text under Node.
 */

export const REPORTER_VERSION = 1;

export const REPORTER_SOURCE = String.raw`#!/usr/bin/env node
// Scout Hub reporter for Claude Code cloud sessions, version 1.
// Written by "scout hub connect claude-code". One file, no dependencies, Node 18+.
//
// A hook runs it with the hook's JSON on stdin. It reads hub.json next to this
// file, takes the transcript bytes added since its last run (whole lines only),
// seals them to your Scout runtime's public key and posts them to your inbox.
// The inbox cannot read them. It writes nothing to stdout, always exits 0, and
// sends from a detached child so the session never waits on the network.
// Errors go to <tmp>/openscout-hub/<session>/report.log.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPORTER_VERSION = 1;
const LABEL = Buffer.from("openscout.hub.v1", "utf8");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const MAX_PIECE_BYTES = 4 * 1024 * 1024;
const SEND_TIMEOUT_MS = 20000;
const WAIT_TIMEOUT_MS = 30000;
const SCRIPT = fileURLToPath(import.meta.url);

function stateRoot() {
  return process.env.SCOUT_HUB_STATE_DIR || join(tmpdir(), "openscout-hub");
}

function log(stateDir, message) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "report.log"), new Date().toISOString() + " " + message + "\n");
  } catch {}
}

export function loadConfig() {
  const path = process.env.SCOUT_HUB_CONFIG || join(dirname(SCRIPT), "hub.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const inbox = String(process.env.SCOUT_HUB_INBOX || config.inbox || "").replace(/\/+$/, "");
  const token = String(process.env.SCOUT_HUB_TOKEN || config.token || "");
  const recipient = Buffer.from(String(config.recipient || ""), "base64url");
  const label = String(config.label || "");
  if (!/^https?:\/\//.test(inbox)) throw new Error("hub.json has no inbox URL");
  if (!token) throw new Error("hub.json has no token");
  if (recipient.length !== 32) throw new Error("hub.json has no 32-byte recipient key");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(label)) throw new Error("hub.json label must be letters, digits, dot, dash or underscore");
  return { inbox, token, recipient, label };
}

export function seal(header, data, recipient) {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublic = ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, recipient]), format: "der", type: "spki" }),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, LABEL, Buffer.concat([ephemeralPublic, recipient]), 32));
  const nonce = randomBytes(12);
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(LABEL);
  const body = Buffer.concat([cipher.update(Buffer.concat([length, head, data])), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), ephemeralPublic, nonce, body, cipher.getAuthTag()]);
}

// The session's transcript plus its subagents' transcripts, with paths
// relative to the project folder, the way Claude lays them out.
export function sourceFiles(transcriptPath) {
  const sessionName = basename(transcriptPath, ".jsonl");
  const out = [{ path: transcriptPath, rel: sessionName + ".jsonl" }];
  const subagents = join(dirname(transcriptPath), sessionName, "subagents");
  const dirs = [{ path: subagents, rel: sessionName + "/subagents" }];
  try {
    for (const run of readdirSync(join(subagents, "workflows"), { withFileTypes: true })) {
      if (run.isDirectory()) dirs.push({ path: join(subagents, "workflows", run.name), rel: sessionName + "/subagents/workflows/" + run.name });
    }
  } catch {}
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir.path); } catch {}
    for (const name of names) {
      if (/^agent-[A-Za-z0-9]+\.jsonl$/.test(name)) out.push({ path: join(dir.path, name), rel: dir.rel + "/" + name });
    }
  }
  return out;
}

// Whole lines from offset to the last newline, cut into pieces of at most
// MAX_PIECE_BYTES at line ends. A single longer line goes as one piece.
export function readPieces(path, offset, maxPiece) {
  const limit = maxPiece || MAX_PIECE_BYTES;
  let fd;
  try { fd = openSync(path, "r"); } catch { return { pieces: [], size: 0 }; }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { pieces: [], size };
    const buffer = Buffer.alloc(size - offset);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const usable = buffer.lastIndexOf(10, read - 1) + 1;
    const pieces = [];
    let start = 0;
    while (start < usable) {
      let end = Math.min(start + limit, usable);
      if (end < usable) {
        let cut = buffer.lastIndexOf(10, end - 1);
        if (cut < start) cut = buffer.indexOf(10, end);
        end = cut + 1;
      }
      pieces.push({ offset: offset + start, data: buffer.subarray(start, end) });
      start = end;
    }
    return { pieces, size };
  } finally {
    closeSync(fd);
  }
}

function loadState(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")); } catch { return { files: {} }; }
}

function saveState(stateDir, state) {
  const tmp = join(stateDir, "state.json." + process.pid);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(stateDir, "state.json"));
}

function acquireLock(stateDir, waitMs) {
  const lock = join(stateDir, "lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(lock); return lock; } catch {}
    try {
      if (Date.now() - statSync(lock).mtimeMs > 120000) { rmSync(lock, { recursive: true, force: true }); continue; }
    } catch { continue; }
    if (Date.now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

async function post(config, body) {
  const url = config.inbox + "/v1/inbox/chunks";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + config.token, "content-type": "application/octet-stream", "x-scout-reporter": String(REPORTER_VERSION) },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.status;
  } catch (error) {
    // Some sandboxes only let traffic out through an HTTP proxy that Node's
    // fetch does not use. curl does.
    return postWithCurl(url, config.token, body, error);
  }
}

// curl reads its config (URL and token) from stdin; the body goes through a
// private temp file so the token never appears in a process listing.
function postWithCurl(url, token, body, cause) {
  return new Promise((done) => {
    let bodyPath;
    try {
      const dir = join(stateRoot(), ".curl");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      bodyPath = join(dir, process.pid + "-" + Date.now() + ".bin");
      writeFileSync(bodyPath, body, { mode: 0o600 });
    } catch (error) { done("fetch failed (" + String(cause && cause.message) + "), temp file: " + error.message); return; }
    const finish = (value) => { try { rmSync(bodyPath, { force: true }); } catch {} done(value); };
    const child = spawn("curl", ["-sS", "-m", "25", "-o", "/dev/null", "-w", "%{http_code}", "-K", "-", "--data-binary", "@" + bodyPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", () => finish("fetch failed (" + String(cause && cause.message) + "), no curl"));
    child.on("close", () => finish(Number(out) || ("curl: " + err.trim().slice(0, 200))));
    child.stdin.end([
      "url = " + JSON.stringify(url),
      "request = \"POST\"",
      "header = " + JSON.stringify("Authorization: Bearer " + token),
      "header = \"Content-Type: application/octet-stream\"",
      "header = \"X-Scout-Reporter: " + REPORTER_VERSION + "\"",
    ].join("\n") + "\n");
  });
}

export async function flushSession(input, options) {
  const opts = options || {};
  const sessionId = String(input.session_id || "");
  const transcriptPath = String(input.transcript_path || "");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(sessionId) || !transcriptPath) return { sent: 0, skipped: "no session" };
  const stateDir = join(stateRoot(), sessionId);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let config;
  try { config = opts.config || loadConfig(); } catch (error) { log(stateDir, "config: " + error.message); return { sent: 0, skipped: "config" }; }
  const lock = acquireLock(stateDir, opts.lockWaitMs == null ? 0 : opts.lockWaitMs);
  if (!lock) return { sent: 0, skipped: "busy" };
  let sent = 0;
  try {
    const state = loadState(stateDir);
    for (const file of sourceFiles(transcriptPath)) {
      const entry = state.files[file.rel] || { offset: 0, seq: 0 };
      const { pieces, size } = readPieces(file.path, entry.offset, opts.maxPieceBytes);
      if (size < entry.offset) { log(stateDir, file.rel + " shrank from " + entry.offset + " to " + size + "; not sent"); continue; }
      for (const piece of pieces) {
        const header = {
          v: 1,
          kind: "claude-code.transcript",
          sessionId,
          remoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID || null,
          label: config.label,
          file: file.rel,
          offset: piece.offset,
          seq: entry.seq,
          cwd: input.cwd ? String(input.cwd) : null,
          sentAt: new Date().toISOString(),
        };
        const status = await post(config, seal(header, piece.data, config.recipient));
        if (status !== 201 && status !== 200) {
          log(stateDir, file.rel + " @" + piece.offset + ": inbox answered " + status);
          return { sent, skipped: "inbox " + status };
        }
        entry.offset = piece.offset + piece.data.length;
        entry.seq += 1;
        state.files[file.rel] = entry;
        saveState(stateDir, state);
        sent += 1;
      }
    }
    return { sent };
  } catch (error) {
    log(stateDir, "flush: " + (error && error.stack || error));
    return { sent, skipped: "error" };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

export async function main(argv) {
  const command = argv[0] || "flush";
  const has = (flag) => argv.includes(flag);
  if (command === "version") { process.stdout.write("scout-hub-reporter " + REPORTER_VERSION + "\n"); return; }
  if (command !== "flush") return;
  if (!has("--force") && process.env.CLAUDE_CODE_REMOTE !== "true") return;

  if (has("--child")) {
    const inputPath = argv[argv.indexOf("--input") + 1];
    let input = {};
    try { input = JSON.parse(readFileSync(inputPath, "utf8")); } catch {}
    try { rmSync(inputPath, { force: true }); } catch {}
    await flushSession(input, { lockWaitMs: has("--wait") ? 10000 : 0 });
    return;
  }

  // The hook's own process: hand the work to a child and return.
  const raw = readStdin();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { return; }
  const sessionId = String(input.session_id || "");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(sessionId)) return;
  const stateDir = join(stateRoot(), sessionId);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const inputPath = join(stateDir, "input-" + process.pid + "-" + Date.now() + ".json");
  writeFileSync(inputPath, raw, { mode: 0o600 });
  const args = [SCRIPT, "flush", "--child", "--input", inputPath];
  if (has("--force")) args.push("--force");
  if (has("--wait")) args.push("--wait");
  const child = spawn(process.execPath, args, {
    detached: !has("--wait"),
    stdio: "ignore",
    env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: "1" }),
  });
  if (!has("--wait")) { child.unref(); return; }
  // At the end of a turn the sandbox may pause, so wait for the send, briefly.
  await new Promise((done) => {
    const timer = setTimeout(done, WAIT_TIMEOUT_MS);
    child.on("exit", () => { clearTimeout(timer); done(); });
    child.on("error", () => { clearTimeout(timer); done(); });
  });
}

function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SCRIPT); } catch { return false; }
}

if (isMain()) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(0));
}
`;
