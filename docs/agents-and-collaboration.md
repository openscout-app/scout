# Agents And Collaboration

In Scout, a conversation is where you say things; a durable work record is how you
get things done. The two are deliberately separate. A message is a durable turn in
a conversation — it captures what was said. A question or a work item is a durable
coordination record — it captures what is being asked, who owns the next move, and
whether it is finished. The runtime keeps both durable and routable, so a handoff
survives restarts, device switches, and the gap between when work is requested and
when it actually lands.

This doc covers how agents and operators reach each other and coordinate owned
work. For the system shape — broker, runtime, and protocol layers — read
[`architecture.md`](./architecture.md). For precise noun definitions and their
open-protocol mappings, read [`concepts.md`](./concepts.md). For wire-level client
and adapter workflows — request shapes, receipts, reply context — read
[`scout-comms.md`](./scout-comms.md), which stays the front door for building a
Scout-aware client.

The Shared Interaction Model defines the adopted
design for external participants, represented authority, and continuity across
interfaces. Collaboration ownership and the next move remain separate from
permission to perform an action. Moving work to another agent cannot by itself
grant broader access, and a new execution session does not create a new work
identity. The model's coverage table records the remaining implementation gaps.

## Reaching An Agent

Two verbs carry every interaction:

- **`send`** posts a durable message with no tracked lifecycle. Use it for a
  status, a note, a reply, or a channel post. The runtime still writes a durable
  receipt (`conversationId`, `messageId`), but there is no flight to follow and no
  owned work to complete. `send` is the clean replacement for pasting the same
  update into three terminals.
- **`ask`** creates an invocation, which opens a flight — a tracked lifecycle the
  broker follows from request to completion. Use it when you expect work,
  investigation, review, or an answer. The initial response is the broker receipt,
  not the target's acknowledgement; the target posts its own acknowledgement and
  completion later, in the same conversation.

Routing follows one model everywhere. The [quickstart](./quickstart.md) teaches the
commands; here are the semantics:

- **One target** routes to a DM.
- **Group coordination** requires an explicit channel — the runtime will not invent
  one.
- **Everyone** is an opt-in broadcast, never a default.
- **A capability request** names a project path plus an optional harness; the
  broker picks or creates the worker. Prefer this over guessing a concrete handle.
- **Continuity** rides a returned handle — a `ref`, `flightId`, `conversationId`,
  `workId`, `target:<name>`, or `session:<id>`. Follow up by handle; do not
  re-derive the target from body text or re-guess a name. `target:<name>` is the
  human-typed saved situation; `⌖name` is the compact agent/UI shorthand.

Message body text is payload, never routing metadata. State the target in an
explicit field and keep the body for the human-readable request.

## Questions

A question is for getting information back, not for getting execution done. It is
lightweight by design: no ownership beyond the two parties, no progress tracking,
no review gate.

**States:** `open` · `answered` · `closed` · `declined`

`answered` means someone responded — not that the asker agrees. A question can be
closed immediately after a good answer, or left open for follow-up. Ownership
rotates between the two parties: while `open`, the responder holds the next move;
once `answered`, the asker does (close or reopen).

Required fields: `id`, `title`, `requestedById`, `ownerId`, `nextMoveOwnerId`, and
create/update timestamps. A question carries no `waitingOn` and no progress — those
are work-item concerns.

Typical flow:

1. The asker creates a question; the runtime routes it to a responder.
2. The responder posts an answer, moving the state to `answered` — or `declined` if
   it cannot help.
3. The asker closes it, or leaves it open to press further.

If the answer reveals real execution work, the question does not grow into a work
item — it **spawns** one, linked back to the question. The asker then sees both the
answer and the new work item. A question that starts accumulating progress
checkpoints or waiting states is a sign it should have been a work item from the
start.

## Work Items

A work item is for durable, owned execution: something built, fixed, reviewed, or
coordinated across multiple turns. It can be self-originated, requested by another
party, or spawned from a question.

**States:** `open` · `working` · `waiting` · `review` · `done` · `cancelled`

- `open` — created and assigned, not yet started.
- `working` — the owner is actively on it and posting progress.
- `waiting` — the owner cannot proceed until someone else acts. Preferred over
  "blocked"; it is a real state, not a failure. A `waiting` item must name what it
  waits on.
- `review` — the work is proposed complete and awaiting a verdict.
- `done` — terminal success, reached on acceptance.
- `cancelled` — terminal, abandoned before completion.

### Ownership And Next Move

Two fields, always distinct in intent:

- `ownerId` — who owns the work overall.
- `nextMoveOwnerId` — who must act next for the item to progress.

Every non-terminal work item has exactly one `nextMoveOwnerId`. This is the anchor
for notification routing, stale detection, and the sweeper. Ownership transfers
explicitly with each state transition — the broker records the move; it is never
inferred from who spoke last. When an item is `waiting`, the next move belongs to
the dependency owner, not the whole work group. `requestedById` records who asked
for the work, so a delegated item remembers its requester through every handoff.

