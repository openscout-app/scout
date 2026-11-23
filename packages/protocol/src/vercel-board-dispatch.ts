/**
 * The Vercel Board dispatcher's contract: which ready Board tasks Scout's
 * runtime claims on its own, and for which agent. See docs/vercel-board.md,
 * "Dispatch policy".
 *
 * A policy is an ordered chain of named steps. Each step reads one candidate
 * task and either passes it on (optionally narrowing the free agents or
 * choosing the profile to claim as), skips it with a reason, or claims it for
 * one agent. The built-in policies are chains of built-in steps, registered by
 * name like any other.
 */

/** The policies the runtime ships. A connection can define more in `policies`. */
export const VERCEL_BOARD_DISPATCH_POLICIES = ["manual", "role-only", "label-matched", "trusted-channel"] as const;
export type VercelBoardBuiltinDispatchPolicy = typeof VERCEL_BOARD_DISPATCH_POLICIES[number];

/**
 * The guards every built-in claiming policy starts with, in order. Removing
 * one from a channel's chain, or relaxing it with `trust`, takes explicit
 * per-channel or per-label configuration, and status names it.
 */
export const VERCEL_BOARD_DEFAULT_GUARDS = ["guard:not-synced", "guard:operator-authored", "guard:first-claim"] as const;

/** The chain each built-in policy runs. */
export const VERCEL_BOARD_BUILTIN_POLICY_STEPS: Record<VercelBoardBuiltinDispatchPolicy, readonly string[]> = {
  manual: ["manual"],
  "role-only": [...VERCEL_BOARD_DEFAULT_GUARDS, "resolve:for", "match:role", "pick:first"],
  "label-matched": [...VERCEL_BOARD_DEFAULT_GUARDS, "resolve:for", "match:label", "match:capability", "pick:first"],
  "trusted-channel": [...VERCEL_BOARD_DEFAULT_GUARDS, "resolve:for", "match:role-or-any", "pick:first"],
};

/**
 * How far a channel, or a label in it, relaxes the default guards. Every
 * field is an explicit operator opt-in; absent means the default guard holds.
 * - `authors`: `operator` (default) admits only tasks the operator made and
 *   wrote as themselves or as Scout's profile; `allowlist` admits tasks whose
 *   owner and author are both on the connection's owner allowlist; `any`
 *   admits every author.
 * - `anyEpoch`: admit a task the board has seen claimed before. Scout still
 *   never claims a task again at an epoch it already held, and never retries
 *   an attempt that got no claim.
 * - `synced`: the sync keys (such as `slack`, `github`, `linear`) whose
 *   imported tasks may start work. `*` admits every sync key.
 */
export interface VercelBoardDispatchTrust {
  authors?: "operator" | "allowlist" | "any";
  anyEpoch?: boolean;
  synced?: string[];
}

/** One channel's dispatch settings. Absent fields fall back to the connection's. */
export interface VercelBoardChannelDispatchConfig {
  /** A built-in policy name or one from the connection's `policies`. */
  policy?: string;
  /** Replace the policy's chain for this channel with these step names, in order. */
  steps?: string[];
  /**
   * Label selectors that make a task eligible under `label-matched`
   * (`match:label`): `key` matches any value, `key=value` matches exactly.
   */
  labels?: string[];
  /** Relax the default guards for every task in this channel. */
  trust?: VercelBoardDispatchTrust;
  /** Relax the default guards only for tasks that carry the label. */
  labelTrust?: { label: string; trust: VercelBoardDispatchTrust }[];
}

/**
 * An out-of-process step, `external:<name>` in a chain: an extension the
 * operator installed with `scout extensions install`, pinned by digest.
 */
export interface VercelBoardExternalStepConfig {
  /** The extension's name, as `scout extensions` lists it. */
  extension: string;
  /** The sha256 of the extension's manifest and command, as Scout computes it. A changed artifact skips every task. */
  digest: string;
  /** How long one answer may take. Default 2000, at most 10000. */
  timeoutMs?: number;
}

/** Per-connection dispatch settings, kept in the connection file. Every field is optional. */
export interface VercelBoardDispatchConfig {
  /**
   * Run the dispatcher for this connection. Default true. False pauses every
   * automatic claim; renewals and settles of held claims continue.
   */
  enabled?: boolean;
  /**
   * The policy for a channel with no policy of its own. Default `manual`.
   * A channel in the connection's `selfServe` list defaults to `role-only`.
   */
  policy?: string;
  /** Named chains the operator defines, usable as a channel's `policy`. */
  policies?: Record<string, string[]>;
  /** Per-channel settings, keyed by followed channel. */
  channels?: Record<string, VercelBoardChannelDispatchConfig>;
  /**
   * Capabilities, for `match:capability`: a label selector mapped to the
   * Scout agents that can do tasks carrying it. `{ "area=web": ["agent-a"] }`.
   */
  capabilities?: Record<string, string[]>;
  /** Out-of-process steps by name; a chain names one as `external:<name>`. */
  external?: Record<string, VercelBoardExternalStepConfig>;
}

