import type { VercelBoardConnectionConfig, VercelBoardDispatchDecision, VercelBoardMirroredMessage } from "@openscout/protocol";
import type { VercelBoardMirror } from "./mirror.js";
import { vercelBoardOriginOf } from "./mirror.js";
import {
  vercelBoardDecide, vercelBoardDispatchRegistry, vercelBoardDispatchSettings, vercelBoardChannelSteps,
  type VercelBoardDispatchAgent, type VercelBoardDispatchCandidate, type VercelBoardDispatchRegistry,
} from "./policy.js";
import type { VercelBoardStore } from "./store.js";
import type { VercelBoardWireMessage } from "./wire.js";

/** How many changed decisions status keeps. */
const RECENT = 50;

export interface VercelBoardDispatcherDeps {
  /** The live connection's config. The dispatcher reads it on every pass, so a settings change applies at once. */
  config(): VercelBoardConnectionConfig;
  store: VercelBoardStore;
  mirror: VercelBoardMirror;
  /** The channels with a local copy. Demand comes from the copy only. */
  channels(): string[];
  /** Read the task from the board again before a claim. */
  read(taskId: string): Promise<VercelBoardWireMessage | null>;
  /** Whether the connection can claim now: it holds the host lock and is not in an error state. */
  canRun(): boolean;
  /** Claim the task for the agent as the profile, and start the agent. Throws when the claim or the dispatch fails. */
  claim(root: VercelBoardWireMessage, input: { agentId: string; profile: string; policy: string }): Promise<void>;
  registry?: VercelBoardDispatchRegistry;
  now?: () => number;
}

type TaskView = Pick<VercelBoardMirroredMessage, "id" | "channel" | "labels" | "by" | "origin" | "deleted" | "re"> & {
  task?: { state: string; owner: string; needs: string[]; for: string | null; epoch: number };
};

/**
 * The dispatcher: a first-class part of each connection. It wakes on feed
 * events that leave a task ready (created ready, readied by a dependency,
 * released, expired, unblocked) and on the custody sweep, which also frees
 * the agents whose claims ended. Each pass runs every ready task in a
 * mirrored channel through the channel's policy and claims what the policy
 * claims. One pass runs at a time; a wake during a pass runs one more after it.
 */
export class VercelBoardDispatcher {
  private readonly registry: VercelBoardDispatchRegistry;
  private readonly now: () => number;
  private running?: Promise<void>;
  private again = false;
  private readonly last = new Map<string, string>();
  private readonly recentDecisions: VercelBoardDispatchDecision[] = [];
  lastPassAt?: number;

  constructor(private readonly deps: VercelBoardDispatcherDeps) {
    this.registry = deps.registry ?? vercelBoardDispatchRegistry;
    this.now = deps.now ?? Date.now;
  }

