/**
 * The shared case table for `can`. Core runs it in access-evaluator.test.ts;
 * any surface that adopts the evaluator (hosted Chat, the web app) runs the
 * same table with `runAccessEvaluatorCases`, so every caller pins one meaning.
 * Add a case here before changing a rule.
 */

import {
  CONTENT_ACTIONS,
  CONTENT_ROLES,
  contentRoleAllows,
  type AccessAction,
  type AccessDecision,
  type AccessResource,
  type AccessTurn,
  type AgentGrant,
  type ContentResource,
  type Principal,
  type PrincipalAgent,
  type PrincipalPerson,
} from "./access-evaluator.js";

export type AccessEvaluatorCase = {
  name: string;
  principal: Principal;
  action: AccessAction;
  resource: AccessResource;
  turn?: AccessTurn | null;
  now: number;
  expect: AccessDecision;
};

const NOW = 1_800_000_000_000;
const LATER = NOW + 60_000;

const ada: PrincipalPerson = { kind: "person", id: "person:ada" };
const bea: PrincipalPerson = { kind: "person", id: "person:bea" };
const cy: PrincipalPerson = { kind: "person", id: "person:cy" };

const channel = (roles: Record<string, (typeof CONTENT_ROLES)[number]>, extra: Partial<ContentResource> = {}): ContentResource =>
  ({ kind: "content", id: "channel:general", roles, ...extra });
const team = channel({ [ada.id]: "owner", [bea.id]: "editor", [cy.id]: "viewer" });

const grant = (extra: Partial<AgentGrant> = {}): AgentGrant => ({ actions: ["discover", "read", "write"], ...extra });
const agent = (extra: Partial<PrincipalAgent> = {}): PrincipalAgent =>
  ({ kind: "agent", id: "agent:helper", owner: ada, grant: grant(), ...extra });
const turn = (extra: Partial<AccessTurn> = {}): AccessTurn =>
  ({ id: "turn-1", agentId: "agent:helper", initiator: bea, scope: ["discover", "read", "write"], expiresAt: LATER, ...extra });

const allow: AccessDecision = { effect: "allow" };
const ask: AccessDecision = { effect: "ask", reason: "check_ask" };
const never = (reason: Extract<AccessDecision, { effect: "never" }>["reason"]): AccessDecision => ({ effect: "never", reason });

/** Every content role against every content action. */
const roleMatrix: AccessEvaluatorCase[] = CONTENT_ROLES.flatMap((role) => CONTENT_ACTIONS.map((action) => ({
  name: `content: ${role} ${contentRoleAllows(role, action) ? "may" : "may not"} ${action}`,
  principal: ada,
  action,
  resource: channel({ [ada.id]: role }),
  now: NOW,
  expect: contentRoleAllows(role, action) ? allow : never("lacks_role"),
})));

