import {
  VERCEL_BOARD_BUILTIN_POLICY_STEPS, VERCEL_BOARD_DEFAULT_GUARDS, VERCEL_BOARD_DISPATCH_POLICIES, vercelBoardLabelMatches, vercelBoardRoleActor, vercelBoardRoles,
  validateVercelBoardDispatchConfig,
  type VercelBoardChannelDispatchStatus, type VercelBoardConnectionConfig, type VercelBoardDispatchConfig, type VercelBoardDispatchDecision, type VercelBoardDispatchTrust,
} from "@openscout/protocol";
import { vercelBoardPrincipalOf } from "./projection.js";

/**
 * Dispatch policy: one interface for every policy. A policy is an ordered
 * chain of named steps. Each step reads one candidate task and its free
 * agents, and passes it on, skips it with a reason, or claims it for one
 * agent. The built-in policies are chains of the built-in steps below,
 * registered by name like any other; nothing else decides a claim.
 *
 * Built-in steps are pure: the same candidate and settings give the same
 * answer, with no I/O. The runner awaits each step, so a step may also ask
 * something outside the process (see docs/vercel-board.md).
 */

/** A free Scout agent: declared roles and mapped capabilities, oldest declaration first. */
export interface VercelBoardDispatchAgent {
  agentId: string;
  roles: string[];
  capabilities: string[];
  /** Each role's place in the order agents declared it, oldest first: who gets a role's task first. */
  roleRank?: Record<string, number>;
}

/** One ready task, as a step sees it. Board text is not here: a step decides from metadata only. */
export interface VercelBoardDispatchCandidate {
  connection: Pick<VercelBoardConnectionConfig, "id" | "principal" | "profile" | "ownerAllowlist" | "roles">;
  channel: string;
  task: {
    id: string;
    labels: Record<string, string>;
    /** Who wrote the root. Null when the board did not say. */
    by: { principal: string; profile: string | null } | null;
    /** `scout`, `board`, or the sync key that imported it (`slack`, `github`, `linear`). */
    origin: string;
    owner: string;
    for: string | null;
    needs: string[];
    epoch: number;
  };
  /** Free agents, oldest declaration first. An agent that holds a Board task on this connection is not free. */
  agents: VercelBoardDispatchAgent[];
  /** Scout's own attempts on this task, from custody. */
  history: { attempts: number; lastEpoch: number | null; lastGotClaim: boolean; active: boolean };
}

/** A channel's settings, resolved for one candidate. */
export interface VercelBoardDispatchSettings {
  policy: string;
  steps: string[];
  /** The relaxations in force for this candidate: the channel's, plus each matching label's. */
  trust: VercelBoardDispatchTrust;
  labels: string[];
  capabilities: Record<string, string[]>;
}

/** What the chain carries from step to step. */
export interface VercelBoardDispatchState {
  agents: VercelBoardDispatchAgent[];
  /** The Board profile to claim as. Unset means the connection's own profile. */
  profile?: string;
  /** The Scout role the task is kept for; null when it is kept for nobody. */
  role?: string | null;
}

export type VercelBoardDispatchStepResult =
  | { result: "pass"; agents?: VercelBoardDispatchAgent[]; profile?: string; role?: string | null; note?: string }
  | { result: "skip"; reason: string }
  | { result: "claim"; agentId: string; profile?: string; note?: string };

export interface VercelBoardDispatchStep {
  /** guard, resolve, match and pick are conventions for readers; the runner treats every step alike. */
  kind: "guard" | "resolve" | "match" | "pick" | "terminal" | "external";
  summary: string;
  /** Set when the step skips every candidate whatever it is, so a pass need not read the channel's tasks. */
  skipsAll?: string;
  run(candidate: VercelBoardDispatchCandidate, state: VercelBoardDispatchState, settings: VercelBoardDispatchSettings): VercelBoardDispatchStepResult | Promise<VercelBoardDispatchStepResult>;
}

/**
 * The role a task is kept for, read from its `for`: null when it is kept for
 * nobody, the role when `for` is one of this connection's role actors, and
 * undefined when it is kept for an actor Scout does not write as.
 */
