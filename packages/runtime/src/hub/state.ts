/**
 * Scout Hub state on this host, under <OPENSCOUT_HOME>/hub:
 *   config.json    inbox URL and the read and write tokens (0600)
 *   identity.json  this runtime's X25519 key pair (0600)
 *   claude/projects/<label>/…  mirrored cloud transcripts, read by the Claude source
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenScoutHome } from "../support-paths.js";
import { generateHubKeyPair, publicKeyFromPrivate, type HubKeyPair } from "./seal.js";

export type HubConfig = {
  v: 1;
  /** Base URL of the inbox, without a trailing slash. */
  inbox: string;
  /** Lets the runtime list, fetch and delete chunks. Stays on this host. */
  readToken: string;
  /** Lets a reporter add chunks and nothing else. Goes into repos. */
  writeToken: string;
  createdAt: string;
};

export function resolveHubHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSCOUT_HUB_HOME?.trim() || join(resolveOpenScoutHome(), "hub");
}

export function resolveHubClaudeMirrorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSCOUT_HUB_CLAUDE_MIRROR_ROOT?.trim() || join(resolveHubHome(env), "claude", "projects");
}

function writePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function ensureHubHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function normalizeInboxUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new Error("The inbox URL must be https (http is allowed only for localhost).");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function newHubToken(prefix: "shr" | "shw"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function loadHubConfig(home = resolveHubHome()): HubConfig | null {
  const path = join(home, "config.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HubConfig>;
  if (typeof parsed.inbox !== "string" || typeof parsed.readToken !== "string" || typeof parsed.writeToken !== "string") {
    throw new Error(`${path} is missing inbox, readToken or writeToken`);
  }
  return { v: 1, inbox: parsed.inbox, readToken: parsed.readToken, writeToken: parsed.writeToken, createdAt: parsed.createdAt ?? "" };
}

export function saveHubConfig(config: HubConfig, home = resolveHubHome()): void {
  ensureHubHome(home);
  writePrivateJson(join(home, "config.json"), config);
}

/** This runtime's key pair, created on first use. */
export function loadOrCreateHubIdentity(home = resolveHubHome()): HubKeyPair {
  const existing = loadHubIdentity(home);
  if (existing) return existing;
  ensureHubHome(home);
  const keys = generateHubKeyPair();
  writePrivateJson(join(home, "identity.json"), {
    v: 1,
    publicKey: Buffer.from(keys.publicKey).toString("base64url"),
    privateKey: Buffer.from(keys.privateKey).toString("base64url"),
    createdAt: new Date().toISOString(),
  });
  return keys;
}

export function loadHubIdentity(home = resolveHubHome()): HubKeyPair | null {
  const path = join(home, "identity.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { privateKey?: string };
  const privateKey = Uint8Array.from(Buffer.from(String(parsed.privateKey ?? ""), "base64url"));
  if (privateKey.length !== 32) throw new Error(`${path} does not hold a 32-byte private key`);
  return { privateKey, publicKey: publicKeyFromPrivate(privateKey) };
}
