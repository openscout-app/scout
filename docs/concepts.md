# Concepts

Scout's vocabulary splits in two. Some nouns are concepts Scout brings to the
table: its own model of coordination, kept because each one expresses a real
difference in behavior that a generic term would blur. Others are concepts
where Scout deliberately maps to an existing open protocol — A2A, ACP, or MCP —
reusing the outside term when the meaning is genuinely close so integrators do
not have to learn a second name for the same thing. Those two lists are this
document.

This page is the canonical reference for what each noun means. It is not where
you learn the system's shape or how work flows:

- [`architecture.md`](./architecture.md) holds the system shape, the address
  grammar, and the data-ownership story.
- [`agents-and-collaboration.md`](./agents-and-collaboration.md) holds the
  workflow semantics — how questions, work items, and delegation actually play
  out over a conversation.

This page defines what each term denotes so the other two can use them without
redefining them.

Where a concept has a concrete protocol type behind it, the type name is given
in parentheses. Those shapes live in `packages/protocol/src`; the record
inventory is in [`scout-comms.md`](./scout-comms.md).

## What Scout Brings

These are Scout's native concepts. Each earns its own name because a borrowed
term would hide a distinction Scout depends on.

### The System

**Broker.** The runtime is the local canonical writer for routing, durable
state, and event streams. It is the single load-bearing choice the rest of the
model follows from: because one local daemon owns the coordination records,
every other concept here can be defined as "a record the runtime writes" or "a
request the runtime resolves" rather than as a wire format that many parties
must agree on. There is one broker per machine; agents post messages and
invocations to it, and it resolves targets, writes records, plans delivery, and
tracks work. See [`architecture.md`](./architecture.md) for how it sits in the
process tree.

**Runtime.** The runtime is the layer that starts, resumes, stops, and
health-checks sessions across harnesses. Where the runtime owns coordination
records, the runtime owns process lifecycle: system-prompt generation, tmux
sessions, transport adapters, and the file-based agent override registry. It is
what makes "wake the agent" a real operation instead of an assumption.

**Harness.** A harness is the execution backend for a session — Claude Code,
Codex, pi, or anything else that can run an agent and speak the protocol. Scout
is deliberately multi-harness: it does not assume one backend, and a harness is
just the agent runner plus its transport wrapper. The agent itself may live
outside Scout entirely; the harness is only how a given session is executed.

**Host Integration.** A host integration is first-class compatibility with an
outside agent tool, IDE, terminal host, or agent-state surface. Some host
integrations are also harnesses because Scout can execute sessions through them.
Others are not: Hermes can host Scout tools through plugin and MCP surfaces,
while Herdr can expose terminal panes and agent state around Scout-compatible
sessions. Treat host integration as the umbrella and harness as the execution
backend subset.

**Protocol.** The protocol is the shared grammar every surface, host
integration, and harness speaks: the TypeScript shapes for identities,
messages, invocations, flights, conversations, delivery, reply context, and
collaboration records. Anything that crosses a boundary — between agents,
harnesses, or machines — is described here. Human and agent surfaces use one
interaction model. The current protocol expresses that model; its wire format
and transports can change while preserving authority, continuity, and lifecycle
meaning.

**Mesh.** Mesh is how agents on different machines reach and coordinate with
each other. Each runtime advertises its local agents to peers and syncs endpoint
tables, so an address on another node resolves and messages forward to the
authority broker that owns the agent. Mesh means reachability and coordination
— not global consensus, not exactly-once delivery, and not replicated storage
of external transcripts. That honesty is deliberate: Scout is a coordination
substrate for high-trust local environments, so mesh is kept to what it can actually
guarantee.

**Surface.** A surface is any view into runtime state: the CLI, terminal UI,
a harness plugin, or a separate Mac, iOS, Android, or web app. Surfaces read
and write through the runtime; none of them own agent state. The distinction
matters because it keeps the source of truth in one place — a surface can be
stale, wrong, or absent without the coordination record being any of those.

### Identity And Runtime

**Agent.** An agent is a durable, addressable target that Scout can route to.
It may be defined outside Scout: what Scout owns is the local routing, binding,
session, and coordination state around it, not necessarily its definition. An
agent is a stable identity, distinct from any one running session — the
identity persists across restarts, harness changes, and machines.

**Base Agent And Execution Resolution.** The base agent is durable domain data
for the project/workspace. Profile, harness, model, node, endpoint, and session
are inputs or outputs of routing; they do not create another agent identity.
The full address grammar lives in [`architecture.md`](./architecture.md). The
routing consequence is that callers target the durable agent/project/profile
and only add execution constraints when the capability matters.

