import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "fs";
import { BlockList, isIP } from "node:net";
import { isAbsolute, join, relative, sep } from "path";
import { homedir } from "os";
import type {
  ActionBlock,
  Block,
  QuestionBlock,
  SessionState,
} from "@openscout/agent-sessions";
import type { Bridge } from "./bridge.ts";
import {
  readAuthorizedWebHandoff,
  SCOUT_WEB_HANDOFF_COOKIE,
  type WebHandoffScope,
} from "./web-handoff.ts";
import { serveArtifactPresentation } from "./artifact-presentation.ts";
import { resolveOpenScoutPairingHome } from "@openscout/runtime/config";

// Allowed roots — file requests must resolve under one of these.
const ALLOWED_ROOTS = [homedir(), "/tmp"];
const LOOPBACK_PEERS = new BlockList();
LOOPBACK_PEERS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_PEERS.addAddress("::1", "ipv6");
LOOPBACK_PEERS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
function pairingAttachmentRoot(): string {
  return join(resolveOpenScoutPairingHome(), "attachments");
}
const PAIRING_ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1000;
const PAIRING_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const PAIRING_ATTACHMENT_PATH_PREFIX = "/attachments/";

type StoredPairingAttachment = {
  id: string;
  path: string;
  mediaType: string;
  fileName?: string;
  size: number;
  expiresAt: number;
};

const attachmentBlobs = new Map<string, StoredPairingAttachment>();

export type PairingAttachmentUploadInput = {
  data: string;
  mediaType: string;
  fileName?: string | null;
};

export type PairingAttachmentUploadResult = {
  id: string;
  url: string;
  mediaType: string;
  fileName?: string;
  size: number;
  expiresAt: number;
};

/// One hosted blob handed back as bytes rather than as a link. The URL in an
/// upload result names an origin on THIS Mac, so it only resolves for something
/// running here — a phone that follows it reaches its own loopback and renders a
/// placeholder. Paired clients ask for the bytes over the bridge instead.
export type PairingAttachmentBlob = {
  id: string;
  mediaType: string;
  fileName?: string;
  size: number;
  /** base64, the same encoding the upload accepts. */
  data: string;
};

