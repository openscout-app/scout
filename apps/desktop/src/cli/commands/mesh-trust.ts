import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

import type { TrustedPeerTier } from "@openscout/protocol";
import {
  SshEnrollError,
  verifySignedNodeCard,
  type SignedNodeCard,
} from "@openscout/runtime";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../core/broker/service.ts";
import {
  clearPendingMeshEnrollment,
  loadPendingMeshEnrollment,
  savePendingMeshEnrollment,
} from "../../core/mesh/enroll-pending.ts";
import {
  approveMeshEnrollment,
  beginMeshEnrollment,
  confirmMeshEnrollment,
  enrollMeshViaSsh,
  grantMeshTrustedPeer,
  installMeshGrantFromCard,
  listMeshEnrollmentSessions,
  listMeshTrustedPeers,
  normalizeSasWords,
  readMeshNodeTrust,
  revokeMeshTrustedPeer,
} from "../../core/mesh/trust-service.ts";
import {
  renderMeshEnrollmentSessions,
  renderMeshEnrollmentWords,
  renderMeshPeerGrant,
  renderMeshPeerRevoked,
  renderMeshPeers,
} from "../../ui/terminal/mesh-trust.ts";

/**
 * `scout mesh` trust-cone subcommands (docs/proposals/mesh-trust-cone.md §7 + §3c):
 * peers / grant / revoke / enroll / card / trust install-grant.
 * Operator routes are loopback-only; SAS enroll talks to the peer over HTTP;
 * SSH enroll shells out to `ssh` with an argv array.
 */

export const MESH_TRUST_HELP = `scout mesh — trust cone (docs/proposals/mesh-trust-cone.md)

Subcommands:
  scout mesh peers [--json]                     List trusted peers
  scout mesh grant <key-id> <tier> [--label <name>]
                                                Adjust a peer's tier (observe|control)
  scout mesh revoke <key-id|fingerprint>        Revoke a trusted peer
  scout mesh card [--json]                      Print this node's signed node card
  scout mesh trust install-grant - [--tier <tier>]
                                                Verify a card on stdin and install a grant (SSH path)
  scout mesh enroll <peer-url> [--tier <tier>] [--yes]
                                                Start a SAS enrollment with a peer
  scout mesh enroll ssh://[user@]host[:port] [--tier <tier>]
                                                Mutual SSH bootstrap enrollment (§3c)
  scout mesh enroll                             Show in-flight enrollments on this node
  scout mesh enroll --approve <id> [--tier <tier>]
                                                Approve an in-flight enrollment
  scout mesh enroll --confirm-sas "<6 words>"   Confirm a pending enrollment's words
  scout mesh status [--json]                    Node identity, gate mode, peer count
`;

const HELP_FLAGS = new Set(["--help", "-h"]);

const KEY_ID_PATTERN = /^[0-9a-f]{64}$/;
const FINGERPRINT_PATTERN = /^osc1:[0-9a-z]{4}-[0-9a-z]{4}$/;

/* ── Argument parsing (exported for tests) ── */

/** Full 64-char lowercase SHA-256 hex key ID; throws on anything else. */
export function normalizeMeshKeyIdInput(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!KEY_ID_PATTERN.test(trimmed)) {
    throw new ScoutCliError(
      `invalid key ID: ${value} — expected the full 64-char hex key ID (see \`scout mesh peers\`)`,
    );
  }
  return trimmed;
}

export function parseMeshPeerTier(value: string): TrustedPeerTier {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "observe" || trimmed === "control") {
    return trimmed;
  }
  throw new ScoutCliError(`invalid tier: ${value} — expected observe or control`);
}

function isFlag(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}

function flagValue(args: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }
  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), nextIndex: index };
  }
  throw new ScoutCliError(`missing value for ${flag}`);
}

export type MeshGrantOptions = {
  keyId: string;
  tier: TrustedPeerTier;
  label?: string;
};

/**
 * `scout mesh grant --key-id <hex> --tier <observe|control> [--label <name>]`
 * or the proposal §7 positional form `scout mesh grant <key-id> <tier>`.
 */