**Session.** A session is an opaque broker handle (`sess.*`) that resolves to one
concrete harness conversation, process, or thread. It is a short-URL-style
pointer, not an identity or directory member. The mapping links to the durable
project/agent/profile/runtime data plus current endpoint state and may expire
after the context is terminal. Native harness session ids remain resolver
aliases. Commands that start or attach a harness use "session" as their public
noun and fail loudly when a requested context cannot be resolved.

**RuntimeSpec.** A RuntimeSpec is an exact launch selector with fixed-position
grammar `<harness>[/<model>[/<effort>]]`, such as
`codex/gpt-5.6-sol/xhigh`. It is not an agent identity, alias, or session id.
Profiles provide base values and explicit dimensions override them when the
resulting tuple is legal. Exact runtime selection implies a fresh isolated
session; exact continuation of `session:<id>` requires matching observed
runtime evidence.

**Execution Resolution.** An execution resolution is the durable truth record
for one requested runtime. For harness, model, and effort it keeps the caller's
requested value, the launch ladder's resolved value and source, and the value
later observed from the harness. Drift is match, mismatch, or unknown. A launch
argument is resolved intent, not evidence that the harness accepted it.

**Route Alias.** A route alias is runtime-owned mutable routing state pointing
to one canonical durable agent id or one exact broker-known session. It is not
an identity, card, actor, endpoint, or session. The scope key is owner realm +
project + node + normalized name; every accepted dispatch pins the binding
revision and canonical target so later repoints do not rewrite history.

**Assigned Role.** An assigned role is an explicit, durable duty granted to an
agent for a mission, agent, or project scope. It is not an `agentClass`, harness,
rank, or identity attribute: it says what the agent has been asked to do in that
scope. The first catalog role is **orchestrator**, which owns a long-running
mission spine and can keep its mission log current. An assignment is a seat on
the durable agent, so it survives a process death while its backing sessions are
disposable. Prefer starting a fresh session and re-steering it through the
durable agent/mission context; use `session:<id>` only when the exact prior
harness context is required.

**Endpoint.** An endpoint attaches an agent identity to one reachable session,
on a given transport and node. It is the join between the durable target and the
concrete runtime — the record that says "this agent is currently reachable this
way." When an endpoint goes offline the agent still exists; only its reachability
changed.

**Scout Address.** A Scout address is the canonical routing address for an agent
target, carrying qualifiers such as workspace, harness, and node when they are
needed to disambiguate. It is richer than a bare handle because one project can
resolve to many concrete instances. The grammar itself — how the parts compose
and when a qualifier is required — is owned by [`architecture.md`](./architecture.md);
this page only names the concept.

**ScoutAgentCard.** A `ScoutAgentCard` is Scout's local discovery card for one
addressable agent target. It is the place discovery-oriented information should
converge: provider, skills, interface hints, documentation links, and security
hints. Route state does not belong on it — that lives on endpoints and
diagnostics. It overlaps intentionally with A2A's `AgentCard` but is not the
A2A wire shape; the A2A projection is derived from it.

**Card (the return-address record).** Separately, Scout's integration tooling
uses a lowercase "card" to mean a reply-ready identity and return-address
record — the thing `card_create` produces so an agent can be replied to. This
is not the same object as a `ScoutAgentCard`: one is a discovery card, the other
is a routing return-address. The two genuinely share the word "card" today,
which trips readers; when it matters, say `ScoutAgentCard` for the discovery
card and "return-address card" for the `card_create` record. Creating either is
a pro concern — core agents send and reply, and let the runtime bind cards
internally.

**@scoutbot.** `@scoutbot` is the conversational assistant handle — the identity
the human operator talks to. It is distinct from platform Scout: the product,
runtime, CLI, and protocol are Scout, while `@scoutbot` is the
routeable assistant that appears in mentions, chips, and broker logs. Friendly
UI may call the assistant "Scout," but use `@scoutbot` when routing or
disambiguating it from the platform.

### Communication

**Chat And Conversation.** Chat is the user-facing noun for the durable place
messages live — a DM, channel, group DM, thread, or system lane. Internally the
broker and protocol store that place as a Conversation
(`ConversationDefinition`), addressed by an opaque Chat ID. Chat is
communication continuity and nothing else: it must not collapse into session
(runtime continuity), workspace path (context continuity), or work. Keep those axes
apart.

**Message.** A message (`MessageRecord`) is a durable communicative turn: one
body posted by one actor into one conversation. It carries payload, not routing
— the target is an explicit field, and body text such as "@hudson" is not
treated as an instruction to route. A message belongs to exactly one Chat and
may reply to another message.

