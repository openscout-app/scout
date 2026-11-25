/**
 * Browser adapter interface and single-lease router for Scout browser use.
 * Enforces one driver at a time, origin allow-lists, secret-cutoff protection,
 * and adapter selection (Scout companion -> Scout native -> browser-use -> browserbase).
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_BROWSER_ADAPTER_ORDER,
  isOriginAllowed,
  isSecretCutoffOrigin,
  pickBrowserAdapter,
  type BrowserActionRequest,
  type BrowserAdapterHealth,
  type BrowserAdapterId,
  type BrowserLease,
  type BrowserReceipt,
} from "@openscout/protocol";

export interface BrowserAdapter {
  readonly id: BrowserAdapterId;
  health(): Promise<BrowserAdapterHealth>;
  execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt>;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export class BrowserRouter {
  private readonly adapters: Map<BrowserAdapterId, BrowserAdapter>;
  private readonly order: readonly BrowserAdapterId[];
  private readonly now: () => number;
  private lease: BrowserLease | null = null;

  constructor(
    adapters: readonly BrowserAdapter[],
    options: { order?: readonly BrowserAdapterId[]; now?: () => number } = {},
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.order = options.order ?? DEFAULT_BROWSER_ADAPTER_ORDER;
    this.now = options.now ?? (() => Date.now());
  }

  /** Health reading for every registered adapter, in preference order. */
  async health(): Promise<BrowserAdapterHealth[]> {
    const ordered = this.order
      .map((id) => this.adapters.get(id))
      .filter((adapter): adapter is BrowserAdapter => Boolean(adapter));
    for (const adapter of this.adapters.values()) {
      if (!ordered.includes(adapter)) ordered.push(adapter);
    }
    return Promise.all(ordered.map((adapter) => adapter.health()));
  }

  /** Active lease if still valid, else null. */
  currentLease(): BrowserLease | null {
    if (this.lease && this.lease.expiresAt <= this.now()) {
      this.lease = null;
    }
    return this.lease;
  }

  /** Acquire the single-driver lease for an adapter, or fail if another driver holds it. */
  async acquireLease(options: {
    driverId: string;
    prefer?: BrowserAdapterId | null;
    profile?: string;
    ttlMs?: number;
  }): Promise<{ ok: true; lease: BrowserLease } | { ok: false; error: string }> {
    const active = this.currentLease();
    if (active && active.driverId !== options.driverId) {
      return {
        ok: false,
        error: `Browser lease is currently held by ${active.driverId} (${active.adapter}).`,
      };
    }
    const readings = await this.health();
    const picked = pickBrowserAdapter(readings, options.prefer ?? null, this.order);
    if (!picked) {
      return {
        ok: false,
        error: "No browser adapter is currently available. Start the Scout Chrome Companion or install browser-use.",
      };
    }
    const at = this.now();
    const lease: BrowserLease = {
      leaseId: active?.driverId === options.driverId ? active.leaseId : `blease_${randomUUID().slice(0, 12)}`,
      driverId: options.driverId,
      adapter: picked.id,
      mode: picked.mode,
      profile: options.profile ?? active?.profile,
      acquiredAt: active?.driverId === options.driverId ? active.acquiredAt : at,
      expiresAt: at + (options.ttlMs ?? DEFAULT_LEASE_TTL_MS),
    };
    this.lease = lease;
    return { ok: true, lease };
  }

  releaseLease(driverId: string, leaseId?: string): boolean {
    const active = this.currentLease();
    if (!active) return false;
    if (active.driverId !== driverId) return false;
    if (leaseId && active.leaseId !== leaseId) return false;
    this.lease = null;
    return true;
  }

  /** Execute a browser action through the selected adapter with origin, secret-cutoff, and lease checks. */
  async execute(request: BrowserActionRequest): Promise<BrowserReceipt> {
    const at = this.now();

    if (request.url) {
      if (!isOriginAllowed(request.url, request.policy)) {
        return {
          ok: false,
          action: request.action,
          adapter: request.adapter ?? this.order[0] ?? "scout-companion",
          mode: request.mode ?? "companion",
          url: request.url,
          controlAvailable: false,
          error: `Origin not permitted by policy: ${request.url}`,
          at,
        };
      }
      if (
        (request.action === "snapshot" || request.action === "screenshot") &&
        isSecretCutoffOrigin(request.url, request.policy)
      ) {
        return {
          ok: false,
          action: request.action,
          adapter: request.adapter ?? this.order[0] ?? "scout-companion",
          mode: request.mode ?? "companion",
          url: request.url,
          controlAvailable: false,
          error: `Observation blocked by secret cutoff for ${request.url}`,
          at,
        };
      }
    }

    const active = this.currentLease();
    if (active && active.driverId !== request.driverId) {
      return {
        ok: false,
        action: request.action,
        adapter: active.adapter,
        mode: active.mode,
        leaseId: active.leaseId,
        controlAvailable: false,
        error: `Browser lease is held by ${active.driverId}.`,
        at,
      };
    }

    let chosenId: BrowserAdapterId | null = request.adapter ?? active?.adapter ?? null;
    if (!chosenId) {
      const readings = await this.health();
      chosenId = pickBrowserAdapter(readings, null, this.order)?.id ?? null;
    }
    const adapter = chosenId ? this.adapters.get(chosenId) : undefined;
    if (!adapter) {
      return {
        ok: false,
        action: request.action,
        adapter: request.adapter ?? "scout-companion",
        mode: request.mode ?? "companion",
        controlAvailable: false,
        error: "No available browser adapter could handle this request.",
        at,
      };
    }

    return adapter.execute(request, active ?? undefined);
  }
}
