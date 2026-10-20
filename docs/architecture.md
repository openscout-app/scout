# Architecture

This document is the system-level map for OpenScout: what the system is made of, and how it treats data. If you are new, read it as a guide to four things: what the broker is, what the runtime does, what the protocol defines, and which records Scout owns versus observes.

Read this after the repo [`README.md`](../README.md) if you are orienting to the project for the first time. If you want the command-first ramp first, read [`quickstart.md`](./quickstart.md) before this page. For the precise meaning of Scout's core nouns and how they map onto external agent protocols, read [`concepts.md`](./concepts.md). For the question, work-item, and delegation semantics between agents, read [`agents-and-collaboration.md`](./agents-and-collaboration.md). License is Apache-2.0; see the repo [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).

## Working Thesis

Scout is the stable intermediary across agent implementations, with multiple
human and agent interfaces into the same work. Its local-first control plane
coordinates agents across harnesses, machines, and services.

Scout mediates capability discovery and routing, context and authority, work
continuity, attention, and outcomes. A desktop app, web view, phone, CLI, or
external personal agent provides an entrance to the same durable work and
coordination model. Each interface presents the view and actions its participant
is authorized to access; changing interfaces does not create a separate work
history or grant broader permission.

The broker, runtime, and transport implementations support this enduring product
role and may evolve or be replaced as external standards mature. Standardized
communication makes mediation easier to provide; Scout still organizes which
capabilities to use, how work continues, and what needs a person. Preserve
interaction meaning and authority boundaries when replacing machinery.
The [Shared Interaction Model](./interaction-model.md) is the adopted design
contract; its coverage table identifies behavior that remains unimplemented.

Remember these three things:

- **Runtime / broker** (`packages/runtime`): accepts commands, routes messages, and writes Scout-owned coordination records.
- **Protocol** (`packages/protocol`): the shared language for agent identities, records, and requests.
- **Agent sessions** (`packages/agent-sessions`): normalizes harness-owned sessions into observed events, snapshots, approvals, and topology hints.

Scout does not replace Claude Code, Codex, or any other agent tool. It handles discovery, addressing, observation, and coordination around those tools, regardless of which harness runs them or which machine they live on. A harness is the agent runner and transport wrapper for a specific tool. The agent itself may live outside Scout; what Scout owns is the local routing, binding, session, and durable coordination state around that agent.

In practice, the architecture is aiming for three stable outcomes:

- `packages/runtime`: clients and adapters submit commands to the local broker instead of writing Scout-owned records directly
- `packages/protocol`: one shared model for messages, invocations, flights, identities, and collaboration records
- `packages/agent-sessions`: many operator surfaces and harness adapters can observe sessions around that core

Platform Scout is distinct from the conversational assistant handle
`@scoutbot`. The product, broker, CLI, protocol, and coordination model remain
Scout/OpenScout. `@scoutbot` is the routeable assistant identity that may appear
in operator chrome, mentions, chips, and broker logs when the human is talking to
the assistant. Friendly UI may call that assistant Scout, but use `@scoutbot`
where the handle matters.

That framing matters because most of the design choices below are about protecting those boundaries.

## Principles

A small set of constraints shape every design decision.

**Local-first, not cloud-first.** The broker, agent registry, and Scout-owned state live on your machine. Nothing phones home by default. Local files and databases are the source of truth, not a hosted API. The privileged web server is loopback-only by default; a non-loopback bind must be explicitly enabled with `OPENSCOUT_WEB_ALLOW_LAN=1`. Privileged HTTP and WebSocket routes require the per-process web credential in addition to host, origin, and socket-peer checks. Set `OPENSCOUT_WEB_AUTH_TOKEN` when an authenticated LAN client or reverse proxy needs a stable secret; otherwise the server generates an ephemeral credential and issues its HttpOnly session cookie only to direct loopback browser bootstrap requests. Trusted mDNS names and origins are defense-in-depth, never authorization credentials.

**High-trust local pilot, not hardened enterprise perimeter.** Scout assumes trusted local users, trusted local agents, and explicit pairing/mesh choices; it is not yet a multi-tenant, compliance-ready system.

**Observe, don't absorb.** Harnesses own their primary transcripts and logs. Scout observes them through adapters and tail views, then stores links, metadata, and Scout-owned coordination records without importing external turns wholesale. This boundary is central enough to have its own section below; see [The Data Model](#the-data-model).

**Multi-harness.** Agents run wherever they naturally run, with or without Scout. Scout observes and coordinates across those harnesses without assuming one execution backend.

**Multi-machine.** Agents on different machines discover and message each other through mesh forwarding. Pair a phone or a second workstation and the agent graph extends with it.

**File-based configuration.** Agent definitions, overrides, and project bindings are JSON files on disk. No dashboard required.

**Stable mediation, multiple interfaces.** Scout provides one coherent work
model through human and agent interfaces. The protocol package expresses the
shared semantics; adapters connect different implementations. Keep authority,
continuity, and handoffs coherent as implementations change. Each surface reads
and acts on the same authorized work rather than owning competing state.

## Communication Flow

![Scout communication flow](arc:communication-flow)

Agent sessions connect to a single Scout broker over HTTP and SSE. The broker owns the agent registry and routes messages between sessions. Each harness uses its own transport -- `stream-JSON` for Claude Code, `app-server` for Codex -- but the protocol layer above is shared.

A typical exchange looks like this:

```
operator  →  scout send --to codex "review the auth module"
scout cli →  broker /v1/deliver (target intent + message body)
broker    →  resolves codex → endpoint
broker    →  codex session (deliver message via SSE)
codex     →  broker (post reply)
broker    →  operator (deliver reply via SSE)
```