**Delivery.** A delivery (`DeliveryIntent`) is a planned, transport-specific
fan-out of a message or invocation. It is separate from the message because one
message may need to reach several endpoints across transports and nodes, each
with its own state. A delivery receipt means the runtime accepted and journaled
the request — not that the target read it or finished the work.

**Binding.** Scout uses binding for two join records, both runtime-owned. A
project binding maps a project path and branch to an addressable agent target —
it is what `scout up` creates or refreshes so a workspace resolves to an agent.
A conversation binding (`ConversationBinding`) maps a Scout conversation to an
external thread or channel — a provider room, a Telegram thread — the
integration seam that lets Scout-owned records stay canonical while mirroring
into systems Scout does not own. Context usually disambiguates; when it does
not, say project binding or conversation binding.

**Reply Context.** A reply context (`ScoutReplyContext`) is the active return
path when a harness is answering an inbound broker ask. It tells the harness to
send its final answer back through the original conversation instead of
composing a fresh send, and whether that reply is the final assistant message or
goes through an explicit reply tool. It exists so delegated work lands back
where it was requested rather than in a disconnected new thread.

**Dispatch Record.** A dispatch record (`ScoutDispatchRecord`) is the routing
diagnostic the runtime writes when a target is ambiguous, unknown, unparseable,
or unavailable. Rather than a bare "not found," it can carry candidates and
wake, register, or retry guidance. It exists so a client can render a useful
next step instead of guessing.

**Quiet Delivery.** Quiet delivery is an optional modifier on a message or
reply, not a separate primitive. It still writes the durable conversation record
but suppresses notify and wake side effects where the target policy allows. It
applies to messages and replies only — `ask` never gets a quiet variant, because
asking creates ownership and lifecycle that should not arrive silently.

### Work

**Invocation And Flight.** Invocation and flight are a deliberate pair rather
than one overloaded "task." An invocation (`InvocationRequest`) is the explicit
request for an agent to do something — the intent, captured once. A flight
(`FlightRecord`) is the tracked execution lifecycle of that invocation: queued,
running, waiting, completed, failed, or cancelled. Scout keeps them separate
because the request and its progression are genuinely different things — you
re-read the invocation to know what was asked, and you watch the flight to know
how it is going. An invocation carries exactly one current status, and that
status is the flight: the flight is the invocation's latest lifecycle state, not
a second independent object competing to describe the same work.

**Question.** A question (`QuestionRecord`) is a lightweight, information-seeking
collaboration record. It exists to get an answer, not to hand off owned work —
questions answer information, work items carry ownership. Keeping it distinct
from a work item avoids inflating a quick "which branch?" into something with
review and done states.

**Work Item.** A work item (`WorkItemRecord`) is a durable, owned execution
record with progress, waiting, review, and done states. Use it when an
interaction needs ownership, milestones, or a review gate — anything more than a
single ask can hold. It is richer than a base task noun precisely because Scout
wants owned, resumable work to be first-class rather than implied by a
long-running message.

**Mission And Mission Log.** A mission is the long-running campaign root for
coordinated work; in v0 its id is a work-item id. A mission log is that mission's
cheap append-only situation stream, with short structured `intent`, `status`,
and `kind` fields plus optional checkpoint, blockers, and drill-down references.
It is not chat, a replacement for work-item progress, or a harness transcript:
keep the detailed evidence in the relevant DM, work record, or observed harness
material. The anti-spam rule is strict: no active assignment whose role permits
`mission_log.append` means no mission-log write. The built-in orchestrator role
has that permission; ordinary workers do not acquire it by being busy or verbose.

**Acceptance.** Acceptance is the requester's judgment that a result is actually
done — a separate signal from broker acceptance, peer acknowledgement, and agent
completion. It matters because "the broker journaled it" and "the agent says it
finished" are not the same as "the person who asked is satisfied." How
acceptance interacts with work-item states lives in
[`agents-and-collaboration.md`](./agents-and-collaboration.md); the layered
delivery and receipt states are in [`scout-comms.md`](./scout-comms.md).

**Ownership And Next-Move.** At any point in a collaboration, exactly one party
should own the next step — the decision of what happens now. Scout treats this
ownership as a real part of the model rather than leaving it implicit in who
spoke last. The rules for how the next-move baton passes live in
[`agents-and-collaboration.md`](./agents-and-collaboration.md).

**Artifact.** An artifact is a durable published output, linked back to the work
and execution that produced it where possible. Today text output maps cleanly to
artifacts; richer file and data artifacts are typed but not yet fully persisted.
It is the thing you keep after the flight lands — the result, distinct from the
messages about it.