export function pairingFileServerOrigin(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}`;
}

export function storePairingAttachmentBlob(
  input: PairingAttachmentUploadInput,
  options: { origin: string; now?: number } | { port: number; host?: string; now?: number },
): PairingAttachmentUploadResult {
  const mediaType = normalizeMediaType(input.mediaType);
  if (!mediaType) {
    throw new Error("mediaType is required");
  }
  const data = Buffer.from(input.data, "base64");
  if (data.length === 0) {
    throw new Error("attachment data is empty");
  }
  if (data.length > PAIRING_ATTACHMENT_MAX_BYTES) {
    throw new Error(`attachment exceeds ${PAIRING_ATTACHMENT_MAX_BYTES} bytes`);
  }

  mkdirSync(pairingAttachmentRoot(), { recursive: true, mode: 0o700 });
  purgeExpiredPairingAttachments(options.now);

  const id = `att-${randomUUID()}`;
  const path = join(pairingAttachmentRoot(), id);
  writeFileSync(path, data, { mode: 0o600 });

  const now = options.now ?? Date.now();
  const entry: StoredPairingAttachment = {
    id,
    path,
    mediaType,
    fileName: sanitizeAttachmentFileName(input.fileName),
    size: data.length,
    expiresAt: now + PAIRING_ATTACHMENT_TTL_MS,
  };
  attachmentBlobs.set(id, entry);
  // The index is in memory, so a broker restart used to lose every live
  // attachment while its bytes sat on disk — the id in the message stayed
  // valid and answered 404 for the rest of its TTL. The sidecar is what lets
  // a lookup rebuild the entry from the file it already has.
  writeAttachmentSidecar(entry);

  const origin = "origin" in options
    ? options.origin
    : pairingFileServerOrigin(options.port, options.host);
  return {
    id,
    url: `${origin.replace(/\/$/, "")}${PAIRING_ATTACHMENT_PATH_PREFIX}${encodeURIComponent(id)}`,
    mediaType: entry.mediaType,
    fileName: entry.fileName,
    size: entry.size,
    expiresAt: entry.expiresAt,
  };
}

/// Read a hosted blob back as bytes, for a client that cannot follow the URL.
/// Returns null for an id that never existed, has expired, or whose file is
/// gone — the caller reports "not found" and never a partial read.
export function readPairingAttachmentBlob(
  id: string,
  now = Date.now(),
): PairingAttachmentBlob | null {
  const entry = resolvePairingAttachment(id.trim(), now);
  if (!entry) {
    return null;
  }
  let data: Buffer;
  try {
    data = readFileSync(entry.path);
  } catch {
    forgetPairingAttachment(entry.id);
    return null;
  }
  return {
    id: entry.id,
    mediaType: entry.mediaType,
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
    size: data.length,
    data: data.toString("base64"),
  };
}

/// The live entry for an id: the in-memory one when this process stored it,
/// otherwise rebuilt from the sidecar so the bytes survive a broker restart.
/// Expiry is enforced on both paths.
function resolvePairingAttachment(id: string, now: number): StoredPairingAttachment | null {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return null;
  }
  const known = attachmentBlobs.get(id);
  if (known) {
    if (known.expiresAt <= now || !existsSync(known.path)) {
      forgetPairingAttachment(id);
      return null;
    }
    return known;
  }
  const rehydrated = readAttachmentSidecar(id);
  if (!rehydrated || rehydrated.expiresAt <= now || !existsSync(rehydrated.path)) {
    return null;
  }
  attachmentBlobs.set(id, rehydrated);
  return rehydrated;
}

function attachmentSidecarPath(id: string): string {
  return join(pairingAttachmentRoot(), `${id}.json`);
}

function writeAttachmentSidecar(entry: StoredPairingAttachment): void {
  try {
    writeFileSync(
      attachmentSidecarPath(entry.id),
      JSON.stringify({
        id: entry.id,
        mediaType: entry.mediaType,
        fileName: entry.fileName,
        size: entry.size,
        expiresAt: entry.expiresAt,
      }),
      { mode: 0o600 },
    );
  } catch {
    // Best effort: without it the blob simply stops surviving a restart.
  }
}

function readAttachmentSidecar(id: string): StoredPairingAttachment | null {
  try {
    const raw = JSON.parse(readFileSync(attachmentSidecarPath(id), "utf8")) as {
      id?: string;
      mediaType?: string;
      fileName?: string;
      size?: number;
      expiresAt?: number;
    };
    const mediaType = normalizeMediaType(raw.mediaType);
    if (raw.id !== id || !mediaType || typeof raw.expiresAt !== "number") {
      return null;
    }
    return {
      id,
      path: join(pairingAttachmentRoot(), id),
      mediaType,
      fileName: sanitizeAttachmentFileName(raw.fileName),
      size: typeof raw.size === "number" ? raw.size : 0,
      expiresAt: raw.expiresAt,
    };
  } catch {
    return null;
  }
}

function forgetPairingAttachment(id: string): void {
  attachmentBlobs.delete(id);
  for (const path of [join(pairingAttachmentRoot(), id), attachmentSidecarPath(id)]) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort cleanup only; the opaque id is already forgotten.
    }
  }
}

export function isTrustedLoopbackPeerAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  const zone = normalized.indexOf("%");
  if (zone >= 0) normalized = normalized.slice(0, zone);

  const family = isIP(normalized);
  if (family === 4) return LOOPBACK_PEERS.check(normalized, "ipv4");
  if (family === 6) return LOOPBACK_PEERS.check(normalized, "ipv6");
  return false;
}

function isTrustedLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || isTrustedLoopbackPeerAddress(normalized);
}

function isTrustedLocalFileRequest(
  req: Request,
  url: URL,
  peerAddress: string | null | undefined,
): boolean {
  if (!isTrustedLoopbackPeerAddress(peerAddress) || !isTrustedLoopbackHostname(url.hostname)) {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!isTrustedLoopbackHostname(originUrl.hostname) || originUrl.origin !== url.origin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const fetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

type AllowedFileResolution =
  | { status: "allowed"; path: string }
  | { status: "forbidden" }
  | { status: "missing" };

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isAllowedHomeRelativePath(rel: string, pairingRel: string): boolean {
  if (!rel.startsWith(".")) return true;
  const pairingAllowed = pairingRel.length > 0 && !pairingRel.startsWith("..") && !isAbsolute(pairingRel);
  return rel === ".claude"
    || rel.startsWith(`.claude${sep}`)
    || (pairingAllowed && (rel === pairingRel || rel.startsWith(`${pairingRel}${sep}`)));
}

/** This instance's pairing home relative to $HOME (`.scout/pairing` for prod). */
function pairingHomeRelativePath(canonicalHome: string): string {
  const pairingHome = resolveOpenScoutPairingHome();
  let canonical = pairingHome;
  try {
    canonical = realpathSync(pairingHome);
  } catch {
    // Not created yet: compare the configured path.
  }
  return relative(canonicalHome, canonical);
}

function resolveAllowedFile(filePath: string): AllowedFileResolution {
  if (!isAbsolute(filePath)) return { status: "forbidden" };

  let candidate: string;
  try {
    candidate = realpathSync(filePath);
  } catch {
    return { status: "missing" };
  }

  const canonicalHome = realpathSync(homedir());
  for (const configuredRoot of ALLOWED_ROOTS) {
    const root = realpathSync(configuredRoot);
    if (!isInsideRoot(root, candidate)) continue;
    if (root === canonicalHome && !isAllowedHomeRelativePath(relative(root, candidate), pairingHomeRelativePath(canonicalHome))) {
      return { status: "forbidden" };
    }
    try {
      return statSync(candidate).isFile()
        ? { status: "allowed", path: candidate }
        : { status: "missing" };
    } catch {
      return { status: "missing" };
    }
  }
  return { status: "forbidden" };
}

// ---------------------------------------------------------------------------
// File Server
// ---------------------------------------------------------------------------

export interface FileServer {
  port: number;
  stop: () => void;
  restart: () => void;
}

type HandoffBridge = Pick<Bridge, "getSessionSnapshot">;

export function startFileServer(options: {
  port: number;
  bridge?: HandoffBridge;
  hostname?: string;
  /** Test seam; production requests always use Bun's socket peer address. */
  resolvePeerAddress?: (req: Request) => string | null | undefined;
}): FileServer {
  const { port, bridge, hostname = "0.0.0.0" } = options;

  let server: ReturnType<typeof Bun.serve> | null = null;

  function start(): void {
    try {
      server = Bun.serve({
        port,
        hostname,
        fetch(req, bunServer) {
          try {
            const peerAddress = options.resolvePeerAddress
              ? options.resolvePeerAddress(req)
              : bunServer.requestIP(req)?.address;
            return route(req, new URL(req.url), bridge, peerAddress);
          } catch (err: any) {
            console.error(`[fileserver] ${req.url} →`, err.message);
            return new Response("Internal error", { status: 500 });
          }
        },
      });
      console.log(`[fileserver] http://${hostname}:${port}`);
    } catch (err: any) {
      console.error(`[fileserver] failed to start: ${err.message}`);
    }
  }

  function stop(): void { server?.stop(); server = null; }
  function restart(): void { stop(); start(); }

  start();
  return { port, stop, restart };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function route(
  req: Request,
  url: URL,
  bridge?: HandoffBridge,
  peerAddress?: string | null,
): Response {
  const path = url.pathname;

  // A capability-scoped directory mount. Unlike /file, this route is meant to
  // be reached from the paired phone over LAN or Tailnet; the unguessable grant
  // id scopes it to one short-lived artifact tree.
  const presentation = serveArtifactPresentation(req, url);
  if (presentation) return presentation;

  // API
  if (path === "/file") {
    if (!isTrustedLocalFileRequest(req, url, peerAddress)) {
      return new Response("Forbidden", { status: 403 });
    }
    return serveFile(url);
  }
  if (path === "/health") return Response.json({ ok: true });
  if (path.startsWith(PAIRING_ATTACHMENT_PATH_PREFIX)) {
    return servePairingAttachment(url);
  }
  if (path.startsWith("/handoff/")) {
    return serveHandoffPage(req, url, bridge);
  }

  return new Response("Pairing file server", { status: 200 });
}