export function vercelBoardRoleOf(config: Pick<VercelBoardConnectionConfig, "principal" | "profile" | "roles">, forActor: string | null | undefined): string | null | undefined {
  if (!forActor) return null;
  return vercelBoardRoles(config).find(role => vercelBoardRoleActor(config, role) === forActor);
}

const skip = (reason: string): VercelBoardDispatchStepResult => ({ result: "skip", reason });
const pass = (extra: Omit<Extract<VercelBoardDispatchStepResult, { result: "pass" }>, "result"> = {}): VercelBoardDispatchStepResult => ({ result: "pass", ...extra });

/** Written by the operator, as themselves or as Scout's own profile, and owned by them. */
export function vercelBoardWrittenByOperator(config: Pick<VercelBoardConnectionConfig, "principal" | "profile">, by: { principal: string; profile: string | null } | null | undefined, owner: string): boolean {
  return vercelBoardPrincipalOf(owner) === config.principal && by?.principal === config.principal && (by.profile === null || by.profile === config.profile);
}

const roleAgents = (agents: VercelBoardDispatchAgent[], role: string) => agents.filter(agent => agent.roles.includes(role))
  .map((agent, index) => ({ agent, index, rank: agent.roleRank?.[role] ?? Number.MAX_SAFE_INTEGER }))
  .sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.agent);

export const VERCEL_BOARD_BUILTIN_STEPS: Record<string, VercelBoardDispatchStep> = {
  manual: {
    kind: "terminal", summary: "Skip every task: the operator starts each claim.",
    skipsAll: "manual: the operator starts every claim in this channel",
    run: () => skip("manual: the operator starts every claim in this channel"),
  },
  "guard:not-synced": {
    kind: "guard", summary: "Skip a task a sync provider imported (Slack, GitHub, Linear), unless trust.synced names its key.",
    run: ({ task }, _state, { trust }) => {
      if (task.origin === "scout" || task.origin === "board") return pass();
      if (trust.synced?.includes("*") || trust.synced?.includes(task.origin)) return pass({ note: `sync key ${task.origin} is trusted here` });
      return skip(`imported through sync key ${task.origin}; text from a synced platform never starts work unless the operator trusts that key`);
    },
  },
  "guard:operator-authored": {
    kind: "guard", summary: "Skip a task the operator did not make and write, as themselves or Scout. trust.authors widens it to the allowlist or anyone.",
    run: ({ connection, task }, _state, { trust }) => {
      const authors = trust.authors ?? "operator";
      if (authors === "any") return pass({ note: "any author is trusted here" });
      if (authors === "allowlist") {
        const owner = vercelBoardPrincipalOf(task.owner);
        const author = task.by?.principal ?? owner;
        const outsider = [owner, author].find(principal => !connection.ownerAllowlist.includes(principal));
        return outsider ? skip(`${outsider === owner ? "made" : "written"} by ${outsider}, who is not on the allowlist`) : pass({ note: "owner and author are on the allowlist" });
      }
      if (vercelBoardWrittenByOperator(connection, task.by, task.owner)) return pass();
      const who = task.by ? `${task.by.principal}${task.by.profile ? `+${task.by.profile}` : ""}` : vercelBoardPrincipalOf(task.owner);
      return skip(`written by ${who}, not by the operator or Scout`);
    },
  },
  "guard:first-claim": {
    kind: "guard", summary: "Skip a task the board has seen claimed (epoch above 0) or Scout has tried. trust.anyEpoch admits a task another worker let go.",
    run: ({ task, history }, _state, { trust }) => {
      if (history.active) return skip("Scout already holds or is settling it");
      if (!trust.anyEpoch) {
        if (task.epoch !== 0) return skip(`the board has seen it claimed (epoch ${task.epoch}); after any claim the operator decides`);
        if (history.attempts) return skip("Scout tried it before; the operator decides now");
        return pass();
      }
      if (history.attempts && !history.lastGotClaim) return skip("Scout's last attempt got no claim; the operator decides now");
      if (history.lastEpoch !== null && task.epoch <= history.lastEpoch) return skip(`Scout last held it at epoch ${history.lastEpoch}; only another worker's claim since lets Scout take it again`);
      return pass({ note: task.epoch ? `claimed before (epoch ${task.epoch}); trusted here` : undefined });
    },
  },
  "resolve:for": {
    kind: "resolve", summary: "Claim as the role the task is kept for, or as Scout's profile when it is kept for nobody. Skip a task kept for an actor Scout does not write as.",
    run: ({ connection, task }) => {
      const role = vercelBoardRoleOf(connection, task.for);
      if (role === undefined) return skip(`kept for ${task.for}, which Scout does not write as`);
      return pass({ role, profile: role ?? connection.profile });
    },
  },
  "match:role": {
    kind: "match", summary: "Keep only a task kept for a working role, and only the free agents that declared it.",
    run: ({ connection }, state) => {
      if (!state.role) return skip("kept for no role");
      if (state.role === connection.profile) return skip(`kept for ${state.role}, which plans and is never declared`);
      const agents = roleAgents(state.agents, state.role);
      return agents.length ? pass({ agents }) : skip(`no free agent declared ${state.role}`);
    },
  },
  "match:role-or-any": {
    kind: "match", summary: "A task kept for a role goes to that role's free agents; any other goes to any free agent.",
    run: ({ connection }, state) => {
      if (state.role === connection.profile) return skip(`kept for ${state.role}, which plans and is never declared`);
      if (!state.role) return state.agents.length ? pass() : skip("no free agent");
      const agents = roleAgents(state.agents, state.role);
      return agents.length ? pass({ agents }) : skip(`no free agent declared ${state.role}`);
    },
  },
  "match:label": {
    kind: "match", summary: "Keep only a task that carries one of the channel's labels.",
    run: ({ task }, _state, { labels }) => {
      if (!labels.length) return skip("the channel names no labels for label-matched dispatch");
      const hit = labels.find(selector => vercelBoardLabelMatches(task.labels, selector));
      return hit ? pass({ note: `carries ${hit}` }) : skip(`carries none of: ${labels.join(", ")}`);
    },
  },
  "match:capability": {
    kind: "match", summary: "Keep only the free agents mapped to a capability label the task carries.",
    run: ({ task }, state, { capabilities }) => {
      const selectors = Object.keys(capabilities).filter(selector => vercelBoardLabelMatches(task.labels, selector));
      if (!selectors.length) return skip("carries no label in the capability map");
      const mapped = new Set(selectors.flatMap(selector => capabilities[selector] ?? []));
      const agents = state.agents.filter(agent => mapped.has(agent.agentId));
      return agents.length ? pass({ agents, note: `capability ${selectors.join(", ")}` }) : skip(`no free agent for ${selectors.join(", ")}`);
    },
  },
  "pick:first": {
    kind: "pick", summary: "Claim for the first free agent left: the longest-declared.",
    run: (_candidate, state) => {
      const agent = state.agents[0];
      return agent ? { result: "claim", agentId: agent.agentId, ...(state.profile ? { profile: state.profile } : {}) } : skip("no free agent");
    },
  },
};