**Helper.** A helper is a session-bound assistant acting on behalf of a person
inside Scout's actor model. It is a Scout-local role, not a required interop
concept: it lets Scout attribute actions to a person's helper in a given session
without promoting that assistant to a durable standalone agent.

## What Maps To Open Protocols

Where Scout touches the outside world, it reuses established vocabulary on
purpose. These are the deliberate alignments.

### A2A

Scout uses A2A (the Agent2Agent protocol) as its main external interoperability
reference point. The positions are distinct: **Scout is a local-first
coordination substrate; A2A is an interoperability protocol.** Scout keeps its
own internal mechanics — runtime-owned routing, the invocation/flight pair,
first-class questions and work items, explicit delivery and bindings — and
overlaps with A2A only in discovery-oriented vocabulary where the concepts are
genuinely close: provider metadata, skills, interfaces, security hints, and
artifacts as durable outputs.

At the boundary today, the runtime exposes concrete A2A primitives:

- agent-card intake for external A2A-style cards, and agent-card serving for the
  local runtime and per-agent routes
- JSON-RPC `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, and
  `GetExtendedAgentCard`, plus legacy slash-method compatibility such as
  `message/send`
- projection of Scout flight lifecycle state into A2A tasks

The term mapping:

| A2A Term | Scout Term | Note |
|---|---|---|
| `AgentCard` | `ScoutAgentCard` | Same discovery role. Scout's card also carries local routing/runtime hints; the A2A endpoint projects it to the wire shape. |
| `Message` | `MessageRecord` / `InvocationRequest.task` | Inbound A2A text messages become Scout invocations for work-style requests. |
| `Task` | `FlightRecord` | A2A tasks are projected from Scout flight state; the original `InvocationRequest` is kept separately. |
| `Artifact` | `FlightRecord.output` / durable artifacts | Text output maps to A2A text artifacts today; rich artifact persistence is future work. |
| skills / interfaces / auth | fields on `ScoutAgentCard` and its A2A projection | Skills and interfaces are projected; A2A-specific auth policy is not implemented. |

What Scout does **not** claim: that every agent is defined by Scout, that every
agent speaks Scout's protocol, that every boundary is Scout-owned, or that its
internal nouns must be renamed one-for-one to match A2A. It also does not claim
full A2A conformance — streaming, push notifications, authenticated extended
cards, active cancellation of running work, and production security controls are
open.

### ACP

"ACP" collides in current usage. The one Scout implements is the **Agent Client
Protocol**, the JSON-RPC client protocol used by coding-agent hosts: Scout has a
client adapter (`packages/agent-sessions/src/adapters/acp.ts`) that initializes,
creates and loads sessions, sends prompts, receives `session/update`, and
handles permission and controlled file-access hooks. That makes Scout an ACP
client adapter, not an ACP agent server. The other ACP — BeeAI's **Agent
Communication Protocol** — is a separate REST surface that Scout does not
implement; new interoperability work should prefer A2A primitives.

### MCP

Scout's agent-facing tool surface is standard MCP. This is the protocol's front
door for agents: the core tools are `whoami`, `ask`, `reply` and `work_update`, with `invocations_get`, `invocations_wait`,
`broker_feed`, and `tail_events` for observation and `agents_search` /
`agents_resolve` for routing help. Deeper identity and lifecycle tools —
`card_create`, `agents_start`, `session_attach_current` — sit in a pro tier that
most agents never need. The tiering and each tool's contract live in
[`mcp-api-posture.md`](./mcp-api-posture.md).

### AGENTS.md And Harness Conventions

Harness-owned material such as `AGENTS.md` files and external transcripts stays
harness-owned: Scout observes, tails, summarizes, and links lightweight metadata
from it, but never writes it back as if Scout authored it. See
[`architecture.md`](./architecture.md) for the own-coordination,
observe-transcripts boundary.

## Naming Rules

The rules that govern which name wins, merged from Scout's glossary conventions
and its A2A practice:

1. Scout-specific mechanics keep Scout names when they express a real difference
   in model or behavior. The invocation/flight split and first-class work items
   exist because a generic "task" would hide distinctions Scout relies on.
2. Exact protocol terms are reused only when the meaning is intentionally close —
   discovery vocabulary such as provider, skills, and interfaces, where reusing
   the outside word saves integrators a translation.
3. When Scout's model is richer than the protocol's, the docs say so directly
   instead of hiding the distinction behind a borrowed term.
4. On collision, prefer a Scout-qualified name such as `ScoutAgentCard`, keep the
   Scout-native term with an explicit mapping, and reserve the exact protocol
   term for the actual wire shape.
5. `relay` and `pairing` are legacy and compatibility vocabulary — kept for
   continuity, not the preferred canonical names.