One concrete example: `scout ask --project ../talkie --harness claude "review the auth module"` sends a capability request to the broker. The broker resolves the project/harness constraint to an existing or newly created worker, forwards the request to a compatible session, records the target acknowledgement, and tracks the later completion as a flight. A flight is the broker's tracked record for an ask-style request, including retry, acknowledgement, and completion state. Caller wait budgets may stop a CLI or MCP call from waiting, but they do not cancel or fail the broker flight.

## Core Moving Parts

| Layer | Role | Key detail |
|-------|------|------------|
| **Protocol** | Shared type system and address grammar | Defines the agent identity grammar, message records, invocation requests, flight records, collaboration contracts, and bindings |
| **Broker** | Local message bus and state store | SQLite-backed daemon that owns registration, routing, threading, dispatch, HTTP reads/writes, and SSE updates |
| **Native read projection** | Low-latency local surface reads | Rust journal consumer in `scoutd` that serves bounded, persisted projections over a Unix socket without entering the broker or web request queues |
| **Runtime** | Session and runtime lifecycle management | Starts, resumes, stops, and health-checks sessions across harnesses. Manages tmux sessions, system prompts, and transport adapters |
| **CLI** | Operator interface | `scout up`, `scout send`, `scout ask`, `scout who` -- passes structured route intent to the broker and keeps bootstrap/orientation cheap |
| **Surfaces** | Views into broker state | Desktop, web, iOS, terminal, and pi. They read from the broker; none of them own agent state |

### Protocol

