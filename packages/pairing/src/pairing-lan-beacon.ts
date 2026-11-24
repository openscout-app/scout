// Always-on LAN discovery beacon.
//
// Whenever the web server is up and an identity exists, it advertises
// `_oscout-pair._tcp` with the Mac's public key and web port so iOS can show
// the Mac in "On your network" and call `/pair` for the approval-gated flow.
// The pairing runtime controller may also advertise while it owns a local
// managed relay; in that one case this beacon stands down to avoid duplicate
// service instances. Remote relay / OSN pair mode still needs this beacon
// because the controller has no LAN relay service to advertise.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvedPairingConfig } from "./core/pairing/runtime/config.ts";
import { assertIsolatedPairingRunStateWrite } from "./pairing-run-state.ts";
import { localConfigHome } from "@openscout/runtime/config";
import { tryLoadIdentityPublicKeyHex } from "./core/pairing/runtime/security/identity.ts";

const RECONCILE_INTERVAL_MS = 5_000;
/**
 * A claim older than this belongs to a process that stopped refreshing it.
 *
 * Four reconciles of slack: liveness alone is not enough, because pids are
 * recycled. A dead owner's pid can be reassigned to something unrelated, which
 * would look alive forever and wedge every other instance into standing down.
 * An unrelated process will not refresh the claim, so staleness is what
 * actually breaks the tie; liveness just makes the common case (a clean crash)
 * recover in one pass instead of four.
 */
export const BEACON_CLAIM_STALE_MS = RECONCILE_INTERVAL_MS * 4;

export interface BeaconClaim {
  pid: number;
  webPort: number;
  updatedAt: number;
}

export interface BeaconClaimFile {
  /** Is some OTHER live, currently-refreshing local process advertising? */
  heldByAnotherInstance(): boolean;
  /** Claim or refresh ownership for this process. */
  take(webPort: number): void;
  /** Drop our claim. No-op when the claim on disk is not ours. */
  release(): void;
  /** The claim on disk, or null. For diagnostics and tests. */
  read(): BeaconClaim | null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ownership of this Mac's `_oscout-pair._tcp` advert, as a file.
 *
 * The identity in `~/.openscout` is per-Mac, so every local instance advertises
 * the SAME fingerprint. mDNS does not reject the duplicate — it renames it
 * ("OpenScout <fp> (2)") — so the Mac shows up twice and a phone can resolve
 * into whichever process it happens to pick. Bonjour cannot tell us which
 * advert is ours (the names are identical by construction), so ownership is
 * claimed here instead: the first live process to write the claim advertises,
 * everyone else stands down, and a claim whose owner died is taken over.
 *
 * Two instances starting inside the same reconcile window can both find no
 * claim and both advertise; the loser sees the winner's claim on its next pass
 * and stands down, so the duplicate window is bounded by one reconcile. That is
 * deliberately preferred to a lock, which can leak and leave the Mac silent.
 *
 * Everything is injectable so the claim protocol is testable without mDNS.
 */
export function createBeaconClaimFile(
  options: {
    path?: string;
    pid?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): BeaconClaimFile {
  const path = options.path ?? join(localConfigHome(), "run", "lan-beacon.json");
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => Date.now());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  function read(): BeaconClaim | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const c = parsed as Partial<BeaconClaim>;
      if (typeof c?.pid !== "number" || typeof c?.updatedAt !== "number") return null;
      return {
        pid: c.pid,
        webPort: typeof c.webPort === "number" ? c.webPort : 0,
        updatedAt: c.updatedAt,
      };
    } catch {
      return null;
    }
  }

  return {
    read,

    heldByAnotherInstance() {
      const claim = read();
      if (!claim) return false;
      if (claim.pid === pid) return false;
      if (!isProcessAlive(claim.pid)) return false;
      return now() - claim.updatedAt < BEACON_CLAIM_STALE_MS;
    },

    take(webPort) {
      // Outside the try, so a test reaching for the real `~/.openscout` fails
      // loudly instead of being swallowed by the unwritable-home fallback.
      assertIsolatedPairingRunStateWrite(path);
      try {
        // 0700 to match the rest of the run directory; the claim names a pid
        // and a port and has no business being world-readable.
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(
          path,
          JSON.stringify({ pid, webPort, updatedAt: now() } satisfies BeaconClaim),
          { mode: 0o600 },
        );
      } catch {
        // Unwritable home — fall back to the old behaviour (advertise anyway).
      }
    },

    release() {
      if (read()?.pid !== pid) return;
      try {
        rmSync(path, { force: true });
      } catch {
        // A stale claim just ages out.
      }
    },
  };
}