// ---------------------------------------------------------------------------
// GET /file?path= — serve any allowed local file
// ---------------------------------------------------------------------------

function serveFile(url: URL): Response {
  const filePath = url.searchParams.get("path");
  if (!filePath) return new Response("Missing ?path=", { status: 400 });
  const resolved = resolveAllowedFile(filePath);
  if (resolved.status === "forbidden") return new Response("Forbidden", { status: 403 });
  if (resolved.status === "missing") return new Response("Not found", { status: 404 });
  return new Response(Bun.file(resolved.path));
}

function servePairingAttachment(url: URL): Response {
  purgeExpiredPairingAttachments();
  const id = decodeURIComponent(url.pathname.slice(PAIRING_ATTACHMENT_PATH_PREFIX.length)).trim();
  if (!id) {
    return new Response("Missing attachment id", { status: 400 });
  }
  const entry = resolvePairingAttachment(id, Date.now());
  if (!entry) {
    return new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "content-type": entry.mediaType,
    "cache-control": "private, max-age=3600",
    "content-length": String(entry.size),
    "x-content-type-options": "nosniff",
  };
  if (entry.fileName) {
    headers["content-disposition"] = `inline; filename="${entry.fileName.replace(/"/g, "")}"`;
  }
  return new Response(Bun.file(entry.path), { headers });
}

