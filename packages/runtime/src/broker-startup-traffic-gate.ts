const RESTORING_READ_PATHS = new Set([
  "/health",
  "/v1/home",
  "/v1/node",
  "/v1/snapshot",
  "/v1/web/status",
]);

const RESTORING_PROCESS_CONTROL_ROUTES = new Set([
  "POST /v1/web/start",
]);

export type BrokerStartupTrafficGateSnapshot = {
  state: "restoring" | "ready" | "degraded";
  mutationsAdmitted: boolean;
  phase?: "starting" | "history" | "projection" | "sessions" | "ready" | "degraded" | "failed";
  coreReady?: boolean;
  historyReady?: boolean;
  error?: string | null;
  nextRetryAt?: number;
  milestones?: Record<string, number>;
};

/**
 * Keep health and read models available while startup recovery finishes, but
 * do not let a canonical mutation cross the projection warm boundary.
 */
export class BrokerStartupTrafficGate {
  private mutationsAdmitted = false;
  private phase: NonNullable<BrokerStartupTrafficGateSnapshot["phase"]> = "starting";
  private coreReady = false;
  private historyReady = false;
  private nextRetryAt?: number;
  private error: string | null = null;
  private milestones: Record<string, number> = {};

  constructor(private readonly progressive = false) {}

  markListening(): void { this.milestones.listeningAt = Date.now(); }
  admitCore(): void {
    this.coreReady = true;
    this.phase = "history";
    this.milestones.coreReadyAt = Date.now();
  }
  admitHistory(): void {
    this.historyReady = true;
    this.phase = "projection";
    this.milestones.historyReadyAt = Date.now();
  }
  restoringSessions(): void { this.phase = "sessions"; }
  degradeProjection(error: unknown, nextRetryAt?: number): void {
    this.mutationsAdmitted = false;
    this.phase = "degraded";
    this.nextRetryAt = nextRetryAt;
    this.error = error instanceof Error ? error.message : String(error);
  }
  fail(error: unknown): void {
    this.phase = "failed";
    this.nextRetryAt = undefined;
    this.error = error instanceof Error ? error.message : String(error);
  }


  admits(method: string | undefined, requestTarget = "/"): boolean {
    if (this.mutationsAdmitted) {
      return true;
    }
    const normalizedMethod = (method ?? "GET").toUpperCase();
    const path = requestTarget.split("?", 1)[0] || "/";
    if (normalizedMethod === "OPTIONS") {
      return true;
    }
    if (this.progressive) {
      if (this.coreReady && normalizedMethod === "POST"
        && ["/v1/actors", "/v1/agents", "/v1/endpoints"].includes(path)) return true;
      if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && path === "/v1/snapshot") {
        const scope = new URL(requestTarget, "http://broker.local").searchParams.get("scope");
        return scope === "agents" || scope === "identity" ? this.coreReady : this.historyReady;
      }
      // Home depends on the projection; an empty/partial prior launch is not
      // a complete history result. Health remains available with coverage.
      if (path === "/v1/home") return false;
    }
    // Starting the broker-owned web child changes process state, not the
    // canonical control plane. Let the supervisor overlap that startup with
    // projection recovery while canonical writes remain behind this gate.
    if (RESTORING_PROCESS_CONTROL_ROUTES.has(`${normalizedMethod} ${path}`)) {
      return true;
    }
    if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
      return false;
    }
    return RESTORING_READ_PATHS.has(path);
  }

  admitMutations(): void {
    this.mutationsAdmitted = true;
    this.error = null;
    this.nextRetryAt = undefined;
    this.phase = "ready";
    this.milestones.readyAt = Date.now();
  }

  snapshot(): BrokerStartupTrafficGateSnapshot {
    return {
      state: this.mutationsAdmitted ? "ready" : this.phase === "degraded" ? "degraded" : "restoring",
      mutationsAdmitted: this.mutationsAdmitted,
      ...(this.nextRetryAt === undefined ? {} : { nextRetryAt: this.nextRetryAt }),
      ...(this.progressive ? { phase: this.phase, coreReady: this.coreReady, historyReady: this.historyReady, error: this.error, milestones: { ...this.milestones } } : {}),
    };
  }
}
