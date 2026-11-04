# Runtime Sessions

Scout began as a local communications layer: find the other sessions already
running, route messages between them, and preserve enough runtime state that
humans and agents did not have to paste context by hand.

That is still true, but it is no longer the whole contract. Scout also owns
local harness orchestration for developer environments. It can start, attach, wake,
and monitor Claude, Codex, and future harness sessions. This document names the
runtime semantics that make that deterministic.

Status: v0 product direction. Update this page before changing user-facing CLI,
MCP, skill, or broker semantics around harness lifecycle.

## Core Nouns

| Noun | Meaning |
| --- | --- |
| Agent | Durable addressable domain identity, such as `hudson.main.air-local` |
| Session | An opaque broker handle resolving to one concrete harness context |
| Endpoint | The routable attachment between one agent identity and one session |
| Invocation | A runtime-owned request for an agent to do something |
| Flight | The lifecycle state for an invocation |
| Card | A shareable identity and return address; not by itself a running session |

Use **session** as the public noun. Avoid introducing a separate user-facing
`thread` concept unless a specific harness forces it; map harness thread ids
into Scout session metadata instead.

## Invariants

1. A card creates or describes identity. It must not imply that a harness session
   is running unless the command explicitly starts one.
2. A session is always harness-specific. A Codex session cannot satisfy a Claude
   endpoint, and a Claude session cannot satisfy a Codex endpoint.
3. An endpoint must declare `agentId`, `harness`, `transport`, `sessionId`,
   `state`, wake policy, and whether it is the preferred endpoint for that
   agent/harness pair.
4. A broker receipt means the runtime accepted and recorded the request. It does
   not mean a harness session has completed the work.
5. Every user-visible delivery or invocation should return durable ids that can
   be referenced later. A message receipt returns `conversationId` and
   `messageId`. An invocation receipt returns `conversationId`, `messageId`,
   `invocationId`, and `flightId`. A work handoff also returns `workId`.
6. If Scout cannot start, attach, wake, or route to a compatible session, it
   must fail with a specific reason and a concrete remediation. Silent parked
   limbo is a product bug.
7. The runtime should do the routing work or coach the sender toward the next
   viable action. Do not make agents run a long orientation ritual just to
   discover that a target needs a session, a qualifier, or an attach operation.
8. Canonical session addresses use `session:sess.<token>`. The token carries no
   agent, profile, project, harness, model, branch, or node semantics.
9. Harness-native session ids are resolver aliases, not public Scout identity.
   Compatibility inputs may accept them, but receipts should return the opaque
   Scout handle.
10. Starting or observing a session must not create a new agent, actor, profile,
    or mesh directory member. The session mapping is bounded and may expire;
    durable attribution and work belong to their referenced domain records.

## Broker Coaching

Scout should lean on the runtime, not the sender, to explain runtime and routing
state. The product assumes abundant local cognitive capacity; spending extra
reasoning in the runtime is preferable to making every user or agent rediscover
topology by hand.

When a sender tries a reasonable capability command such as:

```bash
scout ask --project ../talkie --harness codex "Review this."
```

the runtime should infer the likely intent, inspect identity/session/endpoint
state, and return one of:

- accepted receipt with ids and the active endpoint/session
- accepted receipt plus wake/start/attach progress
- dispatch result with candidates and a recommended fully qualified target
- lifecycle failure with the failed layer, reason, and exact remediation command

Avoid sender-hostile errors such as "could not find target" when Scout has
enough context to say something more useful. Prefer:

```plaintext
No active Codex session is attached to codex-hudai.
I found a Claude session for the same project: relay-hudson-claude.
Start a compatible session:
  scout session start --agent codex-hudai --harness codex
```

The sender may still use `who`, `latest`, or `session inspect` for debugging,
but those should be follow-up tools, not required preflights for ordinary agent
communication.

## Published models and harness readiness