export const ACCESS_EVALUATOR_CASES: readonly AccessEvaluatorCase[] = [
  ...roleMatrix,
  { name: "content: no role holds nothing, not even discover", principal: { kind: "person", id: "person:stranger" }, action: "discover", resource: team, now: NOW, expect: never("lacks_role") },
  { name: "content: host owner gets no content role by host role alone", principal: { ...cy, id: "person:host", hostRole: "owner" }, action: "read", resource: team, now: NOW, expect: never("lacks_role") },
  { name: "content: a host action on content is unknown", principal: ada, action: "message", resource: team, now: NOW, expect: never("unknown_action") },
  { name: "content: an unknown action is refused", principal: ada, action: "delete" as AccessAction, resource: team, now: NOW, expect: never("unknown_action") },

  // A read needs the role and every restriction.
  { name: "restriction: viewer without clearance cannot read", principal: cy, action: "read", resource: channel(team.roles, { restrictions: ["finance"] }), now: NOW, expect: never("lacks_clearance") },
  { name: "restriction: viewer with only some clearances cannot read", principal: { ...cy, clearances: ["finance"] }, action: "read", resource: channel(team.roles, { restrictions: ["finance", "legal"] }), now: NOW, expect: never("lacks_clearance") },
  { name: "restriction: viewer with every clearance reads", principal: { ...cy, clearances: ["finance", "legal"] }, action: "read", resource: channel(team.roles, { restrictions: ["finance", "legal"] }), now: NOW, expect: allow },
  { name: "restriction: discover sees the title without clearance", principal: cy, action: "discover", resource: channel(team.roles, { restrictions: ["finance"] }), now: NOW, expect: allow },
  { name: "restriction: clearance does not stand in for a role", principal: { kind: "person", id: "person:stranger", clearances: ["finance"] }, action: "read", resource: channel(team.roles, { restrictions: ["finance"] }), now: NOW, expect: never("lacks_role") },

  // Agents are principals capped by their owner.
  { name: "agent: no grant", principal: agent({ grant: null }), action: "read", resource: team, turn: turn(), now: NOW, expect: never("no_grant") },
  { name: "agent: revoked grant", principal: agent({ grant: grant({ revoked: true }) }), action: "read", resource: team, turn: turn(), now: NOW, expect: never("grant_revoked") },
  { name: "agent: expired grant", principal: agent({ grant: grant({ expiresAt: NOW }) }), action: "read", resource: team, turn: turn(), now: NOW, expect: never("grant_expired") },
  { name: "agent: action outside its grant", principal: agent({ grant: grant({ actions: ["read"] }) }), action: "write", resource: team, turn: turn(), now: NOW, expect: never("not_granted") },
  { name: "agent: unknown owner", principal: agent({ owner: null }), action: "read", resource: team, turn: turn(), now: NOW, expect: never("owner_unknown") },
  { name: "agent: owner became a viewer, agent cannot write", principal: agent({ owner: cy }), action: "write", resource: team, turn: turn(), now: NOW, expect: never("owner_lacks_permission") },
  { name: "agent: owner without clearance caps the agent", principal: agent({ grant: grant({ clearances: ["finance"] }) }), action: "read", resource: channel(team.roles, { restrictions: ["finance"] }), turn: turn({ initiator: { ...bea, clearances: ["finance"] } }), now: NOW, expect: never("owner_lacks_permission") },
  { name: "agent: grant clearances narrow the owner's", principal: agent({ owner: { ...ada, clearances: ["finance"] }, grant: grant({ clearances: [] }) }), action: "read", resource: channel(team.roles, { restrictions: ["finance"] }), turn: turn({ initiator: { ...bea, clearances: ["finance"] } }), now: NOW, expect: never("agent_lacks_clearance") },

  // A turn's rights = initiator ∩ agent grant ∩ requested scope. No turn, no action.
  { name: "turn: missing turn is refused", principal: agent(), action: "write", resource: team, turn: null, now: NOW, expect: never("turn_required") },
  { name: "turn: missing turn is refused even for a read", principal: agent(), action: "read", resource: team, now: NOW, expect: never("turn_required") },
  { name: "turn: an autonomous grant acts with no turn, capped by its owner", principal: agent({ grant: grant({ autonomous: true }) }), action: "write", resource: team, turn: null, now: NOW, expect: allow },
  { name: "turn: an autonomous grant is still capped by its owner", principal: agent({ owner: cy, grant: grant({ autonomous: true }) }), action: "write", resource: team, turn: null, now: NOW, expect: never("owner_lacks_permission") },
  { name: "turn: an autonomous grant in a turn is still capped by the turn", principal: agent({ grant: grant({ autonomous: true }) }), action: "write", resource: team, turn: turn({ initiator: cy }), now: NOW, expect: never("initiator_lacks_permission") },
  { name: "turn: bound to another agent", principal: agent(), action: "read", resource: team, turn: turn({ agentId: "agent:other" }), now: NOW, expect: never("turn_not_bound") },
  { name: "turn: expired", principal: agent(), action: "read", resource: team, turn: turn({ expiresAt: NOW }), now: NOW, expect: never("turn_expired") },
  { name: "turn: action outside the requested scope", principal: agent(), action: "write", resource: team, turn: turn({ scope: ["read"] }), now: NOW, expect: never("outside_requested_scope") },
  { name: "turn: resource outside the requested scope", principal: agent(), action: "read", resource: team, turn: turn({ resourceIds: ["channel:other"] }), now: NOW, expect: never("outside_requested_scope") },
  { name: "turn: resource inside the requested scope", principal: agent(), action: "read", resource: team, turn: turn({ resourceIds: [team.id] }), now: NOW, expect: allow },
  { name: "turn: unknown initiator", principal: agent(), action: "read", resource: team, turn: turn({ initiator: null }), now: NOW, expect: never("initiator_unknown") },
  { name: "turn: initiator is a viewer, agent cannot write for them", principal: agent(), action: "write", resource: team, turn: turn({ initiator: cy }), now: NOW, expect: never("initiator_lacks_permission") },
  { name: "turn: viewer initiator, agent can read for them", principal: agent(), action: "read", resource: team, turn: turn({ initiator: cy }), now: NOW, expect: allow },
  { name: "turn: initiator with no role, agent cannot read for them", principal: agent(), action: "read", resource: team, turn: turn({ initiator: { kind: "person", id: "person:stranger" } }), now: NOW, expect: never("initiator_lacks_permission") },
  { name: "turn: initiator without clearance caps the agent", principal: agent({ owner: { ...ada, clearances: ["finance"] } }), action: "read", resource: channel(team.roles, { restrictions: ["finance"] }), turn: turn(), now: NOW, expect: never("initiator_lacks_permission") },
  { name: "turn: owner, grant, scope and initiator all hold write", principal: agent(), action: "write", resource: team, turn: turn(), now: NOW, expect: allow },
  { name: "turn: manage needs it in the grant even when owner and initiator hold it", principal: agent(), action: "manage", resource: team, turn: turn({ initiator: ada, scope: ["manage"] }), now: NOW, expect: never("not_granted") },
  { name: "turn: manage needs it in the scope", principal: agent({ grant: grant({ actions: ["manage"] }) }), action: "manage", resource: team, turn: turn({ initiator: ada }), now: NOW, expect: never("outside_requested_scope") },
  { name: "turn: a person ignores the turn", principal: cy, action: "write", resource: team, turn: turn({ initiator: ada, scope: ["write"] }), now: NOW, expect: never("lacks_role") },

  // allow, ask or never; never wins.
  { name: "check: ask on the resource asks", principal: bea, action: "write", resource: channel(team.roles, { checks: { write: "ask" } }), now: NOW, expect: ask },
  { name: "check: allow changes nothing", principal: bea, action: "write", resource: channel(team.roles, { checks: { write: "allow" } }), now: NOW, expect: allow },
  { name: "check: never on the resource wins over the owner", principal: ada, action: "write", resource: channel(team.roles, { checks: { write: "never" } }), now: NOW, expect: never("check_never") },
  { name: "check: never on the grant wins over ask on the resource", principal: agent({ grant: grant({ checks: { write: "never" } }) }), action: "write", resource: channel(team.roles, { checks: { write: "ask" } }), turn: turn(), now: NOW, expect: never("check_never") },
  { name: "check: ask on the turn asks", principal: agent(), action: "write", resource: team, turn: turn({ checks: { write: "ask" } }), now: NOW, expect: ask },
  { name: "check: ask does not rescue a missing role", principal: cy, action: "write", resource: channel(team.roles, { checks: { write: "ask" } }), now: NOW, expect: never("lacks_role") },
  { name: "check: never is reported even when the role is missing", principal: cy, action: "write", resource: channel(team.roles, { checks: { write: "never" } }), now: NOW, expect: never("check_never") },
  { name: "check: an unknown effect is never", principal: ada, action: "read", resource: channel(team.roles, { checks: { read: "maybe" as "ask" } }), now: NOW, expect: never("check_never") },

  // Host roles operate hosts; they are the mesh verbs.
  { name: "host: owner may administer", principal: { ...ada, hostRole: "owner" }, action: "admin", resource: { kind: "host", id: "host:a" }, now: NOW, expect: allow },
  { name: "host: admin may read history", principal: { ...ada, hostRole: "admin" }, action: "read-history", resource: { kind: "host", id: "host:a" }, now: NOW, expect: allow },
  { name: "host: member with a grant may message", principal: { ...bea, hostRole: "member" }, action: "message", resource: { kind: "host", id: "host:a", grants: { [bea.id]: ["message"] } }, now: NOW, expect: allow },
  { name: "host: member without a grant may not", principal: { ...bea, hostRole: "member" }, action: "request", resource: { kind: "host", id: "host:a", grants: { [bea.id]: ["message"] } }, now: NOW, expect: never("host_action_not_granted") },
  { name: "host: admin is reserved to owners and admins", principal: { ...bea, hostRole: "member" }, action: "admin", resource: { kind: "host", id: "host:a", grants: { [bea.id]: ["admin"] } }, now: NOW, expect: never("host_admin_reserved") },
  { name: "host: no host role holds nothing", principal: bea, action: "discover", resource: { kind: "host", id: "host:a", grants: { [bea.id]: ["discover"] } }, now: NOW, expect: never("lacks_role") },
  { name: "host: a content action on a host is unknown", principal: { ...ada, hostRole: "owner" }, action: "write", resource: { kind: "host", id: "host:a" }, now: NOW, expect: never("unknown_action") },
  { name: "host: agent needs its own host grant", principal: agent({ owner: { ...ada, hostRole: "owner" }, grant: grant({ actions: ["message"] }) }), action: "message", resource: { kind: "host", id: "host:a" }, turn: turn({ initiator: { ...ada, hostRole: "owner" }, scope: ["message"] }), now: NOW, expect: never("host_action_not_granted") },
  { name: "host: agent with a grant, in an owner's turn, may message", principal: agent({ owner: { ...ada, hostRole: "owner" }, grant: grant({ actions: ["message"] }) }), action: "message", resource: { kind: "host", id: "host:a", grants: { "agent:helper": ["message"] } }, turn: turn({ initiator: { ...ada, hostRole: "owner" }, scope: ["message"] }), now: NOW, expect: allow },
  { name: "host: agent cannot message for a member who holds no grant", principal: agent({ owner: { ...ada, hostRole: "owner" }, grant: grant({ actions: ["message"] }) }), action: "message", resource: { kind: "host", id: "host:a", grants: { "agent:helper": ["message"] } }, turn: turn({ initiator: { ...bea, hostRole: "member" }, scope: ["message"] }), now: NOW, expect: never("initiator_lacks_permission") },
];

export type AccessEvaluatorCaseFailure = { name: string; expected: AccessDecision; actual: AccessDecision };

/** Run the table against an evaluator. Returns the cases that disagree. */
export function runAccessEvaluatorCases(
  evaluate: (principal: Principal, action: AccessAction, resource: AccessResource, turn: AccessTurn | null | undefined, options: { now: number }) => AccessDecision,
  cases: readonly AccessEvaluatorCase[] = ACCESS_EVALUATOR_CASES,
): AccessEvaluatorCaseFailure[] {
  const failures: AccessEvaluatorCaseFailure[] = [];
  for (const item of cases) {
    const actual = evaluate(item.principal, item.action, item.resource, item.turn, { now: item.now });
    if (actual.effect !== item.expect.effect || ("reason" in actual ? actual.reason : undefined) !== ("reason" in item.expect ? item.expect.reason : undefined)) {
      failures.push({ name: item.name, expected: item.expect, actual });
    }
  }
  return failures;
}
