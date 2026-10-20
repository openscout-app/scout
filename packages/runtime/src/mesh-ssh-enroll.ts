import { spawn } from "node:child_process";

import {
  verifySignedNodeCard,
  type SignedNodeCard,
} from "./node-identity.js";
import type { MeshPeerTier } from "./mesh-peer-auth.js";
import type { TrustedPeerGrant } from "./mesh-trust-enrollment.js";

/**
 * SSH bootstrap enrollment (docs/proposals/mesh-trust-cone.md §3c).
 *
 * Mutual exchange over an already-authenticated SSH channel — no SAS.
 * Injectable exec so tests capture argv and never spawn a real ssh.
 */

export const SSH_ENROLL_DEFAULT_TIMEOUT_MS = 30_000;
export const SSH_ENROLL_DEFAULT_TIER: MeshPeerTier = "control";

export type SshEnrollTarget = {
  /** Destination token for ssh argv: `host` or `user@host` */
  destination: string;
  /** Optional port → `-p <port>` */
  port?: number;
  /** Original input string */
  raw: string;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SshExecInput = {
  /** Full argv including the program name as argv[0] (e.g. "ssh") */
  argv: string[];
  stdin?: string;
  timeoutMs: number;
};

/** Injectable child runner — argv array only, never a shell string. */
export type SshExec = (input: SshExecInput) => Promise<SshExecResult>;

export type SshEnrollResult = {
  /** Grant this node should persist for the remote peer */
  localGrant: TrustedPeerGrant;
  remoteCard: SignedNodeCard;
  /** Remote receipt for the grant of our local key. */
  remoteGrant: { keyId: string; tier: MeshPeerTier };
  /** Destination used for the ssh argv */
  target: SshEnrollTarget;
};

export class SshEnrollError extends Error {
  constructor(
    readonly reason:
      | "invalid-target"
      | "invalid-tier"
      | "invalid-card"
      | "self-enrollment"
      | "ssh-failed"
      | "ssh-timeout"
      | "remote-scout-missing"
      | "remote-rejected"
      | "remote-upgrade-required"
      | "remote-tier-unconfirmed"
      | "local-card-missing",
    message: string,
    readonly detail?: { argv?: string[]; stderr?: string; stdout?: string; exitCode?: number },
  ) {
    super(message);
    this.name = "SshEnrollError";
  }
}

/**
 * Parse `ssh://[user@]host[:port]` into ssh argv pieces.
 * Does not accept shell metacharacters in host/user — only URL form.
 */
export function parseSshEnrollTarget(raw: string): SshEnrollTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SshEnrollError("invalid-target", "ssh enroll target is empty");
  }
  let url: URL;
  try {
    // Require the ssh scheme so we never confuse an HTTP peer URL with SSH.
    if (!/^ssh:\/\//i.test(trimmed)) {
      throw new Error("missing ssh:// scheme");
    }
    url = new URL(trimmed);
  } catch {
    throw new SshEnrollError(
      "invalid-target",
      `invalid ssh enroll target: ${raw} — expected ssh://[user@]host[:port]`,
    );
  }
  if (url.protocol !== "ssh:") {
    throw new SshEnrollError(
      "invalid-target",
      `invalid ssh enroll target: ${raw} — expected ssh:// scheme`,
    );
  }
  const host = url.hostname?.trim();
  if (!host) {
    throw new SshEnrollError(
      "invalid-target",
      `invalid ssh enroll target: ${raw} — host is required`,
    );
  }
  // Reject credentials/path/query that we do not model.
  if (url.password) {
    throw new SshEnrollError(
      "invalid-target",
      "ssh enroll target must not embed a password; use the local ssh agent",
    );
  }
  if (url.pathname && url.pathname !== "/" && url.pathname !== "") {
    throw new SshEnrollError(
      "invalid-target",
      `invalid ssh enroll target: ${raw} — path is not supported`,
    );
  }
  if (url.search || url.hash) {
    throw new SshEnrollError(
      "invalid-target",
      `invalid ssh enroll target: ${raw} — query/hash is not supported`,
    );
  }

  const user = url.username ? decodeURIComponent(url.username) : "";
  const destination = user ? `${user}@${host}` : host;
  // URL.port is "" when absent; when present it is decimal digits.
  let port: number | undefined;
  if (url.port) {
    port = Number.parseInt(url.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new SshEnrollError(
        "invalid-target",
        `invalid ssh port in target: ${raw}`,
      );
    }
  }
  return { destination, ...(port !== undefined ? { port } : {}), raw: trimmed };
}

/**
 * Build the full argv for an ssh remote command. Never shell-interpolates.
 * Host-key checking is left to the user's ssh config (that IS the auth).
 */
export function buildSshArgv(target: SshEnrollTarget, remoteCommand: readonly string[]): string[] {
  if (remoteCommand.length === 0) {
    throw new SshEnrollError("invalid-target", "remote command must not be empty");
  }
  const argv = ["ssh"];
  if (target.port !== undefined) {
    argv.push("-p", String(target.port));
  }
  // Do not inject StrictHostKeyChecking or other trust overrides — host-key
  // verification is the authentication root for this enrollment path.
  argv.push(target.destination);
  argv.push(...remoteCommand);
  return argv;
}