Scout's versioned runtime catalog controls enabled model names, labels, ordering
and reasoning levels. The runtime reads the published JSON at
`https://openscout.app/.well-known/runtime-catalog.v1.json` at most once per day
by default. It saves the catalog, last check time and ETag, so restarting the
broker does not trigger another normal request within that day. A failed check
also saves its attempt time and warning while keeping the last valid contents.
If no saved data exists, the bundled catalog is available offline.

Model controls offer **Refresh models** for an explicit check inside that daily
interval. The runtime's `GET /v1/runtime-catalog?force=true` route coalesces
concurrent refreshes and uses the saved ETag for conditional requests. The
snapshot reports its source, revision, last check and refresh warnings. A
published data update can enable a new model or change its reasoning levels
without a Scout app or package update. Provider documentation may inform
reviewed catalog updates; it does not directly enable choices.

Installed adapters check that the selected harness can launch. Local Codex
`model/list` or configuration reads do not filter Scout's published choices or
preflight an ordinary submission. Actual app-server errors are returned as
reported by the server. A catalog choice is not proof of successful inference;
a completed task remains the end-to-end check.

Default leaves both model and reasoning effort unset, allowing the harness to
use its own configuration. Explicit choices retain the requested model and
level. An existing task's named or continuation context is preserved, including
when a choice later disappears from the new-task menu. Saved presets and
successful-choice history remain stored; new-task menus filter them against
current enabled data without deleting the user's preferences. A successful task
records the runtime submitted for that task even if the catalog changes while
it runs. Refreshing models keeps the composer draft.

## Endpoint State

Endpoint state is the runtime's best current view of a routable attachment. Keep
flight state separate from endpoint state: an endpoint can be `idle` while a
particular flight is `waiting`, or `waking` while multiple queued flights are
pending.

| State | Meaning |
| --- | --- |
| `registered` | identity and endpoint metadata exist, but no live session is attached |
| `attaching` | Scout is binding an endpoint to an existing compatible session |
| `waking` | Scout is starting or resuming a compatible harness session |
| `idle` | attached session is reachable and ready for work |
| `working` | attached session has claimed at least one active flight or work item |
| `unreachable` | endpoint is known, but the runtime cannot currently contact it |
| `failed` | endpoint setup or wake failed with a recorded reason |
| `superseded` | endpoint row was replaced by a newer registration or route and should only appear in diagnostics |
| `stopped` | endpoint was intentionally detached or stopped |

Allowed transitions should be explicit in protocol/runtime code. The expected
happy path is `registered -> waking -> idle -> working -> idle`. Failure paths
should preserve the failed layer and remediation, for example `waking -> failed`
with `reason: "harness_mismatch"`.

## Cardinality And Selection

One agent identity may have multiple sessions over time and may have multiple
endpoints when different harnesses, transports, machines, or worktrees are
valid. The runtime must not make the sender guess which one matters.

Routing selection should prefer:

1. exact agent id plus exact harness/session requested by the command
2. the preferred endpoint for that agent/harness pair
3. the most recent reachable compatible endpoint
4. a dispatch result that lists candidates and the recommended fully qualified
   retry

If more than one compatible endpoint is active and none is preferred, the result
is ambiguous, not silently random.

## Session Persistence

Session records survive broker restarts as coordination metadata, but that does
not mean the underlying harness is still alive.

- `resumable`: provider metadata says Scout can reattach or resume
- `reachability_unknown`: a prior session exists but the runtime has not
  confirmed it is reachable
- `not_attachable`: the session reference cannot be loaded, parsed, or matched
  to a compatible harness/profile
- `terminal`: the harness or provider explicitly reported stopped, closed,
  cancelled, completed, or another terminal state

After restart, Scout should mark uncertain sessions as `reachability_unknown`
until an endpoint health check, attach, or wake operation confirms reachability.
User-facing copy should render that as "session not currently reachable"; failed
attach resolution should render as "session reference not attachable".