/** The step registry. Built-ins are registered the same way a new step is. */
export class VercelBoardDispatchRegistry {
  private readonly steps = new Map<string, VercelBoardDispatchStep>();
  private readonly policies = new Map<string, readonly string[]>();

  constructor(options: { builtins?: boolean } = {}) {
    if (options.builtins === false) return;
    for (const [name, step] of Object.entries(VERCEL_BOARD_BUILTIN_STEPS)) this.register(name, step);
    for (const name of VERCEL_BOARD_DISPATCH_POLICIES) this.registerPolicy(name, VERCEL_BOARD_BUILTIN_POLICY_STEPS[name]);
  }

  register(name: string, step: VercelBoardDispatchStep): void { this.steps.set(name, step); }
  registerPolicy(name: string, steps: readonly string[]): void { this.policies.set(name, [...steps]); }
  step(name: string): VercelBoardDispatchStep | undefined { return this.steps.get(name); }
  stepNames(): string[] { return [...this.steps.keys()]; }
  policy(name: string, defined?: Record<string, string[]>): readonly string[] | undefined { return this.policies.get(name) ?? defined?.[name]; }
  policyNames(): string[] { return [...this.policies.keys()]; }
}

export const vercelBoardDispatchRegistry = new VercelBoardDispatchRegistry();