The shared grammar everything speaks. It defines agent identity (the address grammar in [Agent Identity And Addressing](#agent-identity-and-addressing) below), message records, invocation requests, flight tracking, collaboration contracts, and bindings.

Anything that crosses a boundary — between agents, harnesses, or machines — is described here.

### Broker

A single local daemon per machine. Agents and surfaces submit commands to it; it resolves structured targets, routes to endpoints, and records coordination history. They do not write Scout-owned control-plane records directly. It exposes HTTP/SSE for commands, routing, and broker-specific reads. Latency-sensitive presentation reads may consume replayable broker facts through a separate derived projection; that projection never becomes a writer or routing authority.

```bash
# What the broker handles
scout send --to hudson "check the deploy"  # → resolve, route, deliver
scout who                                # → read agent registry
scout watch                              # → SSE stream of all events
```

#### Broker module map

The broker implementation lives in `packages/runtime/src/`. `broker-daemon.ts` is the
process composition root: it wires dependencies, starts TCP/Unix/WebSocket listeners,
and runs background loops. Business workflows live in `broker-*` service modules;
HTTP route dispatch lives in `broker-http-router.ts`.

```text
broker-daemon.ts          composition root (~1.3k lines)
  ├─ broker-process-manager.ts / broker-server-lifecycle.ts
  ├─ broker-durable-store.ts + broker-durable-record-store.ts
  ├─ broker-core-service.ts (read facade + deliver/invoke delegates)
  ├─ broker-http-router.ts (HTTP route table)
  └─ broker-* services (write paths, mesh, streams, sessions)
```

| Layer | Modules | Responsibility |
| --- | --- | --- |
| **Process** | `broker-daemon.ts`, `broker-process-manager.ts`, `broker-server-lifecycle.ts` | env/config, singleton probe, listen/shutdown |
| **Persistence** | `broker-journal.ts`, `broker-durable-store.ts`, `broker-durable-record-store.ts`, `broker-delivery-store.ts`, `broker-work-item-store.ts`, `broker-read-cursor-store.ts` | journal append, write queue, entity helpers, deliveries, work items, read cursors |
| **Read model** | `broker-core-service.ts`, `broker-core-message-read-model.ts`, `broker-home-service.ts`, `broker-capability-matrix-service.ts`, `broker-api.ts` | snapshots, feeds, capability matrix, in-process client |
| **Routing & dispatch** | `broker-delivery-routing.ts`, `broker-unavailable-target-service.ts`, `broker-delivery-acceptance-service.ts`, `broker-invocation-dispatch-service.ts`, `broker-local-endpoint-resolver.ts`, `broker-local-invocation-service.ts`, `broker-local-invocation-helpers.ts`, `broker-flight-lifecycle-service.ts` | target resolution, `/v1/deliver`, invocation accept/dispatch, endpoint selection, local execution, flight lifecycle |
| **Conversations & messages** | `broker-conversation-service.ts`, `broker-conversation-helpers.ts`, `broker-message-service.ts`, `broker-command-service.ts` | actors/conversations, message posting, control commands |
| **Mesh** | `broker-mesh-bundle-service.ts`, `broker-mesh-forwarding-service.ts`, `broker-mesh-discovery-service.ts`, `broker-mesh-http-service.ts` | peer bundles, authority forwarding, discovery, receiver routes |
| **HTTP & streams** | `broker-http-router.ts`, `broker-http-helpers.ts`, `broker-http-entity-write-routes.ts`, `broker-delivery-http-service.ts`, `broker-durable-action-http-service.ts`, `broker-managed-session-http-service.ts`, `broker-a2a-service.ts`, `broker-control-stream-service.ts`, `broker-trpc-router.ts` | route table, inbox/delivery HTTP, durable actions, managed sessions, A2A JSON-RPC, SSE, WebSocket firehose |
| **Sessions & sync** | `broker-managed-session-service.ts`, `broker-managed-session-helpers.ts`, `broker-local-agent-sync-service.ts` | pairing/local-session attach, registry sync |
| **Operator surfaces** | `broker-web-control-service.ts`, `broker-operator-attention-service.ts`, `broker-repo-tail-service.ts` | web child supervision, operator attention/mobile alerts, repo watch/tail reads |

Shared runtime primitives (`broker.ts` in-memory registry, `scout-dispatcher.ts` label
resolution, `local-agents.ts` harness transports) sit beside this map and are called
from the services above.

### Runtime

Manages agent sessions across harnesses — starting them, stopping them, health-checking them. Handles system prompt generation, tmux session management, and transport adapters for each harness type.

Also owns the file-based agent override registry, project discovery, and harness profile resolution.

### Local Service Process Tree

On macOS, local service ownership is intentionally layered:

```plaintext
launchd -> scoutd -> scout-base -> scout-broker -> scout-web / scout-edge / OpenScoutMenu
                  \-> scoutd probes/native-read (Unix socket)
```

`launchd` keeps `scoutd` alive. `scoutd` is the native daemon and doctor at the
root of the Scout-owned runtime tree. Its Rust child also maintains bounded,
read-only projections from the broker journal for native surfaces. `scout-base` is the Bun service composer:
it starts and restarts broker, web, edge, and menu children. This distinction is
why the Rust binary is named `scoutd`, while the Bun orchestrator keeps the
`scout-base` process name.

### CLI

The operator's main interface. It sends route intent such as `--to hudson` or `--channel triage` to the broker and renders broker receipts, remediation actions, and orientation views. Target metadata belongs in structured command fields, not in the message body.

### Surfaces

Desktop host, web dashboard, iOS companion, terminal UI, and pi. These are views into broker-owned control-plane state and observed harness activity. None of them own agent state; the broker does.

The pi extension (see the [archived integration proposal](./archive/eng/founding-proposals/sco-015-pi-scout-integration.md)) runs Scout coordination as a native pi extension, letting pi sessions send and receive messages via the broker alongside other harnesses.

## Performance Direction

Operator commands and surfaces need to stay cheap. They should not repeatedly scan
the machine, serialize the full broker registry, or queue presentation reads behind
routing work.

The broker is the canonical writer and communications fast lane. Its hot path owns
identity, reachability, routing metadata, messages, invocations, deliveries, and
flights. Rich cards, UI ordering, and other presentation joins are derived read
models rather than synchronous broker work.

The macOS native agent roster is the first native read projection. A Rust service
tails the append-only broker journal asynchronously, keeps a typed bounded projection
in memory, persists the last usable projection, and publishes sequenced NDJSON frames
over a mode-`0600` Unix-domain socket. Opening the HUD reads that already-warm state;
it does not require the web app or a broker snapshot request. The web endpoint remains
a compatibility fallback while other surfaces migrate.

The read service may lag briefly and must be stale-while-revalidate. It cannot write
Scout-owned records, synchronously proxy the broker, inspect private in-memory broker
state, or make routing wait for projection work.

## The Data Model

Scout is a control plane, not a transcript warehouse. Its storage model starts from one boundary: Scout owns the records it creates or routes, and observes external harness records without importing them wholesale. This matters for product scope, operator trust, and system design. The broker should make agent coordination durable without pretending to become the canonical database for every model turn written by Claude Code, Codex, or another harness.

Scout's coordination vocabulary is small. A **conversation** groups related turns; a **message** is a durable "say this" record; an **invocation** is a request for work; a **flight** is the lifecycle record attached to an invocation; a **delivery** is one routed attempt to reach a target; a **binding** maps a project path and branch to an addressable target; a **question** asks for an answer; and a **work item** owns a durable piece of execution. [`concepts.md`](./concepts.md) defines each precisely and maps them onto external protocols. This section is about who owns them.

### Durable Domain Data And Session Handles

Projects, agents, profiles, runtime profiles/specifications, nodes, channels,
work, and route bindings are domain data. They have independent meaning,
lifecycle, policy, and history.

A session is not an identity or a directory member. Its public form is an
opaque broker handle such as `sess.0123456789abcdefabcd`, addressed as
`session:sess.0123456789abcdefabcd`. The associated broker row behaves like a
short-URL mapping:

```text
session handle -> harness context + project/agent/profile/runtime references + endpoint lease
```

The handle must not encode an agent name, project path, harness, model, node, or
branch. Those are resolution facts, not parts of session identity. A harness's
native thread/session id is an internal alias on the mapping, not the canonical
Scout address. Session mappings are bounded lifecycle data and may expire after
the context is terminal; durable work and attribution continue to point at the
real domain records.

This distinction is also the cardinality boundary: starting or observing a new
harness context creates a session mapping, not a new agent, actor, profile, or
mesh directory entry. Compatibility readers may still accept historical native
ids and session-shaped agent records, but new writes must not create them.

### What Scout Owns

Scout owns first-party control-plane records:

- nodes, actors, agents, endpoints, and bindings registered with the broker
- conversations, messages, forwards, and replies created through Scout
- invocations, flights, deliveries, delivery attempts, and dispatch records
- collaboration records such as questions and work items when created through Scout
- local read models and activity projections derived from those first-party records

These records are broker-owned facts. They can be persisted, replayed, projected into SQLite, forwarded across mesh peers, and shown consistently across CLI, desktop, mobile, and agent tools.

### What Scout Observes

Scout observes external harness source material:

- Claude Code transcript JSONL
- Claude Code team, task, subagent, and session topology when available
- Codex session JSONL
- Codex subagent, thread, and custom-agent topology when available
- harness-specific logs, turn streams, and file-backed history
- process and filesystem signals that help explain what is running now

These sources are not Scout-owned conversation state. Scout may discover them, tail them, summarize them, link to them, index lightweight metadata, or expose live views over them. Scout should not bulk-copy external transcript turns into its control-plane database and treat them as first-party messages.

For harness-owned ecosystems such as Claude Code's `.claude` files, the boundary is stricter than "do not bulk-import": adapters should not write there at all. They may inspect what the harness exposes locally, but creating or modifying harness agents, teams, task lists, or MCP settings is outside adapter runtime behavior. Any host setup that changes a harness configuration must be an explicit operator action, not something an adapter does while observing or driving a session.

### Storage Split

The intentional split is:

- the broker journal records Scout-owned control-plane facts
- SQLite stores query projections of Scout-owned facts for local surfaces
- Rust native read services may maintain bounded, persisted projections by replaying
  the broker journal; these caches are disposable and never become canonical facts
- tail adapters read external harness transcripts from their original files
- tail views keep bounded live/backlog buffers rather than becoming durable transcript replicas

If a surface needs raw harness detail, it should prefer the original harness material through an adapter, cursor, or link. If a workflow needs durable coordination, it should create a Scout-owned message, invocation, flight, delivery, or work item.

### Canonical journal commit and replay contract

`FileBackedBrokerJournal.appendEntries` accepts one logical commit. Multi-record
commits use one JSONL `journal.batch` envelope with `version: 1`, `count`,
`sha256`, and `payload`. The payload is the exact JSON serialization of the
ordered entry array; the checksum covers its UTF-8 bytes. Readers validate the
version, checksum, count, and all entry kinds before exposing any entry. A torn
or corrupt frame exposes no partial invocation, dispatch job, or flight. Existing
single-entry lines, including complete legacy records without a final LF, remain
readable. A complete envelope without LF is also a complete logical batch.

Acceptance waits for the journal file's `fsync`, and a new journal also syncs its
parent directory. Failed writes or syncs restore and sync the previous file
length before another append can proceed. Runtime state, event publication, and
projection enqueue follow this durability boundary. A crash after persistence
but before a caller receives its response remains ambiguous to that caller;
idempotent request identifiers are required for retry. `fsync` is the explicit
OS durability contract, not a claim about hardware that ignores flushes.

Each physical line is limited to 16 MiB and a new batch to 4,096 entries. The
writer rejects excess work before its canonical append; streaming readers stop
with a visible error at the byte bound or an unsupported frame version rather
than silently certifying missing history. Legacy oversized records require a
deliberate reader/migration decision. Compaction preserves logical ordering and
replay barriers, syncs its replacement file, renames it, and syncs the directory.
Each replacement starts with a `journal.generation` header containing `version: 1`
and a fresh UUID. The header is physical framing metadata, not a domain record
or replay barrier. Logical replay skips it. Each subsequent rewrite replaces the
header; appends leave it unchanged. Legacy journals without a header remain
readable and acquire one on their first rewrite. Compaction can emit ordinary
singleton lines because publication replaces the whole file atomically.

The live SQLite projection runs in a worker. A canonical commit signals a scalar
dirty revision; it does not retain the accepted payload in a promise queue.
The worker captures a committed journal boundary and replays its suffix in
transactions bounded by 128 work units and 1 MiB of encoded records. One legal
record above that byte budget runs alone. A completed cursor is reused only
while the journal's device/inode and rewrite-generation identity match. Atomic
replacement causes a barrier-based rescan even if the filesystem reuses an inode. Flush captures one revision, so continuous new traffic
cannot prevent that boundary from completing. Worker requests and waiting reads
have fixed admission limits. SQLite and artifact CPU work, historical
publication, and event compression stay off the broker's command loop.
The default worker request deadline is 30 seconds. Advancing replay progress
extends that deadline; an unchanged heartbeat does not. A stalled worker rejects
its waiters and restarts against the same database. Canonical event replay writes
SQLite inside its replay transaction before advancing the checkpoint.

Historical SQLite may contain the sole surviving copy of records moved out of
the journal. Worker failure therefore closes and reopens the existing database;
recovery must not delete it or replace it with a journal-only reconstruction.
Historical relocation first publishes and verifies complete records in indexed
immutable partitions, then revalidates the current working version before
removing it. Exact identity and subject lookups use the historical index on
demand. Persistence verification sends bounded pages of canonical record
digests, preserving the same field normalization as SQLite without copying
large payloads across the worker channel.

Live journal compaction defaults to a 64 MiB threshold and a five-minute minimum
interval. Each cooperative scan is limited to one million entries, 100,000
tracked keys/rotation IDs, and 30 seconds; reaching a limit preserves the
original journal and reports the budget result. It deduplicates replaceable
registry state and removes only records explicitly named by durable verified
rotation markers. It retains replay barriers, unrotated event history, and all
new bytes accepted during the prefix rewrite. Event rotation first publishes the
compatible gzip export and indexed historical record, then returns verified IDs
while keeping the SQLite source. A canonical rotation marker authorizes replay
to remove only an unchanged row with the same indexed historical payload. This
keeps publication repeatable after a crash before the marker. Cleanup markers
survive startup compaction; live compaction removes them only within a captured
byte boundary whose projection cleanup completed on the same journal generation.
An inode match alone cannot authorize receipt removal.
Failed publication or verification keeps the working copy.

Broker replay, the disk message history index, and `scoutd` native projections
understand this format. History indexes reference a physical byte range plus
its entry ordinal, so repeated IDs in one frame retain their exact versions and
captured reads remain stable. Deploy the runtime and native reader together.
Older readers do not understand batch envelopes; directly downgrading to an
older writer/reader after accepting framed commits is unsupported. Derived
indexes remain disposable; the canonical journal and verified historical
SQLite records do not.

### Working data and historical data

The default working window is two weeks (`OPENSCOUT_RETENTION_WEEKS`); control
flow events use four weeks (`OPENSCOUT_ARCHIVE_WEEKS`). Zero disables the
corresponding rotation. These policies move records between storage tiers;
they do not delete historical context. Active flights, pending result replies,
nonterminal deliveries and dispatch jobs, and their required records stay live.

One maintenance page selects at most 250 records and scans at most 1,000
candidate records before yielding its selection cursor. It follows dependency
order across pages: attempts before deliveries, deliveries before their
invocations and messages, and invocations before flights. A long conversation
can therefore drain over several pages without fitting in one batch.
It publishes all selected payloads through bounded worker pages, verifies their
persisted values, and rechecks versions and live dependencies immediately before
the durable rotation marker. That marker authorizes ordered, conditional SQLite
cleanup during replay. A crash before the marker leaves the working records;
a crash after it resumes cleanup from the marker. Compaction retains unapplied
cleanup markers and all later writes. A changed record remains in working storage.
An oversized individual payload or unverified record remains live and appears
in the rotation-pressure report; a batch limit never authorizes partial data loss.
The eligibility pass still inspects the working graph; indexed historical data
does not participate in that pass.

One serialized maintenance loop starts after broker startup and drains pending
pages while yielding between them. A turn stops after four pages or after its
next page boundary observes 250 ms of elapsed work, then yields before
continuing a remaining backlog. Idle checks run
every minute; failures report the retained working data and retry after five
seconds. Shutdown cancels future pages and fences publication of new rotation
markers. These limits bound each turn without imposing a deletion policy on
accepted history.

Immutable SQLite partitions hold complete typed records plus their original SQL
rows and dependent data. Ordinary partitions have an 8 MiB payload bound; a
single large canonical record and its SQL bundle may use an isolated partition
up to 64 MiB. Message and invocation identity anchors remain in the working
database to preserve foreign keys and allow replies to old work. Exact reads
hydrate their historical bodies and context; a later mutation restores the
complete record before applying its change. Payload bytes leave the working
set while small identity/index metadata and total retained history can grow.
Free SQLite pages are reused. Online maintenance does not run whole-file VACUUM.

`GET /v1/invocations/:id` and invocation streams retain their existing handles
across rotation. Explicit local historical reads use
`GET /v1/history/records/:kind/:id`; indexed pages use
`GET /v1/history/records?kind=message&conversationId=...&limit=100` with the
returned cursor. Historical storage failure is reported as unavailable, rather
than a successful empty result. The current invocation path uses working state
without waiting for historical storage.

The memory/status diagnostic includes storage file sizes, free-space pressure,
acceptance capacity, maintenance progress, compaction budgets, and rotation
blockers. Acceptance allows at most 256 pending commands and 32 MiB of pending
request payloads. Disk space below the 256 MiB reserve or a full acceptance queue
returns a retryable `broker_busy` response before reserving a new request ID.
Previously accepted work and repeated completed receipts retain their identities.
Callers retry an uncertain ask with the same `--request-id`; they do not create a
new command to infer whether the old one ran. `--notify` returns the persisted
acceptance receipt without waiting for native session startup.

Request receipts use asynchronous filesystem reads, writes, and flushes, with
at most 256 pending operations and 32 MiB of retained request/receipt payloads.
An in-flight key is reserved before the first asynchronous step, so identical
concurrent retries share one operation and conflicting content is rejected.
Execution starts only after the reservation is durable; success returns only
after the completed receipt is durable.

### Scoped fault containment

A malformed record does not authorize a machine-wide reset or deletion. The
journal and SQLite projection preserve recoverable malformed input in a
machine-local quarantine ledger before skipping it. The ledger stores exact
source bytes, a verified digest, the reason, source location, and available
record/session/invocation handles. An invalid atomic frame is quarantined as a
whole. Other valid records and sessions can continue; compaction may remove
the original malformed bytes only after their quarantine copy is verified.
Failure to preserve evidence stops advancement past that record. Unsupported
journal versions, unbounded frames, filesystem failure, and invalid historical
cleanup proofs remain storage failures because their effects cannot safely be
limited to one session.

`scout quarantine` lists open warnings. `scout quarantine show <id>` reads the
complete evidence; `scout quarantine acknowledge <id>` hides that warning while
retaining its bytes and preventing automatic replay. `--session <id>` narrows
the list. The corresponding local routes are `GET /v1/quarantine`,
`GET /v1/quarantine/:id`, and `POST /v1/quarantine/:id/acknowledge`.
Health diagnostics expose bounded warning samples and counts. Acknowledgement
is not a repair, deletion, or permission to retry uncertain native submission.
The storage monitor also reports quarantine database and WAL sizes; evidence
accumulates in long-term storage without entering the active routing registry.
Result-reply quarantine writes run in the storage worker, with one bounded
large record allowed at a time. An unchanged, already-preserved result does
not enqueue another write on every recovery sweep.

### Design Rules

1. Do not make Scout the canonical store for external harness transcripts.
2. Do not persist every observed harness turn as a Scout `message`.
3. Do persist Scout-originated and Scout-routed coordination records.
4. Do use lightweight metadata, cursors, summaries, and links when external source material needs to appear in Scout surfaces.
5. Do not let adapters mutate harness-owned ecosystems such as Claude Code's `.claude` state.
6. Do keep the boundary visible in docs and APIs: `message` means a Scout conversation record, while `TailEvent` means an observed harness event.

This is an intentional product and architecture boundary, not an implementation shortcut. Better indexing and replay tools should still preserve the distinction between owned coordination state and observed harness source material.

## Agent Identity And Addressing

This is how Scout turns a human-friendly handle like `@hudson` into one exact Scout address for routing, and it is the reference for the address grammar.

Every agent Scout can address has a name. When there is only one matching agent on one machine, the name is simple — `@arc` or `@hudson`. But agents multiply. The same project might run on two machines. The same workspace might have a main branch and a feature branch, each with its own agent. A project might use Claude for one task and Codex for another.

The identity grammar exists to keep every target unambiguously addressable while still letting humans type the shortest useful name. The default target is the base project/workspace identity. Harness, model, node, and session details describe the concrete instance Scout routes to; they are not a different base agent unless the caller intentionally chooses a specialized profile.

### Base Agent Vs Instance

A **base agent** is the vanilla project/workspace identity that agents should
use when they do not care about a specific runtime. In practice this is the
thing represented by a project path, such as `../talkie`, or by a short handle,
such as `@talkie`.

An **execution resolution** is the concrete attachment Scout chooses for that
base identity: a profile/runtime choice, machine/node, endpoint lease, and
opaque session handle. It is routing state, not another agent identity.
`talkie#codex`, `talkie#claude`, and each session they start must not multiply
the base agent directory.

Default rule: if the project is known but the exact agent/session is not, use
project routing and let Scout pick or create the concrete instance. Add a
harness/capability constraint when that matters:

```bash
scout ask --project ../talkie --harness claude "Review this."
```

```ts
ask({ projectPath: "../talkie", harness: "claude", body: "Review this." })
```

Do not guess generic names such as `claude.main` just because you need a Claude
review. Scout should return durable follow-up handles and, when possible, a
situated target handle for the routed worker. Promote that worker to a named
long-lived sibling only after the route is known good.

A **situated Scout target** is the saved result of that resolution: agent
profile, project, harness, rules/tool context, and the current continuation
handle that Scout should use. Humans type it as `target:<name>`. Agent-authored
prompts and compact UI may render the same handle as `⌖name`. `@missionwriter`
names a role or definition, `#ops` names a channel, and
`session:sess.<token>` names one exact runtime session. A target handle
can resolve through current broker records to the right ref, session, or
binding, but it is not itself a raw harness session id.

A **route alias** is separate broker-owned pointer state attached after creation
to one durable agent id or one exact broker-known session. `alias:review`
selects it explicitly; a bare `review` consults it only after native agent
names/selectors fail. Aliases are scoped by owner realm, canonical project, and
authority node. Repointing changes future resolution only: acceptance pins the
binding id/revision and canonical target into durable receipts and records.
Route aliases never create cards, agents, actors, or sessions.

When routing by an agent card, label, or exact agent id, Scout treats the target
as a fresh-session request. Use `session:sess.<token>` or MCP `targetSessionId` only
when the caller intentionally wants to continue one concrete prior harness
session. Canonical writes and receipts use the opaque Scout handle. Historical
`session:<harness>:<native-id>` and raw native ids remain compatibility lookup
forms only and should resolve immediately to the Scout handle. Historical
session records and reachability diagnostics are for that explicit session
path, not fallback candidates for normal card routing.

Specialized profiles may become first-class over time. For example,
`@scout.profile:investigator` could name a profile with a dedicated tool set
and instructions. That is a specialization layered onto the project identity,
not the default routing model.

Runtime launch profiles are a separate concept from the `profile:` identity
qualifier. Leading reserved names `Fable`, `Kimi`, `Grok`, and `Opus` in CLI
natural-language asks produce a structured `runtime_profile` route for a fresh
current-project session. The broker owns the harness/model/default mapping.
Fable and Opus accept broker-validated effort overrides. Kimi and Grok reject
effort overrides until their ACP transports expose a corresponding control.
Likewise, `agent Composer Review to ...` produces an `existing_handle` route
for exact `@composer-review` lookup. It does not create a session, choose a
local duplicate, or consult fuzzy aliases. See
[`runtime-profile-and-existing-handle-routing.md`](./eng/runtime-profile-and-existing-handle-routing.md).

Neither route is a post-hoc alias: runtime profiles are launch presets and
existing handles name already-known live targets. Mutable route aliases retain
their own scoped broker records, revisions, and explicit alias target kind;
unknown profile or exact-handle routes never fall through to alias lookup.

### Runtime Specification Is Not Identity

`RuntimeSpec` is a launch contract, never an `AgentIdentity`. Its canonical,
shell-safe grammar has fixed positions:

```text
<harness>[/<model>[/<effort>]]
```

Examples are `codex`, `claude/opus`, and
`codex/gpt-5.6-sol/xhigh`. Sparse harness-plus-effort requests use separate
flags because the grammar has no placeholder segment. The equivalent explicit
form is:

```bash
scout ask --project ../talkie --harness codex \
  --model gpt-5.6-sol --effort xhigh "Review this."
```

Runtime profiles are base presets; valid explicit dimensions override the
preset. The per-dimension launch ladder is explicit flag or RuntimeSpec,
profile preset, endpoint metadata, harness config, then harness default.
Conflicting overlapping selectors and illegal harness/model/effort tuples fail
closed. Exact runtime selection creates an isolated session instead of
restamping or reusing a mutable live endpoint. An exact `session:<id>` target
is legal only when observed runtime evidence matches every requested dimension.

Invocation receipts preserve an `executionResolution` record for harness,
model, and reasoning effort. Each dimension distinguishes `requested`,
`resolved` plus its source (`flag`, `literal`, `profile`, `endpoint`, `config`,
or `default`), and harness-reported `observed` truth plus drift. Resolved launch
arguments are not treated as observation.

Bare natural-language tokens use one stable priority: a reserved profile id is
a profile launch; otherwise a launchable harness id is a harness-only
RuntimeSpec; model-family words are never valid bare; remaining names are agent
targets only when they are not reserved. The `#` harness and `?` model
qualifiers retain their fixed meanings on agent identities, and effort is not
an identity dimension.

New agent names and aliases cannot use runtime grammar words (launchable
harnesses, profiles, effort values, route words, dimension keys, product
identities, or built-in definition ids). Exact model ids are intentionally not
globally reserved. Existing offenders remain migration-readable by qualified
id only in the one-time development migration. Normal startup now fails with
`reserved_name_existing` when a stored project or registry entry still uses a
reserved name; Scout does not silently rename production identities.

### Three Layers

Scout separates identity into three layers, each serving a different audience:

- **Canonical identity** is exact, stable, and system-owned. It includes every dimension needed to distinguish one agent from all others. Humans rarely type it, but the broker always stores it.

- **Minimal unique identity** is the shortest address that still resolves to exactly one agent. Scout computes it automatically from the current set of online agents. When there is only one `hudson`, `@hudson` is enough. When two exist on different machines, `@hudson.node:mini` disambiguates.

- **Configured identity alias** is an input declared on an agent definition and participates in native identity resolution.

- **Route alias** is mutable broker state over an already-existing agent or exact session. It has its own binding id, revision, owner/project/node scope, authorization, expiry, and audit history. It does not mutate identity.

### The Six Dimensions

An agent identity combines up to six dimensions:

| Dimension | What it captures | Example |
|---|---|---|
| `definitionId` | The base project or workspace | `arc`, `hudson` |
| `workspaceQualifier` | A non-default worktree or branch | `super-refactor`, `main` |
| `profile` | Optional specialization/persona, not the default route | `dev`, `investigator` |
| `harness` | Instance execution backend | `claude`, `codex` |
| `model` | Instance model family or concrete model | `sonnet`, `gpt-5-5` |
| `node` | Instance machine or host | `mini`, `macbook` |

The canonical form strings them together with dots:

```bash
@<definitionId>[.<workspaceQualifier>][.profile:<profile>][.harness:<harness>][.model:<model>][.node:<node>]
```

In practice, most of these dimensions are omitted. You only include what is needed to resolve unambiguously.

### Examples

From shortest to most qualified:

| Address | What it resolves |
|---|---|
| `@arc` | The only `arc` agent currently online |
| `@arc.main` | The `arc` agent on the `main` branch |
| `@arc.super-refactor` | The `arc` agent on a feature worktree |
| `@arc.main.harness:claude` | The Claude instance of `arc` on main |
| `@lattices#codex?5.5` | Compatibility shorthand for the Codex instance of `lattices` on a 5.5 model |
| `@lattices#claude?sonnet` | Compatibility shorthand for the Claude instance of `lattices` on Sonnet |
| `@arc.super-refactor.harness:claude.node:mini` | Fully qualified: project, branch, harness, machine |

### Parsing And Normalization

- `@` is required for body-mention compatibility in user-facing text. Internal
  systems can omit it, and Scout-aware composers may use the `>>` route
  operator instead, such as `/scout:ask >> hudson Review this.`
- One positional qualifier (without a type prefix) is allowed after the definition ID — it is always treated as the workspace qualifier.
- Typed qualifiers (`profile:`, `harness:`, `model:`, `node:`) may appear in any order during input. Scout normalizes them to canonical order on storage.
- Shorthand `#<harness>` maps to `harness:<harness>`, and `?<model>` maps to `model:<model>`.
- Segments are lowercased and kebab-cased: `Super Refactor` becomes `super-refactor`, `Mini.local` becomes `mini-local`. Dots are reserved as separators.

These aliases are accepted during parsing and map to canonical dimensions:

| Alias | Maps to |
|---|---|
| `branch:`, `worktree:` | `workspaceQualifier` |
| `persona:` | `profile` |
| `runtime:` | `harness` |
| `#codex` | `harness:codex` |
| `?sonnet` | `model:sonnet` |
| `host:` | `node` |

### Resolution

When you type `@hudson`, Scout resolves it against all known agents:

1. Check for an exact alias match first.
2. Match the parsed identity against registered candidates.
3. If exactly one candidate matches, resolve to it.
4. If zero or more than one match, return nothing — the name is either unknown or ambiguous.

This keeps short names fast and ergonomic while requiring precision only when the situation demands it.

### Minimal Unique Identity

Given a specific agent and its peers, Scout prefers the shortest address that uniquely identifies it. Dimensions are dropped in this order until removing the next one would create ambiguity:

1. `workspaceQualifier`
2. `profile`
3. `harness`
4. `model`
5. `node`

If a configured alias is shorter than the minimal canonical form and resolves uniquely, Scout prefers it.

**Example:**

- Canonical: `@hudson.hudson-main-8012ac.node:arachs-mac-mini-local`
- Minimal unique: `@hudson` (if only one hudson is online)
- Alias: `@huddy`

## The Integration Boundary

External participants can request work, receive results, and relay human
decisions without being executed by Scout. Their boundary is authenticated
identity, permitted capabilities, durable correlation, and a return path. A
caller connection must not be registered as a harness session merely to fit the
execution model. This is the design target for participant adapters; each
adapter must document its actual supported access and lifecycle behavior.

For a **harness-backed execution target**, the data-level contract has three
pieces: register an **identity**, expose a reachable **endpoint**, and attach a
**session**.

- **Identity** is the stable Scout address for the agent, built from the dimensions above (`definitionId`, `workspaceQualifier`, `harness`, `model`, `node`). Human text uses a short handle; the broker resolves it to one exact target.
- **Endpoint** is how the broker reaches the agent: an agent id, an authority node, a harness, a transport, a session reference, and current reachability. The endpoint is a route, not the agent's personality — an agent can move between sessions or machines while keeping a stable identity.
- **Session** is the concrete harness conversation, process, or thread that receives work. Sessions are harness-specific: a request for a Codex harness must not bind to a Claude session, or the reverse, without an explicit adapter.

Once attached, an integration speaks two paths through the broker:

- the **message path** (`send`) for durable "say this" updates that return a broker receipt but no tracked work lifecycle
- the **invocation path** (`ask`) for work, where the ask creates an invocation, the invocation creates a flight, and the flight tracks queued, running, waiting, completed, failed, or cancelled state

Two rules hold across both paths. Do not hide routing instructions in the message body when structured target fields exist — the broker should know the target as metadata, not by parsing prose. And never write harness-owned files: adapters observe `.claude` and Codex state, they do not author or repair it.

That is the shape of the boundary. For the full adapter contract — endpoint states, session invariants, broker-guided routing, preferred MCP tools, human-input and permission handling, and the compatibility checklist — read [`agent-integration-contract.md`](./agent-integration-contract.md). For the wire-level message and invocation workflows, read [`scout-comms.md`](./scout-comms.md).

For represented authority, cross-interface continuity, and human handoffs, use
the [Shared Interaction Model](./interaction-model.md). Authorization context,
chat, work item, invocation/flight, and runtime session have separate lifetimes.
Existing actor and requester ids are coordination facts, not proof of a
delegated permission. New adapters must not infer authority from body text or
silently substitute the local operator's privileges.

## Addressing And Session Lifecycle

![Agent lifecycle](arc:agent-lifecycle)

1. **Bind.** Create or refresh a Scout-local binding from a project path and branch to an addressable agent target.

2. **Start or attach.** `scout up` launches or resumes the harness session Scout should use for that target, with a generated system prompt that includes the collaboration contract when Scout owns the launch path.

3. **Route.** Messages with explicit target intent hit the broker, which resolves the name, finds the endpoint, and dispatches.

4. **Invoke.** For ask-style interactions, the broker creates a flight record -- tracking the request-response lifecycle with acknowledgement, retry, and durable completion semantics.

5. **Stop.** `scout down` terminates the local session and marks the endpoint offline.

```bash
scout up hudson          # bind + start
scout send --to hudson "hi"  # route + deliver
scout ask --project ../talkie --harness claude "..."  # capability route + invoke
scout ask --to hudson "..."  # route to a known agent + invoke (tracks flight)
scout down hudson        # stop
```

## Mesh

![Mesh topology](arc:mesh-topology)

Agents on different machines discover each other through mesh forwarding. Each broker advertises its local agents to peer brokers, which sync endpoint tables so `@agent.other-machine` resolves across the network. In Scout, mesh means reachability and coordination, not global consensus, exactly-once delivery, or replicated external transcript storage.

### Discovery

Brokers find peers two ways: by probing Tailscale's peer list (`tailscale status --json`) and through manually configured seed URLs. No mDNS, no cloud discovery service. If you're on a Tailscale network, your brokers can find each other automatically. If not, point them at each other with `OPENSCOUT_MESH_SEEDS`.

```bash
# Automatic — brokers on the same tailnet discover each other
scout mesh discover

# Manual — seed a broker URL directly
OPENSCOUT_MESH_SEEDS=http://workstation-2:43110 scout mesh discover
```

Once a peer is found, the broker fetches its agent registry via `/v1/snapshot` and merges remote agents into its local database. Each agent carries an `authorityNodeId` — the node that owns it. Messages and invocations for remote agents get forwarded to the authority broker over HTTP.

### Forwarding

When you `scout send --to hudson "..."` and hudson lives on another machine, the broker's delivery planner detects that hudson's `authorityNodeId` differs from the local node. Instead of delivering locally, it bundles the message with its full context — actors, agents, conversation, bindings — and POSTs it to the remote broker's `/v1/mesh/messages` endpoint. The remote broker commits the bundle to its own journal and delivers locally.

Invocations work the same way. Ask-style requests forward to the authority node, which executes them and returns the flight record.

### Pairing

A phone or second workstation joins the mesh through `scout pair`. The local broker starts a relay (or connects to an external one), generates a QR code with a pairing payload, and waits. The remote device scans the code, connects over a Noise-protocol-encrypted channel, and becomes a full mesh peer — not just a viewer. It gets a live view of the agent graph and can send messages into any conversation.

```bash
scout pair              # show QR code, start managed relay
scout pair --relay url  # use an external relay
```

## What Scout Is Not

Scout is not a framework for building agents. It is not a cloud service. And it is not a replacement for any single agent tool. It is the connective tissue between agent runtimes, harnesses, and operator surfaces.
