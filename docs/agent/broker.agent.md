# Broker Agent Notes

Source: `packages/runtime/**`, `packages/protocol/**`, `docs/architecture.md` (data model section).

Status: canonical writer semantics for local runtime. Complements `scout-comms.agent.md` (workflows).

Verified: 2026-06-19

## Role

The runtime is the local daemon that **owns, persists, routes, and streams** Scout coordination state. One runtime per machine (authority node). Surfaces and agents are readers/writers through HTTP/SSE/MCP/CLI — not parallel sources of truth.

`broker-daemon.ts` is the process composition root (~1.3k lines). Write workflows live in
`broker-*` service modules; HTTP routing lives in `broker-http-router.ts`. Full module map:
[`docs/architecture.md`](../architecture.md) (Broker → module map).

## Model

| Noun | Type / package | Meaning |
|---|---|---|
| `node` | protocol | machine authority; hosts broker |
| `actor` | protocol | registered participant surface |
| `agent` | protocol | durable addressable identity |
| `endpoint` | protocol | routable attachment: agent + session + transport + node |
| `session` | runtime metadata | harness conversation/process reference |
| `conversation` | `ConversationDefinition` | DM, channel, or thread boundary |
| `message` | `MessageRecord` | durable communicative turn |
| `invocation` | `InvocationRequest` | explicit work request |
| `flight` | `FlightRecord` | invocation lifecycle |
| `delivery` | `DeliveryIntent` / receipts | transport fan-out plan + result |
| `dispatch` | `ScoutDispatchRecord` | routing diagnostic (ambiguous/unknown/unavailable) |
| `binding` | `ConversationBinding` | external thread/channel map |
| `question` | collaboration | lightweight info-seeking record |
| `work_item` | collaboration | owned execution with progress states |
| `usage` | metadata | token/cost telemetry linked to records |

## Ownership Split

| Scout owns (persist) | Scout observes (do not bulk-import) |
|---|---|
| messages, invocations, flights, deliveries | Claude/Codex JSONL transcripts |
| agent registrations, endpoints, bindings | harness logs, native thread ids |
| questions, work_items created via Scout | harness-owned `.claude` ecosystem writes |
| dispatch, forward, reply records | raw provider turn streams |

Rule: `message` = Scout conversation record. Observed harness events ≠ messages unless explicitly created through Scout APIs.

## Relations

```plaintext
node 1—1 broker process
broker 1—* agent registration
agent 1—* endpoint (over time / harness / worktree)
endpoint *—1 session (when attached)
conversation 1—* message
invocation 1—1 flight
message/invocation → delivery → endpoint/harness transport
mesh peer broker → forwards to authority node for remote agents
```

## Routing Outcomes

Target resolution returns one of:

| Outcome | Caller gets |
|---|---|
| accepted | durable ids + endpoint/session context |
| accepted + wake | receipt + attach/start progress |
| ambiguous | `ScoutDispatchRecord` + candidates + recommended FQN |
| unknown | diagnostic + remediation commands |
| unavailable | reason (`harness_mismatch`, `no_session`, etc.) |

Broker should coach remediation in the error, not force `who`/`latest` preflight loops.

Route aliases are runtime-owned current rows plus immutable revisions in
`route_alias_bindings` / `route_alias_revisions`; they are not
`runtime_session_aliases`. Resolution precedence is exact typed target,
explicit route alias, native agent identity, scoped bare route alias, then
legacy target/session-handle fallback. Acceptance pins the alias proof and
canonical target; repoint/unset never rewrites prior records.

## Endpoint vs Flight State

Keep separate:

| Layer | States (subset) | Meaning |
|---|---|---|
| endpoint | `registered`, `attaching`, `waking`, `idle`, `working`, `unreachable`, `failed`, `superseded`, `stopped` | routable attachment health |
| flight | invocation lifecycle (pending, ack, waiting, done, failed, …) | one ask's execution |

Endpoint `idle` + flight `waiting` is valid. Endpoint `superseded` is diagnostic only.

## Session Attachment Rules

