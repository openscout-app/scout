// Account discovery is not consent. A new Noise identity waits for a local
// owner decision in the same generational store as LAN pairing. The complete
// key binds the row; display fingerprints confer no authority. Reading approved
// is insufficient: this waiter must win conditional approved fulfillment.

import { localConfigHome } from "@openscout/runtime/config";

import {
  createPendingPairRequestStore,
  PairRequestCapacityError,
  pairRequestStatePath,
  type PendingPairRequestStore,
} from "../../../pairing-pair-requests.ts";

export type AccountAdmissionDecision = "admitted" | "denied" | "expired";

/** Asks the host's owner about one device; resolves once they decide, or the device leaves. */
export type AdmitAccountDevice = (publicKeyHex: string, signal: AbortSignal) => Promise<AccountAdmissionDecision>;

/** The route the prompt shows, so the owner can tell this from a tap on the network. */
export const ACCOUNT_ADMISSION_ROUTE = "account";
export const ACCOUNT_ADMISSION_LABEL = "A device through your account";

const POLL_MS = 1_000;
/** Past this the device is turned away; it can ask again. */
const MAX_WAIT_MS = 10 * 60_000;

export interface AccountAdmissionOptions {
  store?: PendingPairRequestStore;
  pollMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}

export function createAccountAdmission(options: AccountAdmissionOptions = {}): AdmitAccountDevice {
  // One callback belongs to the controller process, not a single runtime.
  // Runtime restarts reuse it; the lazy store has only an unref'd sweep timer.
  let store = options.store ?? null;
  const pollMs = options.pollMs ?? POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const now = options.now ?? Date.now;

  return async (publicKeyHex, signal) => {
    if (signal.aborted) return "expired";
    store ??= createPendingPairRequestStore({ statePath: pairRequestStatePath(localConfigHome()) });
    let token: string;
    try {
      const request = store.create({
        // One prompt per device key: a tab that reloads while waiting asks again
        // under the same row, and a declined key stays declined until it expires.
        // The short fingerprint is display metadata, never row ownership.
        requesterIp: `key ${publicKeyHex.slice(0, 12)}`,
        requesterPublicKey: publicKeyHex,
        requesterLabel: ACCOUNT_ADMISSION_LABEL,
        route: ACCOUNT_ADMISSION_ROUTE,
      });
      if (request.status === "denied") return "denied";
      token = request.token;
    } catch (error) {
      if (error instanceof PairRequestCapacityError) return "denied";
      throw error;
    }

    const deadline = now() + maxWaitMs;
    while (!signal.aborted && now() < deadline) {
      const request = store.get(token);
      if (!request) return "expired";
      if (request.status === "denied") return "denied";
      if (request.status === "approved") {
        // Another poll or denial can win after the approved read.
        return store.fulfill(token, "approved") ? "admitted" : "expired";
      }
      // Still waiting: keep the prompt up while the device is.
      store.touch(token);
      await sleep(pollMs, signal);
    }
    return "expired";
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
