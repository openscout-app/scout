/**
 * Scout's one access evaluator: `can(principal, action, resource, turn)`.
 *
 * Pure and synchronous. A caller resolves the facts (who holds which role on
 * the resource, the agent's grant, its owner, a verified turn) and this module
 * decides. It runs unchanged in the runtime, a browser bundle and a Worker.
 *
 * Two role lists sit under it:
 * - Host roles (`owner`, `admin`, `member`, `service`) operate a host on the
 *   mesh. They decide host actions, the same verbs as mesh access.
 * - Content roles (`owner` > `editor` > `viewer` > `discover`) decide what a
 *   principal does with one piece of content: a channel, a project, a volume.
 *
 * Rules:
 * - A read needs the content role and every restriction the resource carries.
 * - An agent is a principal capped by its owner: it never does what its owner
 *   cannot do on that resource right now.
 * - An agent acting for someone acts in a turn. A turn's rights are
 *   initiator ∩ agent grant ∩ requested scope. With no turn, an agent action
 *   is refused, unless its owner gave the grant standing autonomy.
 * - Checked actions resolve to allow, ask or never, and never wins.
 *
 * Fails closed on anything it does not recognise.
 */

export const HOST_ROLES = ["owner", "admin", "member", "service"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** Host actions: the same verbs as mesh access (`scout-access/1`). */
export const HOST_ACTIONS = ["discover", "message", "request", "read-own", "read-history", "admin"] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

/** Content roles, least first. Each holds everything the one before it holds. */
export const CONTENT_ROLES = ["discover", "viewer", "editor", "owner"] as const;
export type ContentRole = (typeof CONTENT_ROLES)[number];

/** Content actions, and the least content role each needs. */
export const CONTENT_ACTIONS = ["discover", "read", "write", "manage"] as const;
export type ContentAction = (typeof CONTENT_ACTIONS)[number];
export const CONTENT_ACTION_ROLE: Readonly<Record<ContentAction, ContentRole>> = {
  discover: "discover",
  read: "viewer",
  write: "editor",
  manage: "owner",
};

export type AccessAction = ContentAction | HostAction;

/**
 * The scope a turn gets when its ask names none. It never includes `manage`
 * or host `admin`: handing those to an agent takes an explicit scope.
 */
export const DEFAULT_TURN_SCOPE: readonly AccessAction[] = ["discover", "read", "write", "message", "request", "read-own"];

export const CHECK_EFFECTS = ["allow", "ask", "never"] as const;
export type CheckEffect = (typeof CHECK_EFFECTS)[number];
/** Per-action checks. An action not named is not checked. */
export type AccessChecks = Readonly<Partial<Record<AccessAction, CheckEffect>>>;

export type PrincipalPerson = {
  kind: "person";
  id: string;
  /** Role on the host the resource lives on. Decides host actions only. */
  hostRole?: HostRole | null;
  /** Restrictions this person is cleared for. */
  clearances?: readonly string[];
};

/**
 * What an agent's owner granted it. `autonomous` lets the agent act on this
 * grant with no turn (a routine it runs by itself); without it, every agent
 * action needs a turn.
 */
export type AgentGrant = {
  actions: readonly AccessAction[];
  expiresAt?: number;
  revoked?: boolean;
  autonomous?: boolean;
  /** Narrows the owner's clearances. Absent means the owner's. */
  clearances?: readonly string[];
  checks?: AccessChecks;
};

export type PrincipalAgent = {
  kind: "agent";
  id: string;
  /** The person the agent is capped by, resolved right now. Null when unknown. */
  owner: PrincipalPerson | null;
  grant: AgentGrant | null;
};

export type Principal = PrincipalPerson | PrincipalAgent;

export type ContentResource = {
  kind: "content";
  id: string;
  /** Content roles held on this resource, by principal id: a projection of the access journal. */
  roles: Readonly<Record<string, ContentRole>>;
  /** Restrictions a reader must be cleared for, every one. */
  restrictions?: readonly string[];
  checks?: AccessChecks;
};

export type HostResource = {
  kind: "host";
  id: string;
  /** Host actions granted to members and services, by principal id. Owners and admins need none. */
  grants?: Readonly<Record<string, readonly HostAction[]>>;
  checks?: AccessChecks;
};

export type AccessResource = ContentResource | HostResource;

/**
 * A verified turn. Only a turn credential the runtime issued, checked by its
 * verifier, should become one of these: a claimed flight id or a copied ref is
 * not a turn.
 */
export type AccessTurn = {
  id: string;
  /** The agent the runtime dispatched the turn to. */
  agentId: string;
  /** The person who started the turn, resolved right now. Null when unknown. */
  initiator: PrincipalPerson | null;
  /** The requested scope. */
  scope: readonly AccessAction[];
  expiresAt: number;
  /** When set, the turn may touch only these resources. */
  resourceIds?: readonly string[];
  checks?: AccessChecks;
};

export const ACCESS_DENY_REASONS = [
  "unknown_action",
  "unknown_resource",
  "unknown_principal",
  "lacks_role",
  "lacks_clearance",
  "host_action_not_granted",
  "host_admin_reserved",
  "no_grant",
  "grant_revoked",
  "grant_expired",
  "not_granted",
  "owner_unknown",
  "owner_lacks_permission",
  "agent_lacks_clearance",
  "turn_required",
  "turn_not_bound",
  "turn_expired",
  "outside_requested_scope",
  "initiator_unknown",
  "initiator_lacks_permission",
  "check_never",
] as const;
export type AccessDenyReason = (typeof ACCESS_DENY_REASONS)[number];

export type AccessDecision =
  | { effect: "allow" }
  | { effect: "ask"; reason: "check_ask" }
  | { effect: "never"; reason: AccessDenyReason };

export type AccessEvaluationOptions = { now?: number };

const ALLOW: AccessDecision = { effect: "allow" };
const never = (reason: AccessDenyReason): AccessDecision => ({ effect: "never", reason });
const RANK: Record<ContentRole, number> = { discover: 0, viewer: 1, editor: 2, owner: 3 };

export const isContentRole = (value: unknown): value is ContentRole =>
  typeof value === "string" && (CONTENT_ROLES as readonly string[]).includes(value);
export const isAccessAction = (value: unknown): value is AccessAction =>
  typeof value === "string" && ((CONTENT_ACTIONS as readonly string[]).includes(value) || (HOST_ACTIONS as readonly string[]).includes(value));

/** The least role that holds both: the cap of two content roles. */
export function minContentRole(a: ContentRole, b: ContentRole): ContentRole {
  return RANK[a] <= RANK[b] ? a : b;
}

export function contentRoleAllows(held: ContentRole | undefined, action: ContentAction): boolean {
  return held !== undefined && RANK[held] >= RANK[CONTENT_ACTION_ROLE[action]];
}

function isContentAction(action: string): action is ContentAction {
  return (CONTENT_ACTIONS as readonly string[]).includes(action);
}
function isHostAction(action: string): action is HostAction {
  return (HOST_ACTIONS as readonly string[]).includes(action);
}

function cleared(restrictions: readonly string[] | undefined, clearances: readonly string[] | undefined): boolean {
  if (!restrictions || restrictions.length === 0) return true;
  if (!clearances) return false;
  return restrictions.every((restriction) => clearances.includes(restriction));
}

/** What a person may do on the resource, by role and restrictions alone. */
function personRights(person: PrincipalPerson, action: AccessAction, resource: AccessResource): AccessDecision {
  if (resource.kind === "host") {
    if (!isHostAction(action)) return never("unknown_action");
    if (person.hostRole === "owner" || person.hostRole === "admin") return ALLOW;
    if (person.hostRole !== "member" && person.hostRole !== "service") return never("lacks_role");
    if (action === "admin") return never("host_admin_reserved");
    return resource.grants?.[person.id]?.includes(action) ? ALLOW : never("host_action_not_granted");
  }
  if (!isContentAction(action)) return never("unknown_action");
  if (!contentRoleAllows(resource.roles[person.id], action)) return never("lacks_role");
  // Discover shows a title; every other action reads the content.
  if (action !== "discover" && !cleared(resource.restrictions, person.clearances)) return never("lacks_clearance");
  return ALLOW;
}

/** never > ask > allow. */
function combineChecks(action: AccessAction, ...sets: (AccessChecks | undefined)[]): AccessDecision {
  let ask = false;
  for (const set of sets) {
    const effect = set?.[action];
    if (effect === "never") return never("check_never");
    if (effect === "ask") ask = true;
    else if (effect !== undefined && effect !== "allow") return never("check_never");
  }
  return ask ? { effect: "ask", reason: "check_ask" } : ALLOW;
}

function agentRights(
  agent: PrincipalAgent,
  action: AccessAction,
  resource: AccessResource,
  turn: AccessTurn | null | undefined,
  now: number,
): AccessDecision {
  const grant = agent.grant;
  if (!grant) return never("no_grant");
  if (grant.revoked) return never("grant_revoked");
  if (grant.expiresAt !== undefined && !(now < grant.expiresAt)) return never("grant_expired");
  if (!grant.actions.includes(action)) return never("not_granted");
  if (resource.kind === "host" && !resource.grants?.[agent.id]?.includes(action as HostAction)) {
    return never("host_action_not_granted");
  }
  // Capped by the owner, right now.
  if (!agent.owner) return never("owner_unknown");
  if (personRights(agent.owner, action, resource).effect !== "allow") return never("owner_lacks_permission");
  if (grant.clearances && resource.kind === "content" && action !== "discover"
    && !cleared(resource.restrictions, grant.clearances)) return never("agent_lacks_clearance");
  if (!turn) return grant.autonomous ? ALLOW : never("turn_required");
  // effective = initiator ∩ agent grant ∩ requested scope.
  if (turn.agentId !== agent.id) return never("turn_not_bound");
  if (!(now < turn.expiresAt)) return never("turn_expired");
  if (!turn.scope.includes(action)) return never("outside_requested_scope");
  if (turn.resourceIds && !turn.resourceIds.includes(resource.id)) return never("outside_requested_scope");
  if (!turn.initiator) return never("initiator_unknown");
  if (personRights(turn.initiator, action, resource).effect !== "allow") return never("initiator_lacks_permission");
  return ALLOW;
}

/** The one decision function. Every route that touches content or a host asks it. */
export function can(
  principal: Principal,
  action: AccessAction,
  resource: AccessResource,
  turn?: AccessTurn | null,
  options: AccessEvaluationOptions = {},
): AccessDecision {
  if (!isAccessAction(action)) return never("unknown_action");
  if (!resource || (resource.kind !== "content" && resource.kind !== "host")) return never("unknown_resource");
  const now = options.now ?? Date.now();
  const rights = principal.kind === "person"
    ? personRights(principal, action, resource)
    : principal.kind === "agent"
      ? agentRights(principal, action, resource, turn, now)
      : never("unknown_principal");
  const checks = combineChecks(
    action,
    resource.checks,
    principal.kind === "agent" ? principal.grant?.checks : undefined,
    principal.kind === "agent" ? turn?.checks : undefined,
  );
  if (checks.effect === "never") return checks;
  if (rights.effect !== "allow") return rights;
  return checks;
}
