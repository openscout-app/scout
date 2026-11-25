/**
 * Scout native managed-Chrome adapter: discovers persistent Chrome identities
 * under Scout's (and existing Action's) ChromeProfiles roots and checks the
 * local CDP endpoint.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BrowserActionRequest,
  BrowserAdapterHealth,
  BrowserLease,
  BrowserProfileInfo,
  BrowserReceipt,
} from "@openscout/protocol";
import type { BrowserAdapter } from "./adapter.js";

const DEFAULT_CDP_PORT = 9334;

export type ScoutNativeBrowserOptions = {
  supportDir?: string;
  cdpPort?: number;
  fetchImpl?: typeof fetch;
};

async function listProfileDir(root: string, source: "scout" | "action"): Promise<BrowserProfileInfo[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, source }));
  } catch {
    return [];
  }
}

export function createScoutNativeBrowserAdapter(options: ScoutNativeBrowserOptions = {}): BrowserAdapter {
  const supportDir = options.supportDir ?? join(homedir(), "Library/Application Support");
  const cdpPort = options.cdpPort ?? Number(process.env.SCOUT_BROWSER_DEBUG_PORT ?? process.env.ACTION_BROWSER_DEBUG_PORT ?? DEFAULT_CDP_PORT);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function discoverProfiles(): Promise<BrowserProfileInfo[]> {
    const [scoutProfiles, actionProfiles] = await Promise.all([
      listProfileDir(join(supportDir, "Scout/ChromeProfiles"), "scout"),
      listProfileDir(join(supportDir, "Action/ChromeProfiles"), "action"),
    ]);
    const seen = new Set(scoutProfiles.map((p) => p.name));
    return [...scoutProfiles, ...actionProfiles.filter((p) => !seen.has(p.name))];
  }

  return {
    id: "scout-native",

    async health(): Promise<BrowserAdapterHealth> {
      const profiles = await discoverProfiles();
      try {
        const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json/version`, {
          signal: AbortSignal.timeout(1_200),
        });
        if (response.ok) {
          return {
            id: "scout-native",
            available: true,
            mode: "managed",
            bridgeUrl: `http://127.0.0.1:${cdpPort}`,
            profiles,
          };
        }
      } catch {
        // CDP is not currently open; managed profiles can still be listed.
      }
      return {
        id: "scout-native",
        available: profiles.length > 0,
        mode: "managed",
        bridgeUrl: `http://127.0.0.1:${cdpPort}`,
        profiles,
        reason: profiles.length > 0
          ? "Managed Chrome profiles found (CDP idle until launched)."
          : "No managed Chrome profiles configured yet.",
      };
    },

    async execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt> {
      const at = Date.now();
      if (request.action === "profiles") {
        const profiles = await discoverProfiles();
        return {
          ok: true,
          action: "profiles",
          adapter: "scout-native",
          mode: "managed",
          leaseId: lease?.leaseId,
          controlAvailable: true,
          data: { profiles },
          at,
        };
      }
      if (request.mode === "regular") {
        return {
          ok: true,
          action: request.action,
          adapter: "scout-native",
          mode: "regular",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          data: { note: "Regular Chrome is open-only; use Scout Computer native observe/act or a seeded profile for DOM control." },
          at,
        };
      }
      const status = await this.health();
      return {
        ok: false,
        action: request.action,
        adapter: "scout-native",
        mode: "managed",
        leaseId: lease?.leaseId,
        url: request.url,
        controlAvailable: status.available,
        error: `Scout native CDP action '${request.action}' is not yet wired to port ${cdpPort}; use scout-companion or browser-use.`,
        at,
      };
    },
  };
}