/** The policy name a channel runs. A `selfServe` channel defaults to role-only, as before policies. */
export function vercelBoardChannelPolicy(config: Pick<VercelBoardConnectionConfig, "dispatch" | "selfServe">, channel: string): string {
  return config.dispatch?.channels?.[channel]?.policy ?? (config.selfServe?.includes(channel) ? "role-only" : config.dispatch?.policy ?? "manual");
}

/** A channel's chain: its own `steps`, else its policy's. Undefined for a policy nobody registered or defined. */
export function vercelBoardChannelSteps(config: Pick<VercelBoardConnectionConfig, "dispatch" | "selfServe">, channel: string, registry = vercelBoardDispatchRegistry): string[] | undefined {
  const own = config.dispatch?.channels?.[channel]?.steps;
  if (own) return [...own];
  const steps = registry.policy(vercelBoardChannelPolicy(config, channel), config.dispatch?.policies);
  return steps ? [...steps] : undefined;
}

/** Combine relaxations: each field takes the widest value any source gives. */
export function vercelBoardMergeTrust(...sources: (VercelBoardDispatchTrust | undefined)[]): VercelBoardDispatchTrust {
  const rank = { operator: 0, allowlist: 1, any: 2 } as const;
  const out: VercelBoardDispatchTrust = {};
  for (const source of sources) {
    if (!source) continue;
    if (source.authors && rank[source.authors] > rank[out.authors ?? "operator"]) out.authors = source.authors;
    if (source.anyEpoch) out.anyEpoch = true;
    if (source.synced?.length) out.synced = [...new Set([...(out.synced ?? []), ...source.synced])];
  }
  return out;
}

const relaxes = (trust: VercelBoardDispatchTrust | undefined) => !!trust && ((trust.authors !== undefined && trust.authors !== "operator") || trust.anyEpoch === true || !!trust.synced?.length);

/** The settings for one candidate in a channel: the chain, and the trust its labels add. */
export function vercelBoardDispatchSettings(config: Pick<VercelBoardConnectionConfig, "dispatch" | "selfServe">, channel: string, labels: Record<string, string>, registry = vercelBoardDispatchRegistry): VercelBoardDispatchSettings | { error: string; policy: string } {
  const own = config.dispatch?.channels?.[channel];
  const policy = own?.steps ? "custom" : vercelBoardChannelPolicy(config, channel);
  const steps = vercelBoardChannelSteps(config, channel, registry);
  if (!steps) return { policy, error: `policy ${policy} is not registered or defined` };
  const labelTrust = (own?.labelTrust ?? []).filter(entry => vercelBoardLabelMatches(labels, entry.label)).map(entry => entry.trust);
  return { policy, steps, trust: vercelBoardMergeTrust(own?.trust, ...labelTrust), labels: own?.labels ?? [], capabilities: config.dispatch?.capabilities ?? {} };
}

/** A channel's dispatch settings as status shows them. */
export function vercelBoardChannelDispatchStatus(config: Pick<VercelBoardConnectionConfig, "dispatch" | "selfServe">, channel: string, mirrored: boolean, registry = vercelBoardDispatchRegistry): VercelBoardChannelDispatchStatus {
  const own = config.dispatch?.channels?.[channel];
  const steps = vercelBoardChannelSteps(config, channel, registry) ?? [];
  const claims = !steps.some(name => registry.step(name)?.skipsAll);
  return {
    channel, policy: own?.steps ? "custom" : vercelBoardChannelPolicy(config, channel), steps,
    guardsRemoved: claims ? VERCEL_BOARD_DEFAULT_GUARDS.filter(guard => !steps.includes(guard)) : [],
    ...(relaxes(own?.trust) ? { trust: own!.trust } : {}),
    ...(own?.labelTrust?.length ? { labelTrust: own.labelTrust } : {}),
    ...(own?.labels?.length ? { labels: own.labels } : {}),
    mirrored,
  };
}

/** Whether a channel's guards are weaker than the defaults: removed, or relaxed by trust. */
export function vercelBoardChannelRelaxed(status: VercelBoardChannelDispatchStatus): boolean {
  return status.guardsRemoved.length > 0 || relaxes(status.trust) || (status.labelTrust ?? []).some(entry => relaxes(entry.trust));
}

/**
 * Check a dispatch block before it is saved: its shape, and that every step
 * and policy it names exists. A typo must fail here, not skip every task.
 */