function normalizeMediaType(value: string | undefined | null): string | null {
  const mediaType = value?.trim().toLowerCase();
  if (!mediaType || mediaType.length > 127 || /[\r\n]/.test(mediaType)) {
    return null;
  }
  return mediaType;
}

function sanitizeAttachmentFileName(value: string | undefined | null): string | undefined {
  const sanitized = value
    ?.trim()
    .replace(/[\/\\:\0-\x1F\x7F]+/g, "-")
    .replace(/^\.*/, "")
    .slice(0, 160);
  return sanitized || undefined;
}

function purgeExpiredPairingAttachments(now = Date.now()): void {
  for (const entry of attachmentBlobs.values()) {
    if (entry.expiresAt > now) {
      continue;
    }
    forgetPairingAttachment(entry.id);
  }
}

function serveHandoffPage(
  req: Request,
  url: URL,
  bridge?: HandoffBridge,
): Response {
  if (!bridge) {
    return new Response("Secure handoff unavailable", { status: 503 });
  }

  const scope = parseHandoffScope(url);
  if (!scope) {
    return new Response("Not found", { status: 404 });
  }

  const token = readHandoffToken(req);
  const authorized = readAuthorizedWebHandoff(token, scope);
  if (!authorized) {
    return unauthorizedHandoffResponse();
  }

  let html: string;
  switch (scope.kind) {
    case "session": {
      const snapshot = bridge.getSessionSnapshot(scope.sessionId);
      if (!snapshot) {
        return new Response("Session handoff expired", { status: 404 });
      }
      html = renderSessionHandoffPage(snapshot);
      break;
    }
    case "file_change": {
      const snapshot = bridge.getSessionSnapshot(scope.sessionId);
      if (!snapshot) {
        return new Response("Session handoff expired", { status: 404 });
      }
      const target = findFileChangeBlock(snapshot, scope.turnId, scope.blockId);
      if (!target) {
        return new Response("File change handoff expired", { status: 404 });
      }
      html = renderFileChangeHandoffPage(snapshot, target.turn, target.block);
      break;
    }
  }

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  headers.set(
    "set-cookie",
    `${SCOUT_WEB_HANDOFF_COOKIE}=${authorized.token}; Max-Age=300; Path=/handoff; HttpOnly; SameSite=Strict`,
  );
  return new Response(html, { status: 200, headers });
}

function unauthorizedHandoffResponse(): Response {
  return new Response("Secure handoff required", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "set-cookie": `${SCOUT_WEB_HANDOFF_COOKIE}=; Max-Age=0; Path=/handoff; HttpOnly; SameSite=Strict`,
    },
  });
}