For ACP transports, keep the Scout runtime session id separate from the
provider-native ACP session id. A live endpoint retains one ACP client and
serializes its turns. After process loss or broker restart, a new binary must
use the provider id with `session/resume` or `session/load`. If the agent cannot
resume or load that exact context, fail the existing-session request rather than
silently calling `session/new`.

## Token And Coordination Accounting

Scout should track the cost of coordination, not just the state of coordination.
This is not billing infrastructure, enterprise metering, or a user-facing
scoreboard. It is developer-facing product telemetry for local environments: what did
running through the Scout protocol add, and did that protocol overhead reduce
total cognitive work elsewhere?

Separate two ledgers:

- **Protocol overhead:** tokens Scout consumes or generates to route, wrap,
  diagnose, summarize, annotate, wake, attach, or coach around the core task.
- **Harness execution:** tokens spent by Claude, Codex, or another model doing
  the actual delegated work.

This section is primarily about protocol overhead. Harness execution usage is
useful context, but it should not be blended into the cost of the Scout protocol
itself.

Minimum useful accounting:

- prompt, completion, and total tokens for Scout-authored protocol prompts,
  wrappers, diagnostics, and summaries when a harness exposes them
- estimated tokens when exact usage is unavailable, with `usageSource` such as
  `provider_exact`, `tokenizer_estimate`, `char_heuristic`, or `manual_estimate`
- model and harness for each counted turn
- value class for protocol overhead:
  - `boilerplate`: repeated identity, topology, or command-discovery text
  - `routing`: target resolution, dispatch, delivery, and receipt wrapping
  - `diagnostic`: explaining failed or incomplete broker/runtime state
  - `onboarding`: teaching an agent a new Scout capability or contract
  - `feature_guidance`: coaching toward a better command or workflow
  - `work_context`: useful task context carried by Scout around the request,
    excluding the target harness's own execution tokens
- broker-side diagnostic effort, including non-token counters such as
  `diagnosticGenerated`, `dispatchAttemptCount`, `wakeFailureCount`, and
  `orientationCommandsAvoidedEstimate`
- avoided retry/orientation loops when the runtime directly resolves or coaches
  a sender
- ids linking usage to `sessionId`, `endpointId`, `conversationId`,
  `messageId`, `invocationId`, `flightId`, and `workId`

The goal is trend visibility, not per-message guilt or end-user interpretation.
Internal reports should answer questions like:

- how many tokens did the Scout protocol add before the target harness began the
  real work?
- how many tokens did Scout generate in receipts, routing context, reply
  context, diagnostic text, and status summaries?
- are low-value boilerplate tokens trending down?
- are high-value guidance tokens, such as agent onboarding and feature coaching,
  replacing repeated orientation chatter?
- did broker coaching reduce repeated `who` / `latest` / `ps` loops?
- which agents or sessions are spending the most context on coordination?
- where do harness wake failures create expensive human or agent retries?
- when is a smarter broker response cheaper than sender-side rediscovery?

Accounting records should stay lightweight, mostly internal, and runtime-owned.
Do not bulk-import full harness transcripts to compute them; store usage
numbers, estimates, references, summaries, and a source label such as `protocol_overhead` or
`harness_execution`.

The optimization target is not "fewer tokens everywhere." It is better token
mix: fewer low-value tokens spent on repeated identity checks, topology
discovery, card instructions, and command rediscovery; more high-value tokens
spent on onboarding agents, explaining new features, preserving useful context,
and coaching recovery from real state transitions.

## Session Operations

These are the semantics Scout should expose consistently across CLI, MCP, UI,
and skills. Command names may evolve, but the behavior should not be ambiguous.

| Operation | Meaning |
| --- | --- |
| `session start` | Create a new concrete harness session for an agent |
| `session intake` | Materialize an existing harness session through a local terminal backend |
| `session attach` | Attach an agent endpoint to an existing harness session |
| `session list` | Show known sessions and endpoint attachments |
| `search index` / `search query` | Explicit FTS over observed harness transcripts (see [session-search.md](./session-search.md)) |
| `session stop` | Stop or detach a concrete session |
| `session inspect` | Explain the agent/session/endpoint state and last error |