/** What a policy decided for one task. */
export type VercelBoardDispatchOutcome = "claim" | "skip";

export interface VercelBoardDispatchDecision {
  taskId: string;
  channel: string;
  /** The policy name, or `custom` when the channel names its own steps. */
  policy: string;
  outcome: VercelBoardDispatchOutcome;
  /** The step that skipped or claimed. */
  step?: string;
  reason?: string;
  agentId?: string;
  /** The Board profile the claim goes as. */
  profile?: string;
  /** The steps that ran, in order, each with what it did. */
  trail: { step: string; result: "pass" | "skip" | "claim"; note?: string }[];
  /** Set by a dispatcher pass: whether the claim landed, or why it did not. */
  claimed?: boolean;
  error?: string;
  at: number;
}

/** One channel's dispatch settings, resolved, as status shows them. */
export interface VercelBoardChannelDispatchStatus {
  channel: string;
  policy: string;
  steps: string[];
  /** Default guards this channel's chain leaves out. */
  guardsRemoved: string[];
  /** The relaxations in force for every task in the channel. */
  trust?: VercelBoardDispatchTrust;
  /** The relaxations in force for tasks with a label. */
  labelTrust?: { label: string; trust: VercelBoardDispatchTrust }[];
  labels?: string[];
  /** Whether the channel is mirrored. The dispatcher reads demand from the mirror only. */
  mirrored: boolean;
}

/** A held claim as status shows it. Never the claim token. */
export interface VercelBoardClaimStatus {
  taskId: string;
  agentId: string;
  profile: string | null;
  state: "claiming" | "claim_unknown" | "held" | "blocked" | "settling";
  epoch: number | null;
  /** When Board's lease ends, unless renewed. */
  until: number | null;
  leaseSeconds: number;
  /** When the lease was last granted or renewed. */
  renewedAt: number | null;
  /** When the runtime renews next: a third of the way into the lease, while the agent's flight lives. */
  renewDueAt: number | null;
  startedBy: string;
  flightId: string | null;
}

export interface VercelBoardDispatcherStatus {
  connectionId: string;
  enabled: boolean;
  /** The connection's default policy. */
  policy: string;
  channels: VercelBoardChannelDispatchStatus[];
  capabilities: Record<string, string[]>;
  policies: Record<string, string[]>;
  /** Every step name the runtime knows. */
  steps: string[];
  /** What wakes a pass: feed events, and a periodic sweep. */
  wakes: { events: true; sweepMs: number };
  lastPassAt?: number;
  /** The newest decisions, newest last. A decision is recorded when it changes for a task. */
  recent: VercelBoardDispatchDecision[];
  /** Claims the runtime holds or is settling, with their leases. */
  claims: VercelBoardClaimStatus[];
  /** The saved settings block, as set: what a change starts from. */
  config: VercelBoardDispatchConfig;
}

/** Replace a connection's dispatch settings. Only the operator does this. */
export interface VercelBoardDispatchSetRequest {
  connectionId: string;
  actorId: string;
  dispatch: VercelBoardDispatchConfig;
}

/** Run one dispatcher pass now, or explain one task without claiming it. */
export interface VercelBoardDispatchRunRequest {
  connectionId: string;
  actorId: string;
  /** Explain this task's decision; claims nothing. */
  explain?: string;
}

export interface VercelBoardDispatchRunResponse {
  connectionId: string;
  decisions: VercelBoardDispatchDecision[];
}

const NAME = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
const AGENT = /^[^\u0000-\u001f\u007f]{1,256}$/;
const SYNC_KEY = /^(\*|[A-Za-z0-9][A-Za-z0-9_./-]{0,127})$/;

/** A label selector: `key` or `key=value`. */
export function isVercelBoardLabelSelector(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/^=|[\u0000-\u001f\u007f]/.test(value);
}

/** Whether a task's labels match a selector: `key` matches any value, `key=value` exactly. */
export function vercelBoardLabelMatches(labels: Record<string, string>, selector: string): boolean {
  const index = selector.indexOf("=");
  if (index < 0) return Object.prototype.hasOwnProperty.call(labels, selector);
  const key = selector.slice(0, index);
  return Object.prototype.hasOwnProperty.call(labels, key) && labels[key] === selector.slice(index + 1);
}

export function isVercelBoardDispatchName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && NAME.test(value);
}

