/**
 * Scout browser-use protocol contracts: adapters, surface modes, leases,
 * origin allow-lists, and structured receipts.
 *
 * One interface for Scout's own browser stack (Chrome Companion extension +
 * managed Chrome profiles over CDP) and pluggable external engines
 * (browser-use, browserbase).
 */

export const BROWSER_ADAPTER_IDS = [
  "scout-companion",
  "scout-native",
  "browser-use",
  "browserbase",
] as const;

export type BrowserAdapterId = (typeof BROWSER_ADAPTER_IDS)[number];

/** Default preference order: Scout's own companion & managed Chrome first, then external engines. */
export const DEFAULT_BROWSER_ADAPTER_ORDER: readonly BrowserAdapterId[] = [
  "scout-companion",
  "scout-native",
  "browser-use",
  "browserbase",
];

export type BrowserSurfaceMode = "companion" | "managed" | "regular" | "remote";

export type BrowserActionKind =
  | "open"
  | "snapshot"
  | "click"
  | "fill"
  | "resize"
  | "screenshot"
  | "tabs"
  | "close"
  | "profiles"
  | "import_cookies"
  | "companion_status"
  | "goal";

export type BrowserViewport = {
  width: number;
  height: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
};

export type BrowserProfileInfo = {
  name: string;
  source: "scout" | "action";
  active?: boolean;
};

export type BrowserAdapterHealth = {
  id: BrowserAdapterId;
  available: boolean;
  mode: BrowserSurfaceMode;
  reason?: string;
  bridgeUrl?: string;
  profiles?: BrowserProfileInfo[];
};

export type BrowserOriginPolicy = {
  /** Exact origins (scheme + host + optional port) permitted for this run. Empty/omitted means unrestricted local dev. */
  allowOrigins?: readonly string[];
  /** Origins where observation/capture must stop before any secret-revealing action. */
  secretCutoffOrigins?: readonly string[];
};

export type BrowserLease = {
  leaseId: string;
  driverId: string;
  adapter: BrowserAdapterId;
  mode: BrowserSurfaceMode;
  profile?: string;
  acquiredAt: number;
  expiresAt: number;
};

export type BrowserActionRequest = {
  action: BrowserActionKind;
  driverId: string;
  leaseId?: string;
  adapter?: BrowserAdapterId;
  mode?: BrowserSurfaceMode;
  profile?: string;
  url?: string;
  selector?: string;
  text?: string;
  goal?: string;
  viewport?: BrowserViewport;
  newTab?: boolean;
  background?: boolean;
  scope?: "tab" | "browser";
  policy?: BrowserOriginPolicy;
};

export type BrowserReceipt = {
  ok: boolean;
  action: BrowserActionKind;
  adapter: BrowserAdapterId;
  mode: BrowserSurfaceMode;
  leaseId?: string;
  url?: string;
  title?: string;
  viewport?: BrowserViewport;
  controlAvailable: boolean;
  artifactPath?: string;
  snapshot?: unknown;
  data?: unknown;
  error?: string;
  at: number;
};

/** Normalize a URL or origin string to its canonical origin (scheme + host + port), or null if invalid. */
export function normalizeOrigin(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url` is allowed by `policy.allowOrigins` (exact origin match; unrestricted if allowOrigins is empty). */
export function isOriginAllowed(url: string, policy?: BrowserOriginPolicy): boolean {
  const allow = policy?.allowOrigins;
  if (!allow || allow.length === 0) return true;
  const targetOrigin = normalizeOrigin(url);
  if (!targetOrigin) return false;
  return allow.some((entry) => normalizeOrigin(entry) === targetOrigin);
}

/** True when `url` matches a secret-cutoff origin where automated capture must stop. */
export function isSecretCutoffOrigin(url: string, policy?: BrowserOriginPolicy): boolean {
  const cutoffs = policy?.secretCutoffOrigins;
  if (!cutoffs || cutoffs.length === 0) return false;
  const targetOrigin = normalizeOrigin(url);
  if (!targetOrigin) return false;
  return cutoffs.some((entry) => normalizeOrigin(entry) === targetOrigin);
}

/** Pick the best available browser adapter from health readings, honoring an explicit preference first. */
export function pickBrowserAdapter(
  health: readonly BrowserAdapterHealth[],
  prefer?: BrowserAdapterId | null,
  order: readonly BrowserAdapterId[] = DEFAULT_BROWSER_ADAPTER_ORDER,
): BrowserAdapterHealth | null {
  const byId = new Map(health.map((item) => [item.id, item]));
  if (prefer) {
    const chosen = byId.get(prefer);
    if (chosen?.available) return chosen;
  }
  for (const id of order) {
    const candidate = byId.get(id);
    if (candidate?.available) return candidate;
  }
  return null;
}