Expected CLI shape:

```bash
scout session start --agent hudson --harness codex
scout session intake --harness codex --session <id> --project .
scout session attach --agent hudson --harness codex --session <id>
scout session inspect --agent hudson --harness codex
```

`session intake` is the local handoff helper: it turns a harness-native session id
into an attachable local runtime surface. The stable input is the harness, session
id, and resume cwd; the terminal backend is disposable. A user should be able to
materialize the same harness session through tmux, Zellij, SSH, or a later
host-control protocol without changing the session identity. It does not by
itself claim broker ownership of the endpoint; `session attach` is the operation
that binds an agent endpoint to a session record.

`scout up` may remain as a friendly alias, but internally it must resolve to a
session operation and print exactly what it did.

## Card Semantics

`scout card create` is an identity and return-address operation.

It should answer:

- what agent identity was created or reused
- what project/worktree it points at
- what harness profile is configured
- whether a compatible session is already attached
- how to start or attach a session if none exists

It should not silently bind `--harness codex` to a Claude session. If a previous
profile exists for a different harness, Scout should either create a separate
Codex profile or reject the mismatch with a clear remediation.

Some cards are intentionally disposable. Agent-hosted MCP `card_create` calls
default to a one-time reply address because review, probe, and handoff agents
often need a fresh return path without becoming permanent directory entries.
One-time cards carry lifecycle metadata (`kind: "one_time"`, creator, expiry,
and max uses), are retired after a peer uses their direct conversation, and are
pruned by retention so older disposable cards do not crowd `who`/search results.
Manual CLI cards remain persistent unless created with `scout card create
--one-time`; `scout card cleanup` retires expired or overflow one-time cards.
When a caller asks a concrete `projectPath`, the runtime resolves the durable
project/agent/profile data and creates only the execution state it needs. A new
harness context gets a session mapping and endpoint lease, not a one-time agent
identity. Legacy one-time/session-shaped cards remain readable during migration
and are pruned by retention.

When a CLI or MCP ask provides only execution preferences, such as
`--harness codex` or `session: "new"`, Scout treats the current directory as the
project target and requests a fresh session for that durable project/profile.
This keeps "run this repo in a fresh compatible worker" cheap without forcing
the caller to pre-create or choose an execution identity.

For a different repo, callers should provide `projectPath` / `--project` plus
optional `harness` / `--harness`. This is a capability request, not an identity
request: the runtime chooses or creates a compatible worker, returns durable
handles (`ref`, `flightId`, `conversationId`, `workId`, `sessionId`), and may
return a situated target handle. Follow-up uses those handles; a persistent
name/pin is an explicit promotion after the worker is known good.

When the runtime exposes a friendly situated target, the human-typed form is
`target:<handle>`. Agent-authored prompts and compact UI may render the same
handle as `⌖handle`. Use this for "get back to that useful situation" shorthand.
Use `session:sess.<token>` for exact harness continuation. Legacy
`session:<native-id>` and `session:<harness>:<native-id>` inputs are accepted by
the compatibility resolver but are not canonical addresses.

## Session Addresses

Every session the runtime knows has an automatically derived, copyable address:

```text
sess.<token>@<host>
```

- The local part is the canonical broker handle for the exact harness
  conversation. It is opaque, so the address carries no agent, profile,
  project, or harness semantics.
- The host is the stable qualifier of the runtime authority that owns the
  session: the node id minus its mesh suffix (`build-host-scout` →
  `build-host`). It is never an IP address or a DHCP/mDNS-drifting hostname. A
  host also matches the node's id, name, or host name, so `build-host` and
  `build-host.local` name the same machine.
- Nothing is registered to get one. No card, alias, or setup step exists for
  addresses; they are computed from the session mapping the runtime already
  holds.

Discover and use one:

```bash
scout session address                  # this session's own address
scout session address <selector>       # a handle, native id, actor id, or address
scout session address --all            # known live/resumable sessions
scout ask --to sess.<token>@<host> "..."
```