export function parseMeshGrantArgs(args: string[]): MeshGrantOptions {
  let keyId: string | undefined;
  let tier: TrustedPeerTier | undefined;
  let label: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (isFlag(current, "--key-id")) {
      const parsed = flagValue(args, index, "--key-id");
      keyId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (isFlag(current, "--tier")) {
      const parsed = flagValue(args, index, "--tier");
      tier = parseMeshPeerTier(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (isFlag(current, "--label")) {
      const parsed = flagValue(args, index, "--label");
      label = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (current.startsWith("--")) {
      throw new ScoutCliError(`unknown flag for mesh grant: ${current}`);
    }
    positional.push(current);
  }

  keyId = keyId ?? positional[0];
  tier = tier ?? (positional[1] ? parseMeshPeerTier(positional[1]) : undefined);
  if (!keyId || !tier) {
    throw new ScoutCliError(
      "usage: scout mesh grant --key-id <hex> --tier <observe|control> [--label <name>]",
    );
  }
  if (positional.length > 2) {
    throw new ScoutCliError(`unexpected arguments for mesh grant: ${positional.slice(2).join(" ")}`);
  }
  return { keyId: normalizeMeshKeyIdInput(keyId), tier, ...(label ? { label } : {}) };
}

export type MeshRevokeOptions = {
  keyId?: string;
  fingerprint?: string;
};

/** `scout mesh revoke <key-id|osc1:fingerprint>` — fingerprint resolved via the peer list. */
export function parseMeshRevokeArgs(args: string[]): MeshRevokeOptions {
  const positional: string[] = [];
  for (const current of args) {
    if (current.startsWith("--")) {
      throw new ScoutCliError(`unknown flag for mesh revoke: ${current}`);
    }
    positional.push(current);
  }
  if (positional.length !== 1) {
    throw new ScoutCliError("usage: scout mesh revoke <key-id|fingerprint>");
  }
  const target = positional[0]!.trim();
  if (FINGERPRINT_PATTERN.test(target.toLowerCase())) {
    return { fingerprint: target.toLowerCase() };
  }
  return { keyId: normalizeMeshKeyIdInput(target) };
}

export type MeshEnrollOptions =
  | { kind: "list" }
  | { kind: "approve"; enrollmentId: string; tier: TrustedPeerTier }
  | { kind: "begin"; peerUrl: string; tier: TrustedPeerTier; yes: boolean }
  | { kind: "ssh"; target: string; tier: TrustedPeerTier }
  | { kind: "confirm"; words: string };

export function parseMeshEnrollArgs(args: string[]): MeshEnrollOptions {
  // SSH bootstrap defaults to control (operator already holds SSH); SAS stays observe.
  let tier: TrustedPeerTier | undefined;
  let yes = false;
  let approveId: string | undefined;
  let confirmWords: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (isFlag(current, "--tier")) {
      const parsed = flagValue(args, index, "--tier");
      tier = parseMeshPeerTier(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (isFlag(current, "--approve")) {
      const parsed = flagValue(args, index, "--approve");
      approveId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (isFlag(current, "--confirm-sas")) {
      const parsed = flagValue(args, index, "--confirm-sas");
      confirmWords = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (current === "--yes" || current === "-y") {
      yes = true;
      continue;
    }
    if (current.startsWith("--")) {
      throw new ScoutCliError(`unknown flag for mesh enroll: ${current}`);
    }
    positional.push(current);
  }

  const modes = [approveId !== undefined, confirmWords !== undefined, positional.length > 0]
    .filter(Boolean).length;
  if (modes > 1) {
    throw new ScoutCliError("provide a peer URL, --approve, or --confirm-sas — not a mix");
  }
  if (approveId !== undefined) {
    if (!approveId.trim()) {
      throw new ScoutCliError("missing value for --approve");
    }
    return { kind: "approve", enrollmentId: approveId.trim(), tier: tier ?? "observe" };
  }
  if (confirmWords !== undefined) {
    const words = normalizeSasWords(confirmWords);
    if (words.length !== 6) {
      throw new ScoutCliError("--confirm-sas expects the 6 SAS words shown on the peer's screen");
    }
    return { kind: "confirm", words: words.join(" ") };
  }
  if (positional.length === 0) {
    return { kind: "list" };
  }
  if (positional.length > 1) {
    throw new ScoutCliError(`unexpected arguments for mesh enroll: ${positional.slice(1).join(" ")}`);
  }
  const target = positional[0]!;
  if (/^ssh:\/\//i.test(target)) {
    return { kind: "ssh", target, tier: tier ?? "control" };
  }
  return { kind: "begin", peerUrl: target, tier: tier ?? "observe", yes };
}

/* ── Handlers ── */

export async function runMeshPeersCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  if (args.length > 0) {
    throw new ScoutCliError(`unexpected arguments for mesh peers: ${args.join(" ")}`);
  }
  const peers = await listMeshTrustedPeers(resolveScoutBrokerUrl());
  context.output.writeValue(peers, renderMeshPeers);
}

export async function runMeshGrantCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  const options = parseMeshGrantArgs(args);
  const peer = await grantMeshTrustedPeer(resolveScoutBrokerUrl(), options);
  context.output.writeValue(peer, (current) => renderMeshPeerGrant(current, "Granted"));
}

export async function runMeshRevokeCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  const options = parseMeshRevokeArgs(args);
  const brokerUrl = resolveScoutBrokerUrl();

  let keyId = options.keyId;
  if (!keyId && options.fingerprint) {
    // Fingerprints are display-only; resolve to the canonical key ID via the
    // local peer list before revoking.
    const peers = await listMeshTrustedPeers(brokerUrl);
    const matches = peers.filter((peer) => peer.fingerprint.toLowerCase() === options.fingerprint);
    if (matches.length !== 1) {
      throw new ScoutCliError(
        matches.length === 0
          ? `no trusted peer with fingerprint ${options.fingerprint}`
          : `fingerprint ${options.fingerprint} is ambiguous; use the full key ID`,
      );
    }
    keyId = matches[0]!.keyId;
  }

  await revokeMeshTrustedPeer(brokerUrl, keyId!);
  context.output.writeValue({ keyId, state: "revoked" }, () => renderMeshPeerRevoked(keyId!));
}

async function promptSasApproval(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export async function runMeshEnrollCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  const options = parseMeshEnrollArgs(args);
  const brokerUrl = resolveScoutBrokerUrl();

  switch (options.kind) {
    case "list": {
      // Responder side: a peer began a handshake with this node. Show the
      // sessions (SAS words included) so the operator can approve one.
      const sessions = await listMeshEnrollmentSessions(brokerUrl);
      context.output.writeValue(sessions, renderMeshEnrollmentSessions);
      return;
    }

    case "approve": {
      const grant = await approveMeshEnrollment(brokerUrl, options.enrollmentId, options.tier);
      context.output.writeValue(grant, (current) =>
        [
          `Enrolled ${current.label} — ${current.tier}`,
          `  Key ID: ${current.keyId}`,
          `  Fingerprint: ${current.fingerprint}`,
        ].join("\n"));
      return;
    }

    case "confirm": {
      const pending = loadPendingMeshEnrollment();
      if (!pending) {
        throw new ScoutCliError(
          "no pending enrollment; run `scout mesh enroll <peer-url>` first",
        );
      }
      try {
        const peer = await confirmMeshEnrollment(brokerUrl, pending, options.words);
        clearPendingMeshEnrollment();
        context.output.writeValue(peer, (current) => renderMeshPeerGrant(current, "Enrolled"));
      } catch (error) {
        clearPendingMeshEnrollment();
        throw error;
      }
      return;
    }

    case "ssh": {
      try {
        const { peer, result } = await enrollMeshViaSsh({
          brokerUrl,
          target: options.target,
          tier: options.tier,
        });
        context.output.writeValue(
          { peer, remote: result.remoteCard, target: result.target, localTier: peer.tier, remoteTier: result.remoteGrant.tier },
          () =>
            [
              `SSH enrolled ${peer.label} — ${peer.tier} (via ssh)`,
              `  Peer key ID: ${peer.keyId}`,
              `  Fingerprint: ${peer.fingerprint}`,
              peer.tlsSpkiFingerprint
                ? `  TLS pin: ${peer.tlsSpkiFingerprint.slice(0, 16)}…`
                : "  TLS pin: (none on card)",
              `  Destination: ${result.target.destination}${result.target.port ? `:${result.target.port}` : ""}`,
              `  Local grant for remote key: ${peer.tier}`,
              `  Remote grant for our key: ${result.remoteGrant.tier}`,
              "  Mutual: remote confirmed the requested tier; local grant installed.",
            ].join("\n"),
        );
      } catch (error) {
        if (error instanceof SshEnrollError) {
          throw new ScoutCliError(error.message);
        }
        throw error;
      }
      return;
    }

    case "begin": {
      const handshake = await beginMeshEnrollment({
        brokerUrl,
        peerUrl: options.peerUrl,
        tier: options.tier,
      });
      context.output.writeValue(handshake, renderMeshEnrollmentWords);

      let approved = options.yes;
      if (!approved && context.isTty) {
        approved = await promptSasApproval("Do the words match the peer's screen? [y/N] ");
      }
      if (approved) {
        const peer = await confirmMeshEnrollment(brokerUrl, handshake);
        context.output.writeValue(peer, (current) => renderMeshPeerGrant(current, "Enrolled"));
        return;
      }

      if (context.isTty) {
        context.output.writeText(
          "Not approved. Nothing was granted; start over with `scout mesh enroll <peer-url>` when ready.",
        );
        return;
      }

      // Non-interactive: park the handshake so the operator can compare words
      // out-of-band, then confirm with the words shown on the peer's screen.
      savePendingMeshEnrollment(handshake);
      context.output.writeText(
        [
          "Not approved yet (non-interactive shell). After comparing the words, run:",
          "  scout mesh enroll --confirm-sas \"<the 6 words shown on the peer's screen>\"",
        ].join("\n"),
      );
      return;
    }
  }
}

/** `scout mesh card [--json]` — read-only local signed node card. */
export async function runMeshCardCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  const jsonOnly = args.includes("--json");
  const unexpected = args.filter((arg) => arg !== "--json");
  if (unexpected.length > 0) {
    throw new ScoutCliError(`unexpected arguments for mesh card: ${unexpected.join(" ")}`);
  }
  const trust = await readMeshNodeTrust(resolveScoutBrokerUrl());
  if (!trust.card) {
    throw new ScoutCliError(
      "the local broker does not publish a signed node card; restart it on a build with mesh trust support",
    );
  }
  // Machine-readable form is the card object itself (SSH fetch parses this).
  if (jsonOnly || !context.isTty) {
    context.output.writeText(`${JSON.stringify(trust.card)}\n`);
    return;
  }
  context.output.writeValue(trust.card, (card) =>
    [
      `Node card: ${card.label}`,
      `  Key ID: ${card.keyId}`,
      `  Fingerprint: ${card.fingerprint}`,
      `  Node ID: ${card.nodeId}`,
      card.tls
        ? `  TLS SPKI: ${card.tls.spkiFingerprint}`
        : "  TLS SPKI: (none)",
      `  Expires: ${new Date(card.expiresAt).toISOString()}`,
    ].join("\n"));
}

export type MeshTrustInstallGrantOptions = {
  source: "-" | string;
  tier: TrustedPeerTier;
};

export function parseMeshTrustInstallGrantArgs(args: string[]): MeshTrustInstallGrantOptions {
  let tier: TrustedPeerTier = "control";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (isFlag(current, "--tier")) {
      const parsed = flagValue(args, index, "--tier");
      tier = parseMeshPeerTier(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (current.startsWith("--")) {
      throw new ScoutCliError(`unknown flag for trust install-grant: ${current}`);
    }
    positional.push(current);
  }
  if (positional.length !== 1) {
    throw new ScoutCliError("usage: scout mesh trust install-grant - [--tier observe|control]");
  }
  return { source: positional[0]!, tier };
}

function readCardSource(source: string): string {
  if (source === "-") {
    return readFileSync(0, "utf8");
  }
  // File path is supported for tests/operators; SSH path uses stdin ("-").
  return readFileSync(source, "utf8");
}

function parseCardPayload(text: string): SignedNodeCard {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ScoutCliError("install-grant: empty input");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ScoutCliError("install-grant: input is not valid JSON");
  }
  if (
    parsed
    && typeof parsed === "object"
    && parsed !== null
    && "card" in parsed
    && (parsed as { card: unknown }).card
    && typeof (parsed as { card: unknown }).card === "object"
  ) {
    return (parsed as { card: SignedNodeCard }).card;
  }
  return parsed as SignedNodeCard;
}

/**
 * `scout mesh trust install-grant -` — machine-local: verify a peer card from
 * stdin (or a file path) and persist a grant with granted_via=ssh.
 */
export async function runMeshTrustInstallGrantCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  const options = parseMeshTrustInstallGrantArgs(args);
  const raw = readCardSource(options.source);
  const card = parseCardPayload(raw);
  if (!verifySignedNodeCard(card)) {
    throw new ScoutCliError("install-grant: card failed verification");
  }
  const peer = await installMeshGrantFromCard(resolveScoutBrokerUrl(), card, options.tier);
  // Keep stdout JSON-friendly for the SSH push side to parse if needed.
  context.output.writeValue({ peer }, (value) => JSON.stringify(value));
}

/** `scout mesh trust …` dispatcher (install-grant today). */
export async function runMeshTrustCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  if (!sub || HELP_FLAGS.has(sub)) {
    context.output.writeText(MESH_TRUST_HELP);
    return;
  }
  if (sub === "install-grant") {
    await runMeshTrustInstallGrantCommand(context, args.slice(1));
    return;
  }
  throw new ScoutCliError(`unknown mesh trust subcommand: ${sub}\n${MESH_TRUST_HELP}`);
}