export function vercelBoardDispatchProblems(dispatch: VercelBoardDispatchConfig, channels: readonly string[], registry = vercelBoardDispatchRegistry): string[] {
  const errors = validateVercelBoardDispatchConfig(dispatch, channels);
  if (errors.length) return errors;
  const known = (name: string) => registry.policy(name, dispatch.policies) !== undefined;
  const unknownStep = (steps: string[], where: string) => steps.filter(name => !registry.step(name)).map(name => `${where}: no step named ${name}`);
  for (const [name, steps] of Object.entries(dispatch.policies ?? {})) errors.push(...unknownStep(steps, `dispatch.policies.${name}`));
  if (dispatch.policy && !known(dispatch.policy)) errors.push(`dispatch.policy: no policy named ${dispatch.policy}`);
  for (const [channel, settings] of Object.entries(dispatch.channels ?? {})) {
    if (settings.policy && !known(settings.policy)) errors.push(`dispatch.channels.${channel}.policy: no policy named ${settings.policy}`);
    if (settings.steps) errors.push(...unknownStep(settings.steps, `dispatch.channels.${channel}.steps`));
  }
  return errors;
}

/**
 * Run a chain for one candidate. Pure for built-in steps. A step that throws,
 * or answers with anything but pass, skip or a claim for a free agent, skips
 * the task: a bad answer never claims.
 */
export async function vercelBoardDecide(candidate: VercelBoardDispatchCandidate, settings: VercelBoardDispatchSettings, registry = vercelBoardDispatchRegistry, now = Date.now()): Promise<VercelBoardDispatchDecision> {
  const base = { taskId: candidate.task.id, channel: candidate.channel, policy: settings.policy, at: now };
  const trail: VercelBoardDispatchDecision["trail"] = [];
  let state: VercelBoardDispatchState = { agents: [...candidate.agents] };
  for (const name of settings.steps) {
    const step = registry.step(name);
    if (!step) {
      trail.push({ step: name, result: "skip", note: "no such step" });
      return { ...base, outcome: "skip", step: name, reason: `no step named ${name}`, trail };
    }
    let result: VercelBoardDispatchStepResult;
    try {
      result = await step.run(candidate, state, settings);
    } catch (error) {
      const reason = `step failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`;
      trail.push({ step: name, result: "skip", note: reason });
      return { ...base, outcome: "skip", step: name, reason, trail };
    }
    if (result?.result === "skip" && typeof result.reason === "string") {
      trail.push({ step: name, result: "skip", note: result.reason });
      return { ...base, outcome: "skip", step: name, reason: result.reason, trail };
    }
    if (result?.result === "claim") {
      const agent = state.agents.find(entry => entry.agentId === result.agentId);
      if (!agent) {
        const reason = `answered a claim for ${String(result.agentId)}, who is not a free candidate`;
        trail.push({ step: name, result: "skip", note: reason });
        return { ...base, outcome: "skip", step: name, reason, trail };
      }
      const profile = typeof result.profile === "string" ? result.profile : state.profile ?? candidate.connection.profile;
      if (!vercelBoardRoles(candidate.connection).includes(profile)) {
        const reason = `answered profile ${profile}, which is not one of the connection's roles`;
        trail.push({ step: name, result: "skip", note: reason });
        return { ...base, outcome: "skip", step: name, reason, trail };
      }
      trail.push({ step: name, result: "claim", ...(result.note ? { note: result.note } : {}) });
      return { ...base, outcome: "claim", step: name, agentId: agent.agentId, profile, trail };
    }
    if (result?.result !== "pass") {
      trail.push({ step: name, result: "skip", note: "bad answer" });
      return { ...base, outcome: "skip", step: name, reason: "the step gave no valid answer", trail };
    }
    // A step narrows the agents; it never adds one.
    const kept = Array.isArray(result.agents) ? new Set(result.agents.map(agent => agent?.agentId)) : undefined;
    const agents = kept ? state.agents.filter(entry => kept.has(entry.agentId)) : state.agents;
    state = { agents, profile: result.profile ?? state.profile, role: result.role !== undefined ? result.role : state.role };
    trail.push({ step: name, result: "pass", ...(result.note ? { note: result.note } : {}) });
  }
  return { ...base, outcome: "skip", reason: "no step claimed it", trail };
}