`session:sess.<token>@<host>` is the typed form. A bare `sess.<token>@<host>`
works anywhere a route target does: CLI `--to`, the composer `>>` operator, and
MCP `ask` `to` or `targetSessionId`. `session:sess.<token>` without a host and
every legacy selector keep their meaning. A host is parsed only after a
canonical `sess.*` handle, so a native id containing `@` is unchanged.

Routing is an exact-session route scoped to the host:

- The host bounds resolution. A same-token projection on another machine never
  satisfies the address.
- A session on this runtime resolves as described in
  [Ask Targets And Reply Sessions](#ask-targets-and-reply-sessions), including
  the exact-session wake for a resumable session.
- A remote session this runtime has a projection of resolves to that host's
  endpoint, and dispatch forwards to its authority node.
- Failures are reported with `sessionWakeReason` on the dispatch record and
  never fall back to a fresh session:
  - `session_host_unknown`: no mesh node answers to the host.
  - `session_not_on_host`: the session exists, but on a different host (the
    detail names it).
  - `session_host_not_projected`: the host is a known peer that has not shared
    the session with this runtime. The local harness store is not searched.

Addressability is separate from reachability. `scout session address` reports
each address with one of:

- `live`: an attached endpoint is online.
- `resumable`: the session is offline but carries a harness-native id, so an
  ask triggers the exact-session wake. The wake can still fail, and Scout
  reports that failure instead of starting a new session.
- `unavailable`: the session has ended or been superseded, or has nothing to
  resume.

Reply continuity uses the same address:

- Delivery receipts carry `targetSessionAddress` when the target resolves to
  exactly one canonical session. Pass it back as the target to keep building
  in that conversation.
- Return addresses carry `sessionAddress` for the requester's exact session:
  either the explicit `replyToSessionId`, or the session the return address
  already names. It is omitted, not guessed, when that session is ambiguous or
  unknown.

Route aliases are unchanged and remain a separate, optional layer: an address
needs no alias. `scout alias set <name> --to session:sess.<token>` still pins an
exact session, but alias targets do not accept the `@<host>` form yet. Role or
harness addresses on a host and explicit group fan-out are not part of the
address grammar and must never be inferred from it.

### Current Limits

- Cross-host resolution works only for sessions the peer has projected to this
  broker. Most sessions are not projected today, so a remote address usually
  returns `session_host_not_projected`. The next step is to forward
  unprojected resolution to the host's authority broker. The route-alias
  forwarder (`/v1/mesh/aliases/resolve`) is the model to follow.
- Offline retry and delivery policy are unchanged.

## Route Alias Lifetime

`scout alias set <name> --to <agent>` creates a durable route pointer with
fresh-work agent semantics. `--to session:<id>` creates a durable record whose
route is live-bound to that exact endpoint/session and therefore has existing-
session semantics. It never floats to a replacement session for the same agent.

Session-target aliases expire when the exact session is terminal or leaves the
broker's runtime-session retention boundary; configured expiry may shorten but
not extend that lifetime. Temporary unreachability is reported without
substitution. Unset and expired bindings remain available to authorized history
reads, and repointing never changes prior accepted work.

## Ask Targets And Reply Sessions

An ask has two different routes:

- the work target, which is an exact session target or an agent/project target
  that can create a fresh session
- the return target, which may be a concrete requester `sessionId`

Use `targetSessionId` when the sender wants to keep building context in one
existing harness session over many turns. Repeating the session id means
"continue here"; omitting it means Scout may route by agent/project and create
the lightest usable fresh session for the request.

The canonical session id is broker-minted and opaque. Scout resolves
`targetSessionId` / `session:sess.<token>` through the session mapping to the
endpoint and harness-native context. Compatibility inputs may supply endpoint
ids, `externalSessionId`, native harness thread ids, and adapter-provided
aliases; the runtime resolves those to the canonical handle before returning a
receipt. When no live endpoint exists, Scout may use the mapping's native alias
to locate the context in the harness session store (for example
`~/.codex/sessions`) and wake a flat-dispatch endpoint that resumes that exact
thread. Scout must fail closed on unknown, expired, cwd-conflicting,
unresumable, or wake-failed exact-session references; it must not silently
reinterpret them as fresh project or agent routing.

Agent cards and labels are fresh-session targets by default. A card carries
identity, harness/profile/model hints, project root, and return-address
metadata; it does not mean "reuse whatever thread was last attached." Scout
should consult session reachability diagnostics only when the request names an exact
`targetSessionId`/`session:<id>` and that session cannot be reached.

A Scout-provisioned session cannot report observed runtime before its first
invocation executes — the harness process has not attached yet. During that
narrow pending-launch window (currently two minutes), the runtime trusts the
exact harness/model/effort it just provisioned on the session's own endpoint,
so a fresh profile or exact-runtime ask can reach execution instead of failing
`session_runtime_unobserved` on a verification that is impossible by
construction. The trust applies only to endpoints the runtime itself registered
(`scout-cardless-session` / `scout-isolated-agent-session` sources), only to
the endpoint matching the requested session, and only inside the window — a
conflicting request fails `session_runtime_mismatch` on the provisioned
values, and once the grace expires or the provider attaches, observed runtime
is again the only authority.

`session: "new"` may also target an existing agent card. In that shape, the card
supplies the identity, project, harness profile, and return-address metadata;
the session policy says the work should enter fresh target context instead of
continuing a concrete prior session for that card. Project routing creates a
new session mapping beneath the durable project/agent/profile data, never a new
identity merely to name the execution.

Use exact `agentId` only when the sender knows the intended owner. Use project
routing plus optional harness/capability when the sender knows the codebase but
not the concrete worker. That path should stay cheap and throwaway: Scout can
create or choose an ephemeral session/card as needed, and the sender does not
need to ask for a new session explicitly or invent a generic agent name.

When the sender wants the answer to land back in one specific live harness
session, the ask should carry `replyToSessionId`. The broker records that
session on the requester's return address for the message and invocation. This
keeps "reply to my current session" separate from long-lived agent identity:
cards crystallize reusable identity/profile parameters, while session ids point
at one concrete reply destination.

### Session Reuse And Forking

Session policy should be explicit because "which worker should do this" and
"which prior context should it inherit" are different questions.

| Policy | Meaning | Session id role |
| --- | --- | --- |
| `new` | Run the work in fresh model context. | No session id required. Existing project agents should not force user-visible ambiguity. |
| `reuse` | Prefer a compatible warm session as an optimization, but start fresh if none is clearly suitable. | No exact session id required. Legacy `any` maps to this policy. |
| `existing` | Continue one exact session. | `targetSessionId` is the target and must resolve to that session owner. |
| `fork` | Start a new session from an excellent prior state. | `forkFromStateId` is preferred; `forkFromSessionId` means derive a source state from that session. |

The fork case is intentionally different from `existing`. A fork should leave
the source session untouched, create a new execution session, and carry only an
excellent session state: goal, decisions, constraints, evidence, relevant
files, and next move. If the harness has a native thread-fork primitive, Scout
can use it. If not, Scout can synthesize a compact handoff from runtime-owned
records and observed harness material, with the same data-ownership boundary as
ordinary session observation. It should not bulk import the source transcript
into Scout messages.

Use `clone` for the implementation mechanism that copies a harness-native
thread or state. Use `fork` for the Scout routing policy that creates a new
execution session from prior state. A fork may be implemented by native clone or
by a synthesized Scout handoff.

The strongest fork sources are curated base states: a small set of carefully
constructed states that stay useful for recurring work. These should appear
ahead of raw sessions when choosing what to fork from.

Proposed request shape:

```ts
execution: {
  session: "fork",
  forkFromStateId: "state-session-abc123-review-ready",
  // or forkFromSessionId: "session-source-abc123"
  forkContext: {
    includeBrokerRecords: true,
    includeObservedHarnessMaterial: true
  }
}
```

The work target should still be provided by `projectPath`, `agentId`, or an
explicit target label unless the fork source is deliberately meant to imply the
same project and agent profile. This keeps project routing as the work
primitive, while the fork source is only a continuity input.

## Message And Work Semantics

The old "tell means no reply needed" wording is too weak for agent experience.
Agents need two separate signals: a broker receipt that proves Scout accepted
and recorded the interaction, and a target-authored acknowledgement that the
receiving agent has started working.

Use this model instead:

| Interaction | Use When | Required Result |
| --- | --- | --- |
| Message | Status, update, note, or channel post | Broker receipt with ids |
| Invocation | Question, review, investigation, or owned work | Broker receipt plus flight ids, then target acknowledgement and later completion in the same conversation |
| Work item | Durable multi-step ownership | Work id plus progress states |

The CLI verbs can remain `send` and `ask` for compatibility, but docs and
skills should teach them as:

- `send`: post a message and return a durable receipt
- `ask`: create an invocation, return a durable receipt plus lifecycle state, and let the target acknowledge quickly before final completion

No route should depend on fire-and-forget behavior. Even a channel post should
have a receipt.

## Wake And Delivery

When a known on-demand agent has no active compatible session:

1. The broker records the message or invocation.
2. The runtime resolves the requested harness/profile.
3. If wake policy allows, Scout starts or attaches a compatible session.
4. The endpoint transitions through `waking` to `idle` or `working`.
5. Queued flights for that agent/session compatibility drain automatically.

If any step fails, the flight must move to `failed` or a clearly explainable
`waiting` state. The error should name the failed layer:

```plaintext
codex-hudai is registered, but has no active codex session.
Wake policy: on_demand.
Start failed: configured profile points at Claude session relay-hudson-claude.
Run: scout session start --agent codex-hudai --harness codex
```

## Agent-Facing Defaults

Agents should not have to reason about the entire runtime graph for ordinary
coordination. The happy path stays small:

```bash
scout ask --to hudson "Review this and report back."
scout ask --to hudson --fyi "Heads up: I am taking the runtime side."
scout ask --to hudson "Run the longer review and report back."
scout who
scout latest
```

Use Send only when no reply, judgment, investigation, or owned work is
expected. If work should happen asynchronously, keep it as an Ask and use
`--notify`; do not turn it into Send merely to avoid blocking.

Reply mode is separate from session placement. Background is the default for
new Scout-routed sessions. Preserve foreground as an explicit requirement when
the operator wants the task visible/openable in the destination harness UI so
they can watch or chime in. Foreground placement does not itself open or focus
that UI, and unsupported foreground placement must not silently fall back to
background.

When those commands fail, the failure must expose enough session detail that an
agent can recover without guessing or asking the human to manually relaunch a
known target.

## Compatibility Target

Future CLI, MCP, and skill updates should converge on these names:

| Concept | CLI | MCP / API |
| --- | --- | --- |
| Start a session | `scout session start ...` | `sessions_start` |
| Attach a session | `scout session attach ...` | `sessions_attach` |
| Inspect runtime state | `scout session inspect ...` | `sessions_inspect` |
| Message receipt | `scout ask --fyi ...` | `ask` with `fyi: true` |
| Ask receipt | `scout ask ...` | `ask` |

Old commands should continue to work while emitting behavior that maps cleanly
onto these semantics.

## External session attachment

The runtime's `sessions_attach` MCP primitive binds an explicitly selected native
session to a durable, exact-session mailbox using the existing MCP connection.
It reuses endpoints and a single integration actor, creates no per-session agent,
and returns the same opaque handle on repeated attachment. `sessions_poll`,
`sessions_ack`, and `reply` distinguish receipt from completed work.
An explicit `replyToSessionId` routes the result back to the originating mailbox.
Polling does not wake a suspended host. An optional configured Devin API transport
can resume a suspended Devin session.