function validateTrust(value: unknown, where: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${where} must be an object`];
  const t = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(t)) if (!["authors", "anyEpoch", "synced"].includes(key)) errors.push(`${where}.${key} is not a trust field`);
  if (t.authors !== undefined && !["operator", "allowlist", "any"].includes(t.authors as string)) errors.push(`${where}.authors must be operator, allowlist or any`);
  if (t.anyEpoch !== undefined && typeof t.anyEpoch !== "boolean") errors.push(`${where}.anyEpoch must be true or false`);
  if (t.synced !== undefined && (!Array.isArray(t.synced) || t.synced.length > 16 || !t.synced.every(key => typeof key === "string" && SYNC_KEY.test(key)))) {
    errors.push(`${where}.synced must list sync keys, or *`);
  }
  return errors;
}

/**
 * Validate a dispatch block's shape against the connection's followed
 * channels. Step and policy names are checked again by the runtime, which
 * knows the registered steps.
 */
export function validateVercelBoardDispatchConfig(value: unknown, channels: readonly string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["dispatch must be an object"];
  const d = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(d)) if (!["enabled", "policy", "policies", "channels", "capabilities", "external"].includes(key)) errors.push(`dispatch.${key} is not a dispatch field`);
  if (d.enabled !== undefined && typeof d.enabled !== "boolean") errors.push("dispatch.enabled must be true or false");
  if (d.policy !== undefined && !isVercelBoardDispatchName(d.policy)) errors.push("dispatch.policy must be a policy name");
  const chain = (steps: unknown, where: string) => {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32 || !steps.every(isVercelBoardDispatchName)) errors.push(`${where} must list 1-32 step names`);
  };
  if (d.policies !== undefined) {
    if (!d.policies || typeof d.policies !== "object" || Array.isArray(d.policies)) errors.push("dispatch.policies must map names to step lists");
    else for (const [name, steps] of Object.entries(d.policies)) {
      if (!isVercelBoardDispatchName(name)) errors.push(`dispatch.policies: ${name} is not a policy name`);
      else if ((VERCEL_BOARD_DISPATCH_POLICIES as readonly string[]).includes(name)) errors.push(`dispatch.policies: ${name} is built in and cannot be redefined`);
      chain(steps, `dispatch.policies.${name}`);
    }
  }
  if (d.channels !== undefined) {
    if (!d.channels || typeof d.channels !== "object" || Array.isArray(d.channels)) errors.push("dispatch.channels must map followed channels to settings");
    else for (const [channel, raw] of Object.entries(d.channels)) {
      const where = `dispatch.channels.${channel}`;
      if (!channels.includes(channel)) { errors.push(`${where}: ${channel} is not a followed channel`); continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where} must be an object`); continue; }
      const c = raw as Record<string, unknown>;
      for (const key of Object.keys(c)) if (!["policy", "steps", "labels", "trust", "labelTrust"].includes(key)) errors.push(`${where}.${key} is not a channel dispatch field`);
      if (c.policy !== undefined && !isVercelBoardDispatchName(c.policy)) errors.push(`${where}.policy must be a policy name`);
      if (c.steps !== undefined) chain(c.steps, `${where}.steps`);
      if (c.labels !== undefined && (!Array.isArray(c.labels) || c.labels.length > 32 || !c.labels.every(isVercelBoardLabelSelector))) errors.push(`${where}.labels must list label selectors`);
      if (c.trust !== undefined) errors.push(...validateTrust(c.trust, `${where}.trust`));
      if (c.labelTrust !== undefined) {
        if (!Array.isArray(c.labelTrust) || c.labelTrust.length > 32) errors.push(`${where}.labelTrust must list { label, trust }`);
        else c.labelTrust.forEach((entry, index) => {
          const e = entry as Record<string, unknown> | null;
          if (!e || typeof e !== "object" || !isVercelBoardLabelSelector(e.label)) errors.push(`${where}.labelTrust[${index}].label must be a label selector`);
          else errors.push(...validateTrust(e.trust, `${where}.labelTrust[${index}].trust`));
        });
      }
    }
  }
  if (d.capabilities !== undefined) {
    if (!d.capabilities || typeof d.capabilities !== "object" || Array.isArray(d.capabilities)) errors.push("dispatch.capabilities must map label selectors to agent IDs");
    else for (const [selector, agents] of Object.entries(d.capabilities)) {
      if (!isVercelBoardLabelSelector(selector)) errors.push(`dispatch.capabilities: ${selector} is not a label selector`);
      if (!Array.isArray(agents) || agents.length > 64 || !agents.every(agent => typeof agent === "string" && AGENT.test(agent) && agent.trim() === agent)) {
        errors.push(`dispatch.capabilities.${selector} must list Scout agent IDs`);
      }
    }
  }
  if (d.external !== undefined) {
    if (!d.external || typeof d.external !== "object" || Array.isArray(d.external)) errors.push("dispatch.external must map names to extensions");
    else for (const [name, raw] of Object.entries(d.external)) {
      const where = `dispatch.external.${name}`;
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) errors.push(`dispatch.external: ${name} is not a step name`);
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || Array.isArray(e)) { errors.push(`${where} must be an object`); continue; }
      for (const key of Object.keys(e)) if (!["extension", "digest", "timeoutMs"].includes(key)) errors.push(`${where}.${key} is not an external step field`);
      if (typeof e.extension !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(e.extension)) errors.push(`${where}.extension must name an installed extension`);
      if (typeof e.digest !== "string" || !/^[a-f0-9]{64}$/.test(e.digest)) errors.push(`${where}.digest must be the extension's sha256 digest`);
      if (e.timeoutMs !== undefined && (!Number.isInteger(e.timeoutMs) || (e.timeoutMs as number) < 100 || (e.timeoutMs as number) > 10_000)) errors.push(`${where}.timeoutMs must be 100 to 10000`);
    }
  }
  return errors;
}