function parseHandoffScope(url: URL): WebHandoffScope | null {
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== "handoff") {
    return null;
  }
  if (parts[1] === "session" && parts[2]) {
    return { kind: "session", sessionId: parts[2] };
  }
  if (parts[1] === "file-change" && parts[2] && parts[3] && parts[4]) {
    return {
      kind: "file_change",
      sessionId: parts[2],
      turnId: parts[3],
      blockId: parts[4],
    };
  }
  return null;
}

function readHandoffToken(req: Request): string | null {
  const headerToken = req.headers.get("x-scout-handoff-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SCOUT_WEB_HANDOFF_COOKIE) {
      const value = rest.join("=").trim();
      return value || null;
    }
  }
  return null;
}

function findFileChangeBlock(
  snapshot: SessionState,
  turnId: string,
  blockId: string,
): { turn: SessionState["turns"][number]; block: ActionBlock } | null {
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  if (!turn) {
    return null;
  }
  const blockState = turn.blocks.find((candidate) => candidate.block.id === blockId);
  const block = blockState?.block;
  if (!block || block.type !== "action" || block.action.kind !== "file_change") {
    return null;
  }
  return { turn, block };
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f14;
        --panel: rgba(19, 27, 39, 0.92);
        --panel-strong: rgba(12, 18, 28, 0.96);
        --line: rgba(148, 163, 184, 0.16);
        --line-strong: rgba(148, 163, 184, 0.24);
        --text: #e5ecf5;
        --muted: #90a0b4;
        --accent: #63d0ff;
        --green: #54d38a;
        --amber: #f8c36a;
        --red: #ff7b72;
        --surface-add: rgba(84, 211, 138, 0.08);
        --surface-del: rgba(255, 123, 114, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(99, 208, 255, 0.12), transparent 32%),
          linear-gradient(180deg, #090d12 0%, #0b0f14 55%, #111723 100%);
        color: var(--text);
        font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      .wrap {
        width: min(980px, calc(100vw - 24px));
        margin: 0 auto;
        padding: 20px 0 40px;
      }
      .hero, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
      }
      .hero {
        padding: 18px 18px 16px;
        margin-bottom: 14px;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 14px rgba(99, 208, 255, 0.65);
      }
      h1 {
        margin: 12px 0 10px;
        font-size: 24px;
        line-height: 1.15;
      }
      .meta, .stack {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid var(--line-strong);
        background: rgba(255, 255, 255, 0.03);
        color: var(--muted);
        font-size: 12px;
      }
      .pill strong {
        color: var(--text);
        font-weight: 600;
      }
      .stack { flex-direction: column; }
      .panel {
        margin-top: 12px;
        overflow: hidden;
      }
      .panel-inner {
        padding: 16px;
      }
      .turn {
        border-top: 1px solid var(--line);
      }
      .turn:first-child {
        border-top: none;
      }
      .turn-head {
        padding: 14px 16px;
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        background: rgba(255, 255, 255, 0.02);
      }
      .turn-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .turn-subtitle {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .blocks {
        padding: 8px;
      }
      .block {
        padding: 12px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        margin: 8px;
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }
      .block-type {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
      }
      .label {
        color: var(--muted);
        font-size: 12px;
      }
      .label strong {
        color: var(--text);
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .code {
        padding: 12px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.02);
      }
      .diff-line-add { background: var(--surface-add); color: #8ef3b7; }
      .diff-line-del { background: var(--surface-del); color: #ff9d96; }
      .details {
        margin-top: 10px;
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
      }
      details > summary {
        list-style: none;
        cursor: pointer;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.03);
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      details[open] > summary {
        border-bottom: 1px solid var(--line);
      }
      .empty {
        padding: 28px 18px;
        color: var(--muted);
      }
      .grid {
        display: grid;
        gap: 10px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      a.inline {
        color: var(--accent);
        text-decoration: none;
      }
      .status-streaming { color: var(--amber); }
      .status-completed { color: var(--green); }
      .status-failed, .status-error { color: var(--red); }
    </style>
  </head>
  <body>
    <main class="wrap">
      ${body}
    </main>
  </body>
</html>`;
}

function renderSessionHandoffPage(snapshot: SessionState): string {
  const title = snapshot.session.name || snapshot.session.id;
  const hero = `
    <section class="hero">
      <div class="eyebrow"><span class="dot"></span> Secure Proxy Session Handoff</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span class="pill"><strong>ID</strong> ${escapeHtml(snapshot.session.id)}</span>
        <span class="pill"><strong>Adapter</strong> ${escapeHtml(snapshot.session.adapterType)}</span>
        <span class="pill"><strong>Status</strong> ${escapeHtml(snapshot.session.status)}</span>
        ${snapshot.session.model ? `<span class="pill"><strong>Model</strong> ${escapeHtml(snapshot.session.model)}</span>` : ""}
        ${snapshot.session.cwd ? `<span class="pill"><strong>Workspace</strong> ${escapeHtml(snapshot.session.cwd)}</span>` : ""}
      </div>
    </section>
  `;

  const turns = snapshot.turns.length > 0
    ? snapshot.turns.map((turn) => {
      const turnBody = turn.blocks.length > 0
        ? turn.blocks.map(({ block }) => renderBlock(block)).join("")
        : `<div class="empty">No blocks were captured for this turn.</div>`;
      return `
        <section class="turn">
          <div class="turn-head">
            <div>
              <div class="turn-title">${escapeHtml(turn.id)}</div>
              <div class="turn-subtitle">${formatTimestamp(turn.startedAt)}${turn.endedAt ? ` to ${formatTimestamp(turn.endedAt)}` : ""}</div>
            </div>
            <span class="pill"><strong>Turn</strong> <span class="status-${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span></span>
          </div>
          <div class="blocks">${turnBody}</div>
        </section>
      `;
    }).join("")
    : `<div class="empty">This session has not produced any turns yet.</div>`;

  return renderPage(title, `${hero}<section class="panel">${turns}</section>`);
}

function renderFileChangeHandoffPage(
  snapshot: SessionState,
  turn: SessionState["turns"][number],
  block: ActionBlock,
): string {
  const action = block.action;
  if (action.kind !== "file_change") {
    throw new Error("renderFileChangeHandoffPage requires a file_change action");
  }
  const title = action.path || snapshot.session.name || snapshot.session.id;
  const hero = `
    <section class="hero">
      <div class="eyebrow"><span class="dot"></span> Secure Proxy File Change</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span class="pill"><strong>Session</strong> ${escapeHtml(snapshot.session.name || snapshot.session.id)}</span>
        <span class="pill"><strong>Turn</strong> ${escapeHtml(turn.id)}</span>
        <span class="pill"><strong>Status</strong> ${escapeHtml(action.status)}</span>
      </div>
    </section>
  `;

  const body = `
    <section class="panel">
      <div class="panel-inner stack">
        <div class="grid two">
          <div class="pill"><strong>Path</strong> ${escapeHtml(action.path)}</div>
          <div class="pill"><strong>Block</strong> ${escapeHtml(block.id)}</div>
        </div>
        ${action.diff ? renderDetailsSection("Diff", renderDiff(action.diff), true) : `<div class="empty">No diff was recorded for this action.</div>`}
        ${action.output ? renderDetailsSection("Output", `<div class="code"><pre>${escapeHtml(action.output)}</pre></div>`) : ""}
      </div>
    </section>
  `;

  return renderPage(title, `${hero}${body}`);
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "text":
      return renderTextLikeBlock("Text", block.text);
    case "reasoning":
      return renderTextLikeBlock("Reasoning", block.text);
    case "error":
      return `
        <article class="block">
          <div class="block-head">
            <div class="block-type">Error</div>
            <span class="pill status-error">${escapeHtml(block.status)}</span>
          </div>
          <div class="code"><pre>${escapeHtml(block.message)}</pre></div>
        </article>
      `;
    case "file":
      return `
        <article class="block">
          <div class="block-head">
            <div class="block-type">File</div>
            <span class="pill">${escapeHtml(block.status)}</span>
          </div>
          <div class="grid">
            ${block.name ? `<div class="label"><strong>Name</strong> ${escapeHtml(block.name)}</div>` : ""}
            <div class="label"><strong>MIME</strong> ${escapeHtml(block.mimeType)}</div>
          </div>
        </article>
      `;
    case "question":
      return renderQuestionBlock(block);
    case "action":
      return renderActionBlock(block);
  }
}

function renderTextLikeBlock(label: string, text: string): string {
  return `
    <article class="block">
      <div class="block-head">
        <div class="block-type">${escapeHtml(label)}</div>
      </div>
      <div class="code"><pre>${escapeHtml(text)}</pre></div>
    </article>
  `;
}

function renderQuestionBlock(block: QuestionBlock): string {
  const answer = block.answer?.length ? block.answer.join(", ") : "Awaiting answer";
  const options = block.options?.length
    ? `<div class="label"><strong>Options</strong> ${escapeHtml(block.options.map((option) => option.label).join(", "))}</div>`
    : "";
  return `
    <article class="block">
      <div class="block-head">
        <div class="block-type">Question</div>
        <span class="pill">${escapeHtml(block.questionStatus)}</span>
      </div>
      ${block.header ? `<div class="label"><strong>${escapeHtml(block.header)}</strong></div>` : ""}
      <div class="code"><pre>${escapeHtml(block.question)}</pre></div>
      <div class="stack" style="margin-top: 10px;">
        ${options}
        <div class="label"><strong>Answer</strong> ${escapeHtml(answer)}</div>
      </div>
    </article>
  `;
}

function renderActionBlock(block: ActionBlock): string {
  const action = block.action;
  const parts: string[] = [];

  switch (action.kind) {
    case "file_change":
      parts.push(`<div class="label"><strong>Path</strong> ${escapeHtml(action.path)}</div>`);
      if (action.diff) {
        parts.push(renderDetailsSection("Diff", renderDiff(action.diff)));
      }
      break;
    case "command":
      parts.push(`<div class="label"><strong>Command</strong></div><div class="code"><pre>${escapeHtml(action.command)}</pre></div>`);
      if (typeof action.exitCode === "number") {
        parts.push(`<div class="label"><strong>Exit Code</strong> ${escapeHtml(String(action.exitCode))}</div>`);
      }
      break;
    case "tool_call":
      parts.push(`<div class="label"><strong>Tool</strong> ${escapeHtml(action.toolName)}</div>`);
      if (action.toolCallId) {
        parts.push(`<div class="label"><strong>Call ID</strong> ${escapeHtml(action.toolCallId)}</div>`);
      }
      break;
    case "subagent":
      parts.push(`<div class="label"><strong>Agent</strong> ${escapeHtml(action.agentName || action.agentId)}</div>`);
      if (action.prompt) {
        parts.push(`<div class="code"><pre>${escapeHtml(action.prompt)}</pre></div>`);
      }
      break;
  }

  if (action.approval) {
    parts.push(
      `<div class="label"><strong>Approval</strong> ${escapeHtml(action.approval.risk || "medium")} risk${action.approval.description ? ` - ${escapeHtml(action.approval.description)}` : ""}</div>`,
    );
  }
  if (action.output) {
    parts.push(renderDetailsSection("Output", `<div class="code"><pre>${escapeHtml(action.output)}</pre></div>`));
  }

  return `
    <article class="block">
      <div class="block-head">
        <div class="block-type">${escapeHtml(action.kind.replace("_", " "))}</div>
        <span class="pill">${escapeHtml(action.status)}</span>
      </div>
      <div class="stack">${parts.join("")}</div>
    </article>
  `;
}

function renderDetailsSection(title: string, innerHtml: string, open = false): string {
  return `
    <details class="details"${open ? " open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="panel-inner">${innerHtml}</div>
    </details>
  `;
}

function renderDiff(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const className = line.startsWith("+")
      ? "diff-line-add"
      : line.startsWith("-")
        ? "diff-line-del"
        : "";
    return `<div class="${className}"><pre>${escapeHtml(line || " ")}</pre></div>`;
  }).join("");
  return `<div class="code">${lines}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown time";
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
  } catch {
    return new Date(value).toISOString();
  }
}