/** Grant shape from a verified card — shared by local install and remote install-grant. */
export function grantFromVerifiedCard(
  card: SignedNodeCard,
  options: {
    tier: MeshPeerTier;
    grantedAt?: number;
  },
): TrustedPeerGrant {
  return {
    keyId: card.keyId,
    publicKey: card.publicKey,
    fingerprint: card.fingerprint,
    nodeId: card.nodeId,
    label: card.label,
    tier: options.tier,
    grantedVia: "ssh",
    grantedAt: options.grantedAt ?? Date.now(),
    ...(card.tls ? { tlsSpkiFingerprint: card.tls.spkiFingerprint } : {}),
  };
}

/**
 * Default exec: spawn argv[0] with the remaining args. Never uses a shell.
 * Exit code is returned on the result (does not throw on non-zero).
 */
export async function defaultSshExec(input: SshExecInput): Promise<SshExecResult> {
  const [file, ...args] = input.argv;
  if (!file) {
    throw new SshEnrollError("ssh-failed", "ssh argv is empty");
  }
  return await new Promise<SshExecResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const child = spawn(file, args, {
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      // Explicit: never shell.
      shell: false,
      // Its own process group, so a timeout also reaches what it started
      // (a login shell, a ProxyCommand).
      detached: process.platform !== "win32",
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal("SIGTERM");
      // `child.killed` only says a signal was sent. The group is killed even
      // when the leader exited, since a descendant may have ignored TERM.
      setTimeout(() => {
        if (!exited || process.platform !== "win32") signal("SIGKILL");
      }, 500).unref?.();
      reject(
        new SshEnrollError(
          "ssh-timeout",
          `ssh timed out after ${input.timeoutMs}ms`,
          { argv: [...input.argv] },
        ),
      );
    }, input.timeoutMs);
    timer.unref?.();

    if (input.stdin !== undefined) {
      child.stdin?.end(input.stdin);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new SshEnrollError(
          "ssh-failed",
          `failed to spawn ssh: ${error.message}`,
          { argv: [...input.argv] },
        ),
      );
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: exitCode ?? 1,
      });
    });
  });
}

function looksLikeMissingScout(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("command not found")
    || text.includes("not found")
    || text.includes("no such file")
    || text.includes("not recognized")
  ) && (text.includes("scout") || text.includes("mesh"));
}

function parseCardJson(text: string, side: "remote" | "local"): SignedNodeCard {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new SshEnrollError(
      "invalid-card",
      `${side} card response was empty`,
    );
  }
  // Tolerate leading/trailing noise: take the first JSON object.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new SshEnrollError(
      "invalid-card",
      `${side} card response was not JSON`,
      { stdout: trimmed.slice(0, 500) },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new SshEnrollError(
      "invalid-card",
      `${side} card response was not valid JSON`,
      { stdout: trimmed.slice(0, 500) },
    );
  }
  // `scout mesh card --json` may wrap as `{ card: ... }` or print the card.
  const card = (
    parsed
    && typeof parsed === "object"
    && parsed !== null
    && "card" in parsed
    && (parsed as { card: unknown }).card
    && typeof (parsed as { card: unknown }).card === "object"
  )
    ? (parsed as { card: SignedNodeCard }).card
    : parsed as SignedNodeCard;
  if (!card || typeof card !== "object" || typeof (card as SignedNodeCard).publicKey !== "string") {
    throw new SshEnrollError("invalid-card", `${side} card JSON is missing publicKey`);
  }
  return card as SignedNodeCard;
}