### Acceptance Is Orthogonal

Acceptance is separate from workflow state, so "I replied" never silently means "we
agree this is done."

- `pending` — a requester or reviewer exists and has not yet weighed in. A `review`
  item typically sits at acceptance `pending`.
- `none` — no review was asked for. This is the default for a new work item:
  when its flight completes, the item goes straight to `done`.

Review is the asker's choice. An asker that wants a verdict before `done` sets
`acceptanceState: "pending"` on the work item, and the finished item then moves
to `review` with the next move on the requester.

### Progress And Waiting

Progress tracking is first-class but optional: a summary plus step or percent
completion ("3 of 7 steps", "40%") lives on the work item and never on a question.
When an owner hits a dependency, it moves to `waiting` and names it in `waitingOn`
rather than going quiet.

## Assigned Roles And The Mission Log

Assigned roles add small, explicit duties to the collaboration model. They do
not redefine an agent's identity, `agentClass`, or harness. A role assignment
grants a catalogued duty to an agent at one of three scopes: a mission, a
standing agent duty, or a project. The first built-in role is
**orchestrator**: it owns the mission spine, may link child work and asks, and
may append the mission log.

Use a **mission-scoped** orchestrator assignment for a campaign whenever
possible. In v0, the mission id is the root work-item id. A standing
agent-scoped orchestrator is available for an operator deliberately running an
ongoing orchestrator persona, but it is still a durable agent assignment—not a
promise that one particular process or session will live forever. If its process
dies, start a fresh session and re-steer the durable agent and mission context;
reserve `session:<id>` continuation for the rare case where the exact prior
harness context matters.

The mission log is a cheap, structured situation stream, not a second chat
thread. Each entry states a stable short **intent**, a short current **status**,
and a **kind** such as `progress`, `delegation`, `waiting`, `risk`, `done`, or
`failed`; it can also link the relevant flight, work item, message, or session.
Put full reasoning, conversation, and evidence in the appropriate DM or work
record. Scout observes external harness transcripts as source material and does
not bulk-import them as mission-log or first-party chat records.

The anti-spam boundary is deliberate: **no assignment, no mission log**. Scout
never infers the duty from an agent being chatty or from its harness. A write is
allowed only when an active assignment both applies to that mission and its role
allows `mission_log.append`; the default policy allows one active
mission-scoped orchestrator, unless an operator explicitly permits more.

This is a coordination floor, not a rigid graph engine. An assignment grants a
duty and optional role actions; agents remain free to choose how they work. Scout
adds sparse lifecycle behavior and durable visibility where it can do so
deterministically, rather than trying to turn every tool call or transcript line
into a workflow edge.

### Operating It

The command surface is `scout role`:

| Command | Purpose |
|---|---|
| `scout role catalog` | List role definitions. |
| `scout role list [--agent <id>] [--mission <id>] [--role <id>] [--all]` | List assignments; by default only active ones. |
| `scout role assign --role orchestrator --agent <id> --mission <workId>` | Grant the normal mission-scoped orchestrator duty. |
| `scout role revoke <assignmentId>` | Revoke an assignment. |
| `scout role log <missionId> [--limit N]` | Read the ordered mission log. |
| `scout role log-append <missionId> --actor <id> --kind <kind> --intent "..." --status "..."` | Append a permitted short situation entry. |

`assign` also supports `--standing` for an agent-scope duty and `--project
<root>` for a project scope. Mission assignment enforces a single orchestrator
by default; `--allow-multiple` is the explicit override. The role command
is available through `scout role`. From a source checkout, use
`bun packages/cli/src/main.ts role <command> ...`.

A separately supplied web client can expose the same records through its own
API. These app routes are not core runtime endpoints:

- `GET /api/roles/catalog`
- `GET` and `POST /api/roles/assignments`
- `POST /api/roles/assignments/:id/revoke`
- `GET` and `POST /api/missions/:missionId/log`

The log append endpoint requires `actorId`, `kind`, `intent`, and `status` and
enforces the same assignment gate (apart from the explicit system/operator
override used by trusted control-plane writers).

### Broker Lifecycle Floor

The runtime supplies one deterministic lifecycle floor today. When an ask's
flight becomes terminal, it evaluates the orchestrator lifecycle binding
`post_ask_summary`: if the target or requester holds the applicable
orchestrator assignment, Scout appends a concise mission-log summary. Completed
asks produce a progress/integration summary and failed or cancelled asks produce
a failed summary. For a mission-scoped assignment, the mission is already known.
For a standing agent-scoped assignment, the terminal ask must carry a related
work/mission id (for example its collaboration/work context) before Scout can
write a mission log entry.

This is intentionally not full hook automation. MCP role-assignment and
mission-log tools, `role sit`/`role open` CLI affordances, and wiring the soft
orchestrator prompt into harness startup remain follow-up work. The protocol
already has a soft prompt helper, but an assignment does not yet inject it into a
running harness automatically.

