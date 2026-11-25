/**
 * Scout Chrome Companion adapter: talks to the local Chrome Companion bridge
 * (compatible with the MV3 companion extension WebSocket/HTTP bridge).
 */
import type {
  BrowserActionRequest,
  BrowserAdapterHealth,
  BrowserLease,
  BrowserReceipt,
} from "@openscout/protocol";
import type { BrowserAdapter } from "./adapter.js";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4321";

export type CompanionAdapterOptions = {
  bridgeUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createScoutCompanionAdapter(options: CompanionAdapterOptions = {}): BrowserAdapter {
  const bridgeUrl = (options.bridgeUrl ?? process.env.SCOUT_BROWSER_COMPANION_URL ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: "scout-companion",

    async health(): Promise<BrowserAdapterHealth> {
      try {
        const response = await fetchImpl(`${bridgeUrl}/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (!response.ok) {
          return {
            id: "scout-companion",
            available: false,
            mode: "companion",
            bridgeUrl,
            reason: `Companion bridge returned HTTP ${response.status}.`,
          };
        }
        const payload = (await response.json().catch(() => ({}))) as { connected?: boolean; ok?: boolean };
        const connected = payload.connected ?? payload.ok ?? true;
        return {
          id: "scout-companion",
          available: Boolean(connected),
          mode: "companion",
          bridgeUrl,
          reason: connected ? undefined : "Bridge is running, waiting for Chrome Companion extension.",
        };
      } catch {
        return {
          id: "scout-companion",
          available: false,
          mode: "companion",
          bridgeUrl,
          reason: "Chrome Companion bridge is not running.",
        };
      }
    },

    async execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt> {
      const at = Date.now();
      if (request.action === "companion_status") {
        const status = await this.health();
        return {
          ok: status.available,
          action: request.action,
          adapter: "scout-companion",
          mode: "companion",
          leaseId: lease?.leaseId,
          controlAvailable: status.available,
          data: status,
          error: status.reason,
          at,
        };
      }

      try {
        const response = await fetchImpl(`${bridgeUrl}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: request.action,
            url: request.url,
            selector: request.selector,
            text: request.text,
            viewport: request.viewport,
            profile: request.profile,
            newTab: request.newTab,
            scope: request.scope,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || data.ok === false) {
          return {
            ok: false,
            action: request.action,
            adapter: "scout-companion",
            mode: "companion",
            leaseId: lease?.leaseId,
            url: request.url,
            controlAvailable: false,
            error: typeof data.error === "string" ? data.error : `Companion command failed (${response.status}).`,
            at,
          };
        }
        return {
          ok: true,
          action: request.action,
          adapter: "scout-companion",
          mode: "companion",
          leaseId: lease?.leaseId,
          url: typeof data.url === "string" ? data.url : request.url,
          title: typeof data.title === "string" ? data.title : undefined,
          controlAvailable: true,
          snapshot: data.snapshot,
          artifactPath: typeof data.artifactPath === "string" ? data.artifactPath : undefined,
          data,
          at,
        };
      } catch (error) {
        return {
          ok: false,
          action: request.action,
          adapter: "scout-companion",
          mode: "companion",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: error instanceof Error ? error.message : "Could not reach Chrome Companion bridge.",
          at,
        };
      }
    },
  };
}