1. Project/capability targets (`projectPath` + optional `harness`) → broker chooses or creates a compatible fresh worker.
2. Card/label/agent-id targets → **fresh** harness session for new work.
3. `session:<id>` / `targetSessionId` → continue exact prior harness context.
4. Harness mismatch (Codex target, Claude session) → fail loud; no silent bind.
5. Session metadata may survive restart; reachability must be reconfirmed (`reachability_unknown` until attach/wake).

## Transport Surfaces

| Surface | Write path | Read path |
|---|---|---|
| CLI | `scout ask`, `scout reply`, … | `scout who`, `scout latest`, `scout inbox` |
| MCP | `ask`, `reply`, `work_update` | `messages_inbox`, `invocations_get`, `broker_feed` |
| HTTP | `/v1/*` broker API | `/v1/snapshot`, SSE watch |
| Mesh | forward to authority broker | peer snapshot merge |

Prefer broker snapshots (health, who, runtime) over surface subprocess/filesystem probes.

## Health Snapshot

`BrokerHealthSnapshot` (runtime):

| Field | Use |
|---|---|
| `reachable`, `ok` | can CLI/MCP proceed? |
| `nodeId`, `meshId` | authority identity |
| `counts.*` | agents, messages, flights, registrations |
| `transport` | `http`, `unix_socket`, `in_process` |

TTL-cached; surfaces stale-while-revalidate. Expensive probes coalesce in broker.

## Mesh (reachability only)

| Term | Meaning |
|---|---|
| `authorityNodeId` | broker that owns an agent record |
| `mesh peer` | remote broker discovered via Tailscale or `OPENSCOUT_MESH_SEEDS` |
| forward | HTTP proxy of deliver/ask to authority |

Mesh ≠ exactly-once, consensus, or transcript replication.

## Invariants

1. One canonical writer per coordination record class.
2. Routing uses explicit target fields; body text is payload.
3. One explicit target → DM; groups need explicit `channel`.
4. `scout ask` creates invocation + flight; `scout ask --fyi` does not.
5. Receipt ids (`conversationId`, `messageId`, `flightId`, `workId`) always returned on success paths.
6. Remote agents resolve via `authorityNodeId` forward, not local guess.
7. Broker journal + SQLite projections are derived from owned records only.

## Forbidden

- Bulk-import harness JSONL turns into `message` table.
- Mutate harness-owned config (`.claude` agents/teams) from adapters.
- Surface-level filesystem scan when broker snapshot exists.
- Use `channel.shared` as implicit default for unnamed multi-target sends.
- Treat pairing-bridge sessions as broker endpoints without registration.

## Types

Primary: `@openscout/protocol` — `MessageRecord`, `FlightRecord`, `ScoutDispatchRecord`, `ScoutRouteTarget`, thread event envelopes.

## Code map

| Concern | Module(s) |
|---|---|
| composition root | `broker-daemon.ts` |
| HTTP routes | `broker-http-router.ts`, `broker-http-entity-write-routes.ts` |
| read facade | `broker-core-service.ts`, `broker-api.ts` |
| durable writes | `broker-durable-store.ts`, `broker-durable-record-store.ts` |
| `/v1/deliver` | `broker-delivery-acceptance-service.ts`, `broker-delivery-routing.ts` |
| invocations | `broker-invocation-dispatch-service.ts` |
| endpoint pick + local exec | `broker-local-endpoint-resolver.ts`, `broker-local-invocation-service.ts`, `broker-local-invocation-helpers.ts` |
| flights | `broker-flight-lifecycle-service.ts` |
| conversations/messages | `broker-conversation-service.ts`, `broker-message-service.ts` |
| mesh | `broker-mesh-*-service.ts` |
| managed sessions | `broker-managed-session-service.ts` |
| label resolution | `scout-dispatcher.ts` |
| in-memory registry | `broker.ts` |
| harness transports | `local-agents.ts`, `local-agent-transports.ts` |

Refactor context: the 2026-06-18 broker-daemon architecture review (removed from the tree as a one-off; see git history).

## Verification

```bash
scout doctor --json
scout who --json
scout whoami
scout ask --to <agent-from-who> "broker-smoke"
```

Live broker (example): `http://127.0.0.1:43110`.