### The Sweeper

The sweeper is insurance, not a planner. It periodically inspects stale non-terminal
records and nudges the one party holding the next move — nothing more. It does not
invent work, reinterpret goals, or ping the whole thread.

| Stale state | Sweeper nudge |
|---|---|
| `question` open | Ask the responder to answer or decline |
| `question` answered | Ask the asker to close or reopen |
| `work_item` working | Ask the owner for a progress update or a waiting transition |
| `work_item` waiting | Ask the next-move owner to resolve the dependency |
| `work_item` review | Ask the reviewer to accept or reopen |

Stale work is surfaced to exactly one owner; it is never silently lost.

## Delegation Done Right

When one agent hands concrete work to another, a few rules keep the recorded story
true — because future prompts, sweeps, notifications, and analytics key off the
recorded semantics, not the mere fact that the target eventually replied.

- The sender is the acting **project agent**, not the human operator behind it.
- One-to-one delegation goes in a **DM**, not a shared channel.
- Set `ownerId` and `nextMoveOwnerId` at creation.
- Progress, review, and completion stay attached to that same private thread.
- Follow up by the returned handle — never by re-guessing the target's name.

### Worked Example

An operator tells the Premotion agent to hand the syntax-highlighting task to
Hudson. Premotion — not the operator — is the sender. It opens (or reuses) a DM with
Hudson, creates a work item owned by Hudson with Hudson as next-move owner and
Premotion as requester, and invokes Hudson with the work context and a return
address. Hudson works the item through `working` → `review` in that same DM;
Premotion sees each transition and finally accepts or reopens.

```mermaid
sequenceDiagram
  autonumber
  actor Operator
  participant Premotion as Premotion agent
  participant Broker
  participant Hudson as Hudson agent

  Operator->>Premotion: hand the syntax task to Hudson
  Premotion->>Broker: open/reuse DM(Premotion, Hudson)
  Premotion->>Broker: create work item<br/>owner=Hudson · nextMove=Hudson · requestedBy=Premotion
  Broker->>Hudson: wake with DM context + work record
  Hudson->>Broker: working / waiting / review / done
  Broker-->>Premotion: transitions in the same DM
  Premotion-->>Operator: summarize; accept or reopen
```

### Anti-Patterns

- **Broadcasting a 1:1 task.** Sending an owned handoff to a shared channel or
  broadcast trains the logs, UI, and sweeper on the wrong audience.
- **Guessing a generic handle.** Reaching for a name like `claude.main` as a first
  guess is fragile; route by project plus capability, let the runtime return the
  real worker, then pin a memorable sibling only after it proves good.
- **Untyped consults for durable work.** Dropping an owned task in as a plain
  shared-thread message loses the ownership and lifecycle the work deserves. If it
  needs an owner and a definition of done, it is a work item.

## Waking And Attention

The runtime wakes the minimum set of targets needed to preserve responsibility — not
everyone in the conversation.

Reliably wakes an agent:

- a direct mention or a DM addressed to it,
- being assigned as `ownerId`, or more urgently `nextMoveOwnerId`,
- a next-move transition that hands it the baton.

Does **not** reliably wake an agent:

- passive visibility in a channel it happens to be a member of. Membership is not
  attention; if you need an agent to act, address it, assign it, or hand it the next
  move.

The runtime owns this decision. Harness adapters carry the collaboration contract
into a session and translate lifecycle events back, but they do not reinterpret
mentions, rewrite work-state transitions, or turn a wake into a restart loop. That
contract is specified in [`agent-integration-contract.md`](./agent-integration-contract.md)
and [`mcp-api-posture.md`](./mcp-api-posture.md).

Operators are pulled in by attention, not solicited at every step. "Needs the
human" — an approval, an unanswered question, or a `waiting` item stalled on an
operator decision — is a first-class state routed to the person, not a side effect
of whichever harness printed a prompt. See
[`operator-attention-and-unblock.md`](./operator-attention-and-unblock.md).

## Invariants

1. Every non-terminal question or work item names exactly one `nextMoveOwnerId`.
2. Every work item has exactly one `ownerId`; next-move ownership is always
   explicit, never inferred from who spoke last.
3. `waiting` is valid only for work items, and a `waiting` item must name
   `waitingOn`.
4. Acceptance `pending` applies only when a requester or reviewer exists;
   self-driven work uses `none`.
5. A question does not accumulate execution state — durable work spawns a linked
   work item instead.
6. A one-to-one delegation stays in its DM; it never leaks to a channel or
   broadcast.
7. Follow-up rides the handles the runtime returned — `ref`, `flightId`,
   `conversationId`, `workId`, `target:<name>`, `session:<id>` — never a
   re-guessed name.
8. Work-state transitions are broker-recorded, not inferred; routing history is
   reconstructable from durable records, not from terminal scrollback.
