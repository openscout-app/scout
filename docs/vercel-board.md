# Vercel Board adapter: engineering plan

Status: plan and implementation notes, 2026-11-19. The adapter is under
`packages/runtime/src/vercel-board/`. This document states intended behavior.
Read it before you change that directory.

Evidence: every statement about Board comes from the Board 0.52.0 documentation
shipped in the `@vercel/board` package. No statement here was verified against
a running board. The credential exchange is the least certain; see
[Open questions](#open-questions).

## What we are building

A team coordinates on a Vercel Board. Scout projects the board the way it
projects Slack:

- Each followed channel is a Scout chat room. The room shows every thread and
  message in the channel, from Scout's copy of the channel.
- An operator claim is an ordinary Scout ask, dispatched in the channel's room
  with the task bound to it. The agent's answer goes back to the board as the
  task's result.
- Nothing lands on Scout's work board by itself. A Board task becomes a Scout
  work item only when the operator promotes it.

Board remains the writer of its messages, tasks, claims and labels. Scout is
one participant on the board.

The reason to build it: Board's documentation says that nothing wakes an agent
after its turn ends, and its remedy (watchers) needs a Vercel deployment. The
Scout runtime is already a long-running process that can wake agents.

Two existing parts of core set the pattern:

- The Slack integration: an external channel shows as a Scout room, and Scout's
  own acts are ordinary Scout messages and flights.
- The [T3 adapter](./t3-orchestrator.md), for a promoted task only. It projects
  an external card into a work item through `ExternalWorkContext`, and the
  external system remains the writer of its board.

## Decisions

| Decision | Reason |
| --- | --- |
| Mirror the followed channels into runtime-owned tables, never into Scout's message log. | Board messages are edited, deleted and change task state in place. An append-only log cannot hold that without replays and duplicates. A table keyed by message ID at its latest `version` can. This keeps "Observe, don't absorb" in [architecture](./architecture.md): the copy is observed source material, not Scout messages. |
| Only Scout's own acts are Scout messages and flights. | An operator claim, the dispatched ask and the agent's reply are Scout's. Everything else in a room renders from the copy. |
| A Board task becomes a work item only on promote. | A team board holds far more tasks than the operator wants on Scout's work board. |
| Hand-offs go on the live stream, not into a ledger. | The goal is understanding who handed what to whom, not permanence. The copy's task events already hold them. |
| A mention wakes no agent. | Board text comes from teammates and synced platforms. Only an operator act starts an agent. |
| Ship observe and claim together. | A read-only projection is a weaker copy of Board's viewer. A task completed by an agent on a second host is the first result that proves the adapter. |
| The first board is the Vercel team board, single user. | Settled by the operator. The local board (`vb serve`) is the test backend. Design for Vercel's limits (300-second leases, 30-day feed, shared rate limit); the local board then needs no special case. |
| Only planned work goes on Board. Tasks between agents stay in Scout. | Writing every Scout task to a rate-limited external API would flood the board and make Scout depend on Vercel to run. |
| Scout creates Board tasks, for planned work only. | This reverses an earlier cut. Planning needs a write path, and outside workers can only claim what is on the board. |
| No standing lead agent. | Planning is an ordinary Scout task. Claim, renew, settle and retry are runtime code. |
| Runtime code claims; agents only declare a role. | Claim tokens stay with the custodian. An agent never calls claim, so it cannot pick its own work off a board that teammates and synced platforms write to. |
| Only a role-kept task the operator or Scout wrote starts on its own, and only in a self-serve channel. | Board text can come from teammates and from systems that sync into the board. Elsewhere, and for any other task, the operator starts the claim. The runtime matches each task once; after a release, a failure or a lost lease, the operator decides. |
| Roles are a closed list in the connection: `scout`, `builder`, `reviewer`. | Each is a Board profile of the operator's principal. `scout` plans; the others work. A task kept for a role (`for`) can be claimed only as that role. |
| A task settles only on a verb. | A final `reply --ref` completes it and `--failed` fails it. A turn that ends without a verb releases it, so a refusal never reads as completed. `--waiting-on` holds it on the board as `blocked` and stops renewing; the answer lifts the hold and Scout claims again as the same role. |
| Scout's writes are `noSync` by default. Only `syncChannels` may publish them through Board's sync. | One outbound writer per Slack channel: a Board-linked channel uses Board sync, never an independent Scout bridge writer. |
| Promote is frozen. | The code stays; nothing new builds on it. |
| A `failed` task shows as waiting, labeled failed. | Board lets the owner reopen a failed task, and its dependents still wait on it. Someone owes a move. Scout does not add a failed state. |
| Board owns `state`. Scout owns acceptance. | One writer per field. A move from Scout is a command to Board; the result returns as an event. |
| Scout writes as the operator's principal with the `scout` profile. The acting agent is in a label. | Board profile names cannot hold Scout agent names, and short-lived sessions would fill the team's actor list. Labels stay on the board and do not sync out to other platforms. |
| Key actors, the allowlist and the custodian lease on the principal ID. | A second person can be added later without migrating records. See [Multi-user readiness](#multi-user-readiness). |
| One custodian runtime holds each board connection. | The cursor, the claim tokens and the outbox need a single fenced writer. The mesh gives reachability, not consensus. |
| Do not add a shared integration framework. | T3, Slack and Board have different shapes. Two or three providers do not justify one. |

`syncChannels` is empty by default. For a channel the operator explicitly maps
through Board's Slack sync, planned task roots and completed or failed
settlement replies carry `noSync: false`, so Board is the only outbound writer
to Slack. The reply uses the existing per-thread outbox, a deterministic client
ID, the claiming role and the acting agent label. Scout's direct Slack bridge
must be disabled for that channel. Every other write, including setup probes,
stays `noSync`.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Owner | The operator | Puts work on the board through Scout, answers what is waiting, and reviews finished work. |
| Planner | Any session that receives an ordinary Scout task | Breaks work down and writes Board tasks with `needs` through a Scout MCP tool. |
| Mechanics | Runtime code on the custodian | Follows the feed, matches role-kept tasks to declared agents, claims, renews, blocks, settles and retries. |
| Workers | Scout agents on any host, and any other client that speaks Board | Do the tasks. A Scout agent declares a role (`scout integration role vercel-board --role reviewer`) and ends each task with a verb. Board's lease keeps two workers off one task. |

### Who starts a claim

1. The operator, with `scout integration claim vercel-board`. The claim goes
   as the role the task is kept for, or as `scout` for an open task. It checks
   the root's author as well as the task's owner against the allowlist.
2. The matcher, on each custody tick. It reads demand from the mirror, with no
   Board call, and claims a task when all of these hold:
   - the channel is in the connection's `selfServe` list;
   - the task is `ready` and kept for a role other than `scout`;
   - the operator made it, and wrote it as themselves or as `scout`;
   - Scout has never claimed it;
   - an agent that declared the role holds no other Board task.
   It reads the task from the board again before it claims.

A dependency's result reaches the next agent only when Scout wrote it, or the
mirror's event chain shows an allowlisted principal completed the task.
Otherwise the prompt says the result is withheld, and who finished it.

The planning tool is the only path that creates a Board task from Scout.
`scout ask` must not write to Board. This makes "planned work" a mechanical
rule: a task is on the board because someone called the planning tool, not
because an agent judged it important.

The planning tool must not create a Scout work item. Planned tasks show in the
channel's room. A planned task becomes a work item only when the operator
promotes it, under a deterministic ID.

## Setup

1. The operator creates a Vercel access token and stores it with
   `secret set <entry>`. This is the only interactive step. Scout reads the
   token by reference and never prints it. Scout does not use the Vercel CLI's
   login: its refresh token rotates, and a failed refresh wipes the CLI's auth
   file, so two processes that share it log each other out.
2. The operator runs
   `scout integration connect vercel-board --team <team> --board scout --credential secret_cli:<entry>`.
   On a plan that allows one board, the operator names that board:
   `--board General`.
3. The worker finds or makes the named board as the person, before it narrows
   the caller. A caller narrowed with `x-board-can` names channels only, so
   Vercel refuses it a board it would have to make (403).
4. Scout makes the channels `scout/work` and `scout/decisions`, and the probe
   channel `scout/probe`. The prefix keeps them apart from a shared board's own
   channels. `--channels` and `--probe-channel` change them. `--mirror` names
   the channels Scout keeps a copy of; the default is every followed channel.
5. Scout records the custodian host and makes a Scout room for each followed
   channel.
6. Scout creates, claims and completes one probe task in the probe channel.
7. Scout reports the connection as verified only after the probe task
   completes.

## Boundaries

```text
Vercel Board  (canonical: messages, tasks, claims, labels, grants)
     ^   |
     |   |  HTTPS, operator's credential, profile "scout", x-board-can
     |   v
Custodian runtime  (one per board and principal)
  follower   bulk backfill, then long-poll /events per mirrored channel, cursor
  mirror     messages at their latest version, task events (hand-offs)
  projector  promoted task root to work item (ExternalWorkContext)
  custody    claim epoch and token, renew timer
  outbox     posts, claims, settles; one serial lane per thread
     ^   |
     |   |  Scout mesh: tasks, replies, work claims. No Board tokens.
     |   v
Agents on any host
```

- Only the custodian runtime talks to Board. Agents on other hosts reach Board
  through Scout.
- Agents must not hold a Board credential or a claim token.
- The runtime must send `x-board-can` on every request. The value narrows the
  caller to the followed channels and to `read`, `post`, `react` and `label`.
  The runtime must not request `manage` or `sync`. A person's credential can
  otherwise do everything, grants included.
- The cursor, the claim tokens and the outbox must not be replicated across
  mesh nodes.
- Board content enters Scout in three forms only: the copy of a mirrored
  channel, a read-through view of any other followed channel, and the work
  item of a promoted task. Board text in the copy is never a Scout message.
- Scout content leaves only through an explicit act: a planned task, a reply,
  a claim, a settle or a block. Scout conversations are not mirrored out.
- Every outbound write is outward-facing. A post on the board can reach Slack
  or GitHub through Board's own sync. The MCP tool descriptions must say so.
- The runtime must keep working when the board is unreachable. Scout tasks
  that are not on the board do not depend on Vercel.

## Mapping

### Objects

| Board | Scout | Rule |
| --- | --- | --- |
| Board (URL and name) | A board connection | Holds the URL, credential reference, followed and mirrored channels, `can`, allowlist and custodian host. |
| Channel | A Scout room | One room per followed channel. ID: `stableChannelId("vercel-board:<connection>:<channel>")`. The operator is always in it; each dispatched agent is added. |
| Message (root or reply) | A row in `vercel_board_messages` | Keyed by (connection, message ID), at its latest `version`. Keeps `by` (actor, principal, profile), `origin`, `noSync`, labels, task state. |
| Task (root message and `task`) | The same row, with `task_state` | A work item only after promote. |
| Promoted task | Work item with `externalContext` | `adapterId: "vercel-board"`, `instanceId` is the connection, `workItemId` is the root ID, `sourceState` keeps Board's spelling. The Scout ID is a hash of (connection, root ID). |
| `needs` on a promoted task | `depends_on` relations | The target uses the same hash, so a dependency resolves before its own promote. |
| Task labels on a promoted task | Work item labels, prefixed `vercel-board:` | Skip `board.*`; those labels repeat the state. |
| Task event | A row in `vercel_board_task_events`, and a `vercel_board.handoff` event on the live stream | See [Hand-offs](#hand-offs). |
| Actor (principal and profile) | Scoped Scout actor, keyed on the principal ID | Display only. A mapped actor has no Scout authority. |
| Reactions, schedules, schemas, grants | Nothing in v1 | Attachment metadata can be listed. Bytes are fetched on demand. |

`origin` is `scout` for a message Scout wrote (the operator's principal with
the `scout` profile), the sync key in `from` for a post a sync provider
carried in, and `board` otherwise. Scout must not post a row back to the board:
the copy only reads, so no echo loop can start. Board's own `noSync` and
`origin` keep a synced post from going back to its platform.

### Task state

| Board state | Scout `state` | Detail |
| --- | --- | --- |
| `ready` | `open` | |
| `waiting` | `waiting` | `waitingOn` names the first open dependency. |
| `claimed` | `working` | `ownerId` is the mapped claim actor. If Scout holds the claim, `ownerId` is the Scout agent that does the work. |
| `blocked` | `waiting` | `waitingOn` carries the reason. The next move belongs to the task owner. |
| `failed` | `waiting` | `waitingOn` is a condition labeled `failed: <reason>`. |
| `completed` | `done` | `summary` takes the task's `result`. |
| `canceled` | `cancelled` | |

- The Scout `state` of a Board item is a function of the Board state. Scout's
  lifecycle rules must not move a Board item.
- Board has no review state. The adapter does not project into Scout's
  `review` state.
- When a Scout agent completes a task, the projector records a runtime move
  into the Done station. The Done station's judge answers the move with the
  review `pending`, and the Board service then sets acceptance to pending from
  that answer. The lifecycle engine returns the verdict; it does not write
  acceptance. The projector must not set `acceptanceState` on its own.
- `requestedById` on these items is the operator. A mapped Board actor cannot
  confirm acceptance.
- Acceptance is an inbox, not a gate. When the operator looks, Board already
  shows the task completed and its dependents ready. A gate before completion
  uses Board's idiom: `block`, or a second task that `needs` the first.
- The projector must write only the fields it owns. It must not overwrite
  `acceptanceState`, `requestedById` or the work placement metadata on a later
  event. The T3 refresh spreads the projection over the stored record; that
  shape would reset acceptance on every Board event.
- Which lane shows each state, including the In review lane, is decided in the
  apps. It is out of scope here.

## The mirror

A followed channel is in one of two modes.

- **Not mirrored.** A view reads the channel through in one bulk call
  (`GET /messages?channel=…&limit=…`) and keeps nothing.
- **Mirrored.** Scout keeps a copy: a bulk backfill, then deltas from the
  channel's feed.

Status shows each channel's state:

| State | Meaning |
| --- | --- |
| `not_mirrored` | The channel is followed for claims and views, with no copy. |
| `backfilling` | The first bulk read is running. |
| `mirrored` | The copy is current. Status gives the cursor, the time of the last delta and the message count. |
| `re_reading` | The cursor was rejected or too old, and the channel is being read in bulk again. |

Sync rules:

- One cursor per mirrored channel. A narrowed caller reads each channel's own
  feed.
- Backfill takes the feed's head first, then reads the newest 500 messages in
  one call and the channel's task list in pages. Each open task the copy holds
  and both reads omit is read by ID; a missing one becomes a tombstone.
  Following then starts at that head, so nothing after it is missed.
- Following long-polls `GET /events?channel=…&after=<cursor>&wait=300`. Each
  event carries its message as it is after the event. The copy applies
  `event.message` without a read and drops any view at or below the stored
  `version`.
- A read whose cursor is past ours means a delta is waiting: fetch it.
- The feed keeps 30 days. A cursor older than 29 days, or an `invalid_cursor`
  answer, starts a re-read. The copy never replays.
- An edit overwrites the text. A delete leaves a tombstone with no text and no
  labels. Task state is a field on the root's row.
- The cursor moves in the same transaction as the rows it covers, by compare
  and swap. A second follower on the same store loses its commit and changes
  nothing.
- A periodic refresh re-lists the tasks and takes any newer version. It does
  not move the cursor.

Views are bulk and cheap. A mirrored channel's view is one indexed query on
`vercel_board_messages`. A hand-off chain is one indexed query on
`vercel_board_task_events`. Neither view calls the board.

Board text is quoted source material. Every row and view carries
`trust: "board_source"`. A client must render it as quoted text with its
author, and an agent must not take it as an instruction.

## Hand-offs

The runtime emits each task hand-off on its live stream, beside asks and
flights, as the ephemeral control event `vercel_board.handoff`. Hand-offs come
from the feed's task events. They are not posted as status replies, and they
are not stored in a separate ledger: each is derivable again from
`vercel_board_task_events`.

Kinds: `created` (`planned` when the planning tool wrote it), `assigned`,
`claimed`, `released`, `expired`, `completed`, `failed`, `blocked`,
`unblocked`, `reopened` and `canceled`. `task.renewed` is a lease renewal and is
not a hand-off. `task.ready` has no actor and is not a hand-off. `task.expired`
has no actor.

The event payload is `{ handoff }`:

```ts
type VercelBoardHandoff = {
  id: string;            // "vercel-board:<connection>:<feed cursor>": stable, dedupe key
  source: "vercel_board";
  connectionId: string;
  channel: string;
  taskId: string;        // the Board task root ID: the join key
  kind: VercelBoardHandoffKind;
  at: number;            // the event's own time, epoch ms
  cursor: string;        // the feed cursor, or "derived:…" for a backfilled task
  actor: { actor: string; principal: string; profile: string | null; scoutActorId?: string } | null;
  to: string | null;     // the Board actor the task went to, when the kind has one
  epoch?: number;        // the claim epoch
  title?: string;        // created and planned
  result?: string;       // completed
  reason?: string;       // failed, blocked, canceled
  scout?: { agentId: string; flightId?: string; attemptId: string }; // when the claim is Scout's
  derived?: true;        // inferred from the task's state at a backfill
};
```

The actor comes from the event's `by`. When Scout holds the claim, `scout`
names the agent, the flight and the custody attempt, and `actor.scoutActorId`
is that agent.

One task's chain, from the copy:

```sql
SELECT * FROM vercel_board_task_events
WHERE connection_id = ?1 AND task_id = ?2
ORDER BY at, rowid;
```

The same chain over the API is
`GET /v1/integrations/vercel-board/handoffs?connection=<id>&task=<task ID>`,
and on the CLI
`scout integration handoffs vercel-board --connection <id> --task <task ID>`.
On the live stream, filter `vercel_board.handoff` events on
`payload.handoff.taskId`.

A hand-off row is a fold over one task's chain, joined by task ID:

| Field | From |
| --- | --- |
| dispatched at | `at` of the `claimed` event (or `assigned` when the task went to someone by name) |
| from | `actor` of the `created`, `planned` or `assigned` event |
| to | `to` of the `claimed` or `assigned` event |
| task | `taskId`, with `title` from `created` or `planned` |
| source | `source` (`vercel_board`) |
| state | `kind` of the newest event |
| finished at | `at` of the `completed` or `failed` event |
| result | `result` (completed) or `reason` (failed) |

A task the copy first saw at a backfill has no events of its own. The
follower derives its hand-offs from its state (created, then claimed,
completed, failed, blocked or canceled) and marks them `derived`.

## Where state lives

| State | Store | Leaves the custodian |
| --- | --- | --- |
| Messages, tasks, claims, labels | Board | Not Scout's |
| Connection: URL, channels, mirror, `can`, allowlist, custodian host | Runtime config | No |
| Board credential | A credential reference, as the Slack integration uses | No. Never in argv, logs, status or records. |
| Feed cursor and last delta time for each mirrored channel | `vercel_board_cursors`, in the same transaction as the rows it covers | No |
| Copy of each mirrored channel | `vercel_board_messages` | Views only |
| Task events | `vercel_board_task_events` | As `vercel_board.handoff` on the live stream |
| Promotions | `vercel_board_promotions` | No |
| Claim custody: task, epoch, token, expiry, holding agent, Scout work-claim generation | SQLite, outside the journal and outside every read model | No |
| Outbox: intended write, client `id`, attempts, result | SQLite | No |
| Rooms, the dispatched ask, the agent's reply, promoted work items | Runtime journal | Yes, as ordinary Scout records |

The runtime stores the claim token raw, because the runtime presents it to
Board. With 300-second leases, a restart that loses tokens loses every claim.
The custody row stays after a settle, marked settled, so a replayed
`task.completed` event can still be matched to Scout's own claim.

## Failure outcomes

Losing a claim is a normal event. Each case below has one named outcome.

| Case | Outcome |
| --- | --- |
| Follow | Reads are at-least-once. The copy applies a message only when its `version` is higher than the stored one. The cursor advances in the same transaction as the rows. A hand-off is recorded once, keyed on its feed cursor. |
| Cursor rejected, or idle longer than the feed keeps | Do not replay. Re-read the channel in bulk, as a backfill, then follow from the head. |
| First connect | A bulk backfill: the head, the newest 500 messages, the task list. Older threads arrive when they change. |
| Claim answer lost | The claim request has no idempotency key, and Board shows the token once. Scout holds a claim it cannot use. Request the shortest lease on a first claim, let it lapse, and claim again. This is a known stall of at most 300 seconds. Do not retry the claim request. |
| Claim order | The runtime grants the Scout work claim only after the Board claim lands. It stores Scout's lease generation beside Board's `epoch`. |
| Renew | The custodian renews at a third of the lease, and only while the Scout flight for the work is alive. A dead agent stops renewals, and Board hands the task to another worker. |
| Claim lost during work | Causes: `claim_lost`, an expired lease, or an edited or deleted root. Cancel the Scout work claim, tell the agent that the task moved on, and keep its output as a Scout record. Do not write to the thread as the holder. |
| Settle answer lost | A retry returns `claim_lost`, which is ambiguous. Read the task. If the task is in the settled state and its `epoch` equals Scout's, the first attempt landed. |
| Custodian offline while an agent finishes | The result waits in the outbox. If the task is `ready` again and its `epoch` is still Scout's, claim again and complete with the stored result. Otherwise keep the result as a Scout record, show the item as waiting with "finished here, claim lost", and ask the operator. |
| Post or reply answer lost | The client `id` derives from the Scout message ID. Read the post by that `id` before a retry. |
| Root deleted upstream | The copy keeps a tombstone with no text. A promoted task's work item loses its title and summary, not only its state. Scout must not keep text that the team deleted. |
| Credential expired | The connection moves to `auth_expired` and names the fix. Claims lapse. Items show as stale with the time of the last good read. The connection must not hang. |
| Rate limit (429) | Honor `Retry-After`. Renewals go first, then reads, then reconcile. The limit is shared with every other Board client that uses the operator's credential. |

## Trust

Scout assumes trusted local users and agents. A team board is not local, and
its text is not uniformly trusted: it comes from teammates, from their agents,
and through Board's sync from anyone who can write in a mirrored Slack channel
or open a GitHub issue. Team text that reaches an agent with a shell is the
main risk of this adapter.

- **Owner allowlist.** The runtime dispatches a task to a Scout agent only if
  the task's owner principal is on the connection's allowlist. The default is
  the operator's own principal. Other tasks are projected and need an operator
  decision.
- **No automatic claim in v1.** A claim starts from the operator, or from an
  agent the operator asked.
- **Mentions.** A mention of the `scout` profile wakes no agent. It shows in
  the room like any other message.
- **Quoted text.** The runtime delivers task and reply text to an agent as
  quoted source material, with its author and Board ID. The text is not an
  instruction from the operator.
- **Narrowed permissions.** `x-board-can` on every request keeps an agent that
  follows injected text away from grants and from other channels.

## Multi-user readiness

V1 is single user. Four rules in v1 keep a second person from being a rewrite:

- Key the owner allowlist and every mapped Board actor on the principal ID.
  Do not key on a handle or a display name.
- Write as the operator's own principal with the `scout` profile. A second
  person's Scout writes as that person's principal, and Board keeps the two
  apart.
- Put the acting agent in a label on every outbound write.
- Key the custodian lease on (board, principal), not on the board. Two
  people's Scouts can follow one board. The guard against a duplicate
  custodian applies inside one person's mesh.

## Phases

| Phase | Scope | Exit check |
| --- | --- | --- |
| 0. Spike | Credential and transport. Answers open questions 1 to 3. | Each question has a written answer. |
| 1. Observe | Connection, follower, mirror, `scout integration connect vercel-board`. | Stop the runtime during a feed read and restart it. The copy then matches the board's messages and task states exactly. |
| 2. Claim and settle | Custody, renew timer, outbox, operator-started claims, the planning tool. | An agent on a second host completes a task, and the board shows it completed by the `scout` profile. Each lost-claim case in [Failure outcomes](#failure-outcomes) gives its named outcome. |
| 3. Rooms and mirror | Channel rooms, the bulk backfill and deltas, the hand-off stream, promote. | A mirrored channel's view and a task's chain each come from one query, with no board call. |
| 4. Apps | Board items in the web and Mac apps. This work is in the apps repository, after core merges. | Not in this repository. |
| 5. Serve the protocol | A decision, not a commitment. See [Not in v1](#not-in-v1). | |

Phases 1 and 2 ship together.

## Code layout

```text
packages/protocol/src/
  vercel-board.ts     connection, mirror, hand-off and request types
packages/runtime/src/vercel-board/
  connection.ts       config, validation, allowlist
  client.ts           HTTP: events, messages, tasks, posts, claims
  follower.ts         bulk backfill, long-poll, cursor, refresh
  mirror.ts           the copy and the task events; hand-off records
  projection.ts       promoted task to work item; pure
  custody.ts          claim, renew, settle
  outbox.ts           client IDs, serial lanes
  service.ts          wiring, rooms, dispatch, promote, views
  schema.ts           cursor, message, task event, promotion, custody, outbox tables
  worker.ts           supervisor and transport for the Board worker
packages/vercel-board-worker/src/
  worker.mjs          the Board worker: @vercel/board, pinned at 0.52.0
```

- The runtime speaks Board's HTTP protocol directly to a board that serves it,
  such as a `vb serve` board. It takes no dependency on `@vercel/board`.
- A team board in Vercel's API does not serve Board's documented protocol, so
  a supervised worker process holds the credential, as the Slack worker does.
  The worker runs `@vercel/board` on Node 24, started under
  `secret run --map <entry>=VERCEL_BOARD_TOKEN`. The worker is
  transport only. Claim tokens, the renew timer and the cursor stay in the
  runtime, and each claim write carries its epoch and token to the worker. The
  worker accepts a closed set of typed operations. The worker is not a general
  Board proxy.
- The fenced-lease pattern in `integration-worker-leases.ts` and the
  per-thread delivery in `integration-slack-delivery.ts` are the models.
  Reuse the patterns, not the Slack tables. Do not extend the Slack setup
  state machine.
- Run `bun run sync-exec:fence` if the adapter adds a worker process.

## Runtime stalls

A dev broker logged `slow_sqlite` for the adapter's queries at 1.0 to 1.2
seconds, on tables of a few rows. The queries are not slow. The same queries
take 0 to 15 ms from a separate connection, and a WAL reader is not blocked by
a long write transaction, a checkpoint or a schema change (44 ms at most in a
repro). The broker's own health check logged main-thread stalls of 1 to 3
seconds from startup, before any board activity, and other subsystems' queries
were caught in the same stalls. The cause is a process-wide stall (CPU
contention or garbage collection), not lock waits. The adapter's timers showed
up because they ran the most frequent queries.

The fix on the adapter side: the custody and outbox timers keep an in-memory
quiet flag for each connection, and run no SQL while nothing is held or
pending. A write that starts a claim or queues a post clears the flag.

## Not in v1

- Board messages in Scout's message log.
- History older than the newest 500 messages of a channel at backfill.
- Every Scout task on Board.
- Reactions, schedules, schemas, grants and attachment bytes.
- A Board profile for each agent.
- Automatic claims and pool rules.
- Acting as a Board sync provider. A sync provider would publish Scout
  conversations into the team's log, and it cannot register outside a Vercel
  deployment.
- Failover between custodians.
- Serving the Board protocol from Scout. The conformance kit requires message
  versions and revisions, conditional writes, tombstones and a total-order
  cursor, and Board's identity model is verified principals with grants. A
  stock local board with Scout as a participant gives most of the benefit.
  Reconsider when operators ask to point Board clients at work that Scout
  holds.

## Open questions

Questions 1 to 3 block phase 1. Questions 4 and 5 answer the two decisions
that were made after the architecture review.

1. **Credential.** How does a long-running local process get and refresh a
   token for a team board? The documentation describes a development token
   that is minted from `vercel login`, exchanged for the board's audience, and
   valid for 12 hours. The exchange is not in the HTTP reference. The answer
   decides between direct HTTP and the worker process.
   Answered: a team board takes a plain Vercel access token as a bearer token,
   with no exchange. The 12-hour exchange applies only to a board mounted in a
   deployment. The team board's API is not Board's HTTP protocol, so the
   worker process is the path.
2. **Request budget.** Does a caller narrowed with `x-board-can` read the feed
   for all followed channels in one request, or one request per channel?
3. **Client retries.** If the worker path is taken: does the Board client
   retry a claim on a network error by itself? A retried claim is the one
   write with no fence and no idempotency key.
   Answered for `@vercel/board` 0.52.0: it does not retry on a network error,
   but it retries a claim on 429 and 503, up to four more times, because the
   claim carries an operation ID. The worker's own `fetch` sends a claim once:
   a 429 is a refusal, and a 503 or no answer is an unknown outcome.
4. **Planned work only: the boundary is right, with two consequences.**
   - A task that the planner writes is owned by the operator's principal, so
     it passes the allowlist. The allowlist then no longer separates text the
     operator wrote from text an agent wrote. In v1 the operator starts every
     Scout claim, so the gate holds for Scout agents. It does not hold for
     outside workers: by Board's rule a worker claims ready tasks that its own
     principal owns, so a planned task is a live instruction for every outside
     worker under the operator's principal from the moment it is written.
     Recommendation: accept this for v1, record the planning task's Scout ID
     in a label on each planned task, and decide before pool rules or a second
     person whether a planned task needs an operator confirmation.
   - One piece of work must be one work item. Answered: a claim on a task
     that is not promoted is an ordinary ask in the channel's room and makes
     no work item. A claim on a promoted task attaches the ask to that work
     item through `collaborationRecordId`, and makes no second item.
5. **Custodian lease on (board, principal): the key is right, and the store
   is still open.** A per-board key was wrong for two people, and it was also
   unenforceable: no lease in one person's runtime can fence another person's
   runtime. The same limit applies between two hosts in one mesh. A lease in
   one node's SQLite fences processes on that node only, and the custodian
   host in the connection config is a record, not a fence. Board is the only
   ordered store that both hosts can reach. Proposal: keep the custodian
   marker on the board as a message owned by the principal, with the host and
   an epoch in labels, and change it with a conditional label write. A second
   host then refuses to connect unless the operator asks for a takeover, and
   the previous custodian sees the change in its own feed and stops. This
   proposal depends on Board's conditional label writes, which have not been
   tested.
6. **The `decisions` channel.** Setup creates it, and this plan does not yet
   state what Scout posts there or what Scout does with a post in it.
7. **Reopen after completion.** Scout's reopen verdict moves `state` back to
   working, and Board's `completed` is final. For a Board item, a reopen
   should set acceptance to reopened and create a Scout follow-up item, and
   must not move `state`. This needs a rule in the lifecycle code.
8. **Mention matching.** Moot for now: a mention wakes no agent.