async function runSshCommand(
  exec: SshExec,
  target: SshEnrollTarget,
  remoteCommand: readonly string[],
  options: { stdin?: string; timeoutMs: number; step: string },
): Promise<SshExecResult> {
  const argv = buildSshArgv(target, remoteCommand);
  let result: SshExecResult;
  try {
    result = await exec({
      argv,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof SshEnrollError) throw error;
    throw new SshEnrollError(
      "ssh-failed",
      `${options.step} failed: ${error instanceof Error ? error.message : String(error)}`,
      { argv },
    );
  }
  if (result.exitCode !== 0) {
    if (looksLikeMissingScout(result.stderr, result.stdout)) {
      throw new SshEnrollError(
        "remote-scout-missing",
        `remote scout is not on PATH for ${target.destination} (during ${options.step}). Remote stderr:\n${result.stderr.trim() || result.stdout.trim() || "(empty)"}`,
        { argv, stderr: result.stderr, stdout: result.stdout, exitCode: result.exitCode },
      );
    }
    throw new SshEnrollError(
      result.exitCode === 255 ? "ssh-failed" : "remote-rejected",
      `${options.step} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      { argv, stderr: result.stderr, stdout: result.stdout, exitCode: result.exitCode },
    );
  }
  return result;
}

/**
 * Mutual SSH enrollment exchange.
 *
 * Ordering (no half-enrollment on the local side):
 *   1. fetch + verify remote card
 *   2. verify remote install-grant advertises an explicit --tier
 *   3. push local card to remote (`install-grant`); abort if remote rejects
 *   4. verify the remote receipt, then return the local grant for the remote peer — caller persists it
 *
 * The local grant is intentionally NOT written inside this function so the CLI
 * / broker path can own persistence; the contract is "only call install after
 * this resolves".
 */
export async function enrollViaSsh(input: {
  target: string;
  localCard: SignedNodeCard;
  tier?: MeshPeerTier;
  timeoutMs?: number;
  exec?: SshExec;
  now?: number;
}): Promise<SshEnrollResult> {
  const target = parseSshEnrollTarget(input.target);
  const tier = input.tier ?? SSH_ENROLL_DEFAULT_TIER;
  if (tier !== "observe" && tier !== "control") {
    throw new SshEnrollError("invalid-tier", "SSH enrollment tier must be observe or control; no SSH command was sent.");
  }
  const timeoutMs = input.timeoutMs ?? SSH_ENROLL_DEFAULT_TIMEOUT_MS;
  const exec = input.exec ?? defaultSshExec;
  const now = input.now ?? Date.now();

  if (!verifySignedNodeCard(input.localCard, now)) {
    throw new SshEnrollError(
      "local-card-missing",
      "local signed node card failed verification; is the broker publishing a card?",
    );
  }

  // 1. Fetch remote card
  const fetchResult = await runSshCommand(
    exec,
    target,
    ["scout", "mesh", "card", "--json"],
    { timeoutMs, step: "fetch remote card" },
  );
  const remoteCard = parseCardJson(fetchResult.stdout, "remote");
  if (!verifySignedNodeCard(remoteCard, now)) {
    throw new SshEnrollError(
      "invalid-card",
      "remote node card failed verification; aborting — no grants written",
    );
  }
  if (remoteCard.keyId === input.localCard.keyId) {
    throw new SshEnrollError("self-enrollment", "cannot enroll with self over ssh");
  }

  // Verify capability before any mutation: generic mesh/enroll --tier help
  // is insufficient. Old or unknown remotes must not fall back to control.
  let help: SshExecResult;
  try {
    help = await runSshCommand(exec, target, ["scout", "mesh", "trust", "install-grant", "--help"],
      { timeoutMs, step: "check remote install-grant tier support" });
  } catch (error) {
    if (error instanceof SshEnrollError && ["remote-rejected", "remote-scout-missing"].includes(error.reason)) {
      throw new SshEnrollError("remote-upgrade-required", "Upgrade Scout on the remote: cannot confirm install-grant --tier support; no enrollment grant was sent.", error.detail);
    }
    throw error;
  }
  if (!/\binstall-grant\b[^\r\n]*--tier\b/.test(help.stdout)) {
    throw new SshEnrollError("remote-upgrade-required", "Upgrade Scout on the remote: install-grant must advertise --tier; no enrollment grant was sent.");
  }

  // Push our card with the same explicit tier as the grant installed locally.
  let pushResult: SshExecResult;
  try {
    pushResult = await runSshCommand(exec, target,
      ["scout", "mesh", "trust", "install-grant", "-", "--tier", tier, "--json"],
      { timeoutMs, step: "push local card to remote install-grant", stdin: `${JSON.stringify(input.localCard)}\n` });
  } catch (error) {
    if (error instanceof SshEnrollError && error.reason === "remote-rejected"
      && /(?:unknown|unrecognized|unsupported|unexpected).*(?:--tier|flag|option)/i.test(`${error.detail?.stderr} ${error.detail?.stdout}`)) {
      throw new SshEnrollError("remote-upgrade-required", "Upgrade Scout on the remote: install-grant rejected an explicit tier; no local grant was installed. Inspect the remote's peer grants before retrying.", error.detail);
    }
    throw error;
  }
  // Exit zero alone is not an acknowledgement of least privilege. Refuse an
  // ignored flag, wrong key, malformed receipt, or missing tier; never persist
  // a local grant after an unconfirmed remote mutation.
  let receipt: { peer?: { keyId?: unknown; tier?: unknown } } | null = null;
  try { receipt = JSON.parse(pushResult.stdout); } catch { /* fail closed below */ }
  if (receipt?.peer?.keyId !== input.localCard.keyId || receipt.peer.tier !== tier) {
    throw new SshEnrollError("remote-tier-unconfirmed", "Remote grant tier/key was not confirmed. No local grant was installed. Inspect or revoke the remote grant, upgrade remote Scout, and retry with an explicit tier.");
  }
  const remoteGrant = { keyId: input.localCard.keyId, tier };
  const localGrant = grantFromVerifiedCard(remoteCard, { tier, grantedAt: now });
  return { localGrant, remoteCard, remoteGrant, target };
}