export interface ScoutPairLanBeacon {
  stop(): void;
}

/**
 * Start the discovery beacon. Returns null when it can't run (non-darwin, no
 * `dns-sd`, or no identity yet) — callers treat that as a no-op.
 *
 * @param shouldSuppressBeacon  Cheap predicate the beacon polls to decide
 *   whether another local LAN advert already represents this Mac.
 */
export function startScoutPairLanBeacon(
  shouldSuppressBeacon: () => boolean | Promise<boolean>,
  options: { webPort?: number } = {},
): ScoutPairLanBeacon | null {
  if (process.platform !== "darwin") return null;
  if (process.env.OPENSCOUT_LAN_BEACON_ENABLED === "0") return null;

  const publicKeyHex = tryLoadIdentityPublicKeyHex();
  if (!publicKeyHex) return null;

  const fingerprint = publicKeyHex.slice(0, 16);
  const relayPort = resolvedPairingConfig().port + 1;
  // Always advertise the real web port (the Mac's `/pair` endpoint) so the phone
  // never assumes a default. Prefer the bound port the caller passed; fall back to
  // the core bridge port rather than a departed web-app port.
  const webPort = normalizeWebPort(options.webPort) ?? resolvedPairingConfig().port;

  let advert: ChildProcess | null = null;
  let stopped = false;
  let reconciling = false;
  const claim = createBeaconClaimFile();

  function startAdvert(): void {
    if (advert || stopped) return;
    // Mirror the controller's advert (`pairing-runtime-controller.ts`) so the
    // two are interchangeable for discovery: same service type, port, and TXT
    // keys. `v=1` version, `pk` full key (dedup id + trust match), `fp`
    // fingerprint (display), `scheme` ws (no relay is live yet).
    advert = spawn(
      "/usr/bin/dns-sd",
      [
        "-R",
        `OpenScout ${fingerprint}`,
        "_oscout-pair._tcp",
        "local",
        String(relayPort),
        "v=1",
        `pk=${publicKeyHex}`,
        `fp=${fingerprint}`,
        "scheme=ws",
        "mode=discovery",
        `webPort=${webPort}`,
      ],
      { stdio: "ignore" },
    );
    advert.once("exit", () => {
      advert = null;
    });
  }

  function stopAdvert(): void {
    if (!advert) return;
    try {
      advert.kill("SIGTERM");
    } catch {
      // already gone
    }
    advert = null;
  }

  async function reconcile(): Promise<void> {
    if (stopped || reconciling) return;
    reconciling = true;
    try {
      // Another LIVE local instance already speaks for this Mac — stand down
      // rather than register a duplicate the phone can resolve into. No release
      // here: the claim on disk is not ours to drop.
      if (claim.heldByAnotherInstance()) {
        stopAdvert();
        return;
      }
      if (await shouldSuppressBeacon()) {
        stopAdvert();
        claim.release();
      } else {
        // Refresh on every pass, so if we die the claim ages out and another
        // instance takes over within a few reconciles.
        claim.take(webPort);
        startAdvert();
      }
    } catch {
      // If we can't tell, prefer being discoverable.
      startAdvert();
    } finally {
      reconciling = false;
    }
  }

  const timer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  void reconcile();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      stopAdvert();
      claim.release();
    },
  };
}

function normalizeWebPort(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : null;
}