  /** Run a pass now, or one more after the running pass. Resolves when no pass is pending. */
  pass(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.passOnce(); } while (this.again);
      } finally { this.running = undefined; }
    })();
    return this.running;
  }

  /** Resolves when the running pass, if any, is done. */
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }

  recent(): VercelBoardDispatchDecision[] { return [...this.recentDecisions]; }

  /** Free agents: those that declared a role, then those only the capability map names. Busy agents are left out. */
  agents(busy: Set<string>): VercelBoardDispatchAgent[] {
    const config = this.deps.config();
    const byId = new Map<string, VercelBoardDispatchAgent>();
    this.deps.store.declaredRoles(config.id).forEach((entry, rank) => {
      const agent = byId.get(entry.agentId) ?? { agentId: entry.agentId, roles: [], capabilities: [], roleRank: {} };
      agent.roles.push(entry.role);
      agent.roleRank![entry.role] = rank;
      byId.set(entry.agentId, agent);
    });
    for (const [selector, agentIds] of Object.entries(config.dispatch?.capabilities ?? {})) {
      for (const agentId of agentIds) {
        const agent = byId.get(agentId) ?? { agentId, roles: [], capabilities: [] };
        agent.capabilities.push(selector);
        byId.set(agentId, agent);
      }
    }
    return [...byId.values()].filter(agent => !busy.has(agent.agentId));
  }

  private candidate(view: TaskView, agents: VercelBoardDispatchAgent[]): VercelBoardDispatchCandidate {
    const config = this.deps.config();
    const latest = this.deps.store.latestCustody(config.id, view.id);
    const active = this.deps.store.activeCustody(config.id).some(row => row.taskId === view.id);
    return {
      connection: config, channel: view.channel,
      task: { id: view.id, labels: view.labels, by: view.by ? { principal: view.by.principal, profile: view.by.profile } : null, origin: view.origin,
        owner: view.task!.owner, for: view.task!.for, needs: view.task!.needs, epoch: view.task!.epoch },
      agents,
      history: { attempts: latest ? 1 : 0, lastEpoch: latest?.epoch ?? null, lastGotClaim: latest ? latest.epoch !== null : false, active },
    };
  }

  private wireView(message: VercelBoardWireMessage): TaskView {
    return { ...message, by: message.by ?? null, origin: vercelBoardOriginOf(message, this.deps.config()) };
  }

  /** Decide one task, from the board's own copy, without claiming. */
  async explain(taskId: string, message: VercelBoardWireMessage | null): Promise<VercelBoardDispatchDecision> {
    const config = this.deps.config();
    const at = this.now();
    if (!message?.task || message.re !== null) return { taskId, channel: message?.channel ?? "", policy: "", outcome: "skip", reason: "not a task root", trail: [], at };
    const view = this.wireView(message);
    const settings = vercelBoardDispatchSettings(config, view.channel, view.labels, this.registry);
    if ("error" in settings) return { taskId, channel: view.channel, policy: settings.policy, outcome: "skip", reason: settings.error, trail: [], at };
    if (config.dispatch?.enabled === false) return { taskId, channel: view.channel, policy: settings.policy, outcome: "skip", reason: "the dispatcher is paused for this connection", trail: [], at };
    if (!config.channels.includes(view.channel)) return { taskId, channel: view.channel, policy: settings.policy, outcome: "skip", reason: "the channel is not followed", trail: [], at };
    if (!this.deps.channels().includes(view.channel)) return { taskId, channel: view.channel, policy: settings.policy, outcome: "skip", reason: "the channel is not mirrored; the dispatcher reads demand from the copy only", trail: [], at };
    if (message.deleted || message.task.state !== "ready") return { taskId, channel: view.channel, policy: settings.policy, outcome: "skip", reason: `the task is ${message.deleted ? "deleted" : message.task.state}, not ready`, trail: [], at };
    const busy = new Set(this.deps.store.activeCustody(config.id).map(row => row.agentId));
    return vercelBoardDecide(this.candidate(view, this.agents(busy)), settings, this.registry, at);
  }

  private record(decision: VercelBoardDispatchDecision, force = false): void {
    const key = `${decision.outcome}|${decision.step ?? ""}|${decision.reason ?? ""}|${decision.agentId ?? ""}|${decision.claimed ?? ""}`;
    if (!force && this.last.get(decision.taskId) === key) return;
    if (this.last.size >= 5_000) this.last.clear();
    this.last.set(decision.taskId, key);
    this.recentDecisions.push(decision);
    if (this.recentDecisions.length > RECENT) this.recentDecisions.splice(0, this.recentDecisions.length - RECENT);
  }

  private async passOnce(): Promise<void> {
    const config = this.deps.config();
    if (config.dispatch?.enabled === false || !this.deps.canRun()) return;
    this.lastPassAt = this.now();
    const active = this.deps.store.activeCustody(config.id);
    const busy = new Set(active.map(row => row.agentId));
    // Every claim needs a free agent. With none, nothing reads the channels.
    if (!this.agents(busy).length) return;
    const held = new Set(active.map(row => row.taskId));
    for (const channel of this.deps.channels()) {
      const steps = vercelBoardChannelSteps(config, channel, this.registry);
      // A chain that skips everything whatever the task (manual) needs no reads.
      if (steps?.length && this.registry.step(steps[0]!)?.skipsAll) continue;
      for (const id of this.deps.mirror.openTasks(config.id, channel)) {
        if (held.has(id)) continue;
        const copy = this.deps.mirror.message(config.id, id);
        if (!copy?.task || copy.re !== null || copy.deleted || copy.task.state !== "ready") continue;
        const agents = this.agents(busy);
        if (!agents.length) return;
        const settings = vercelBoardDispatchSettings(config, channel, copy.labels, this.registry);
        if ("error" in settings) { this.record({ taskId: id, channel, policy: settings.policy, outcome: "skip", reason: settings.error, trail: [], at: this.now() }); continue; }
        const decision = await vercelBoardDecide(this.candidate(copy, agents), settings, this.registry, this.now());
        if (decision.outcome !== "claim") { this.record(decision); continue; }
        // The copy said claim. Ask the board's own copy the same question before claiming.
        const root = await this.deps.read(id).catch(() => null);
        if (!root?.task || root.re !== null || root.deleted || root.task.state !== "ready" || root.channel !== channel) {
          this.record({ ...decision, outcome: "skip", reason: "the board no longer shows it ready here", agentId: undefined, profile: undefined });
          continue;
        }
        const fresh = this.wireView(root);
        const freshSettings = vercelBoardDispatchSettings(config, channel, fresh.labels, this.registry);
        const confirmed = "error" in freshSettings ? undefined : await vercelBoardDecide(this.candidate(fresh, agents), freshSettings, this.registry, this.now());
        if (!confirmed || confirmed.outcome !== "claim" || confirmed.agentId !== decision.agentId) {
          this.record(confirmed ?? { ...decision, outcome: "skip", reason: "the board's copy no longer passes the policy" });
          continue;
        }
        busy.add(confirmed.agentId!);
        try {
          await this.deps.claim(root, { agentId: confirmed.agentId!, profile: confirmed.profile!, policy: confirmed.policy });
          this.record({ ...confirmed, claimed: true }, true);
        } catch (error) {
          // A refusal or a failed dispatch leaves a custody row; the policy's history guard decides what happens next.
          this.record({ ...confirmed, claimed: false, error: error instanceof Error ? error.message.slice(0, 300) : "claim failed" }, true);
        }
      }
    }
  }
}
