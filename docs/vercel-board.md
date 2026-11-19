# Vercel Board adapter: engineering plan

Status: plan, 2026-11-18. The adapter is in progress under
`packages/runtime/src/board/`. This document states intended behavior. Read it
before you change that directory.

Evidence: every statement about Board comes from the Board 0.52.0 documentation
shipped in the `@vercel/board` package. No statement here was verified against
a running board. The credential exchange is the least certain; see
[Open questions](#open-questions).

## What we are building

A team posts planned work as tasks on a Vercel Board. Scout shows those tasks
as work items, and a Scout agent on any host of the operator's mesh can claim a
task and complete it. Board remains the writer of its messages, tasks, claims
and labels. Scout is one participant on the board. Scout is not a replica of
the board.

The reason to build it: Board's documentation says that nothing wakes an agent
after its turn ends, and its remedy (watchers) needs a Vercel deployment. The
Scout runtime is already a long-running process that can wake agents.

Two existing parts of core set the pattern:

- Board tasks follow the [T3 adapter](./t3-orchestrator.md). The T3 adapter
  projects cards from an external board into work items through
  `ExternalWorkContext`, and the external system remains the writer of its
  board.
- Board thread replies follow the Slack integration: one serial delivery lane
  per thread, with a stored request and response.

## Decisions

| Decision | Reason |
| --- | --- |
| Project tasks only. Bind a thread only when Scout is engaged in it. | A full mirror makes Scout a replica of a log it does not own. That breaks "Observe, don't absorb" in [architecture](./architecture.md). Board has its own viewer for chat. |
| Ship observe and claim together. | A read-only projection is a weaker copy of Board's viewer. A task completed by an agent on a second host is the first result that proves the adapter. |
| The first board is the Vercel team board, single user. | Settled by the operator. The local board (`vb serve`) is the test backend. Design for Vercel's limits (300-second leases, 30-day feed, shared rate limit); the local board then needs no special case. |
| Only planned work goes on Board. Tasks between agents stay in Scout. | Writing every Scout task to a rate-limited external API would flood the board and make Scout depend on Vercel to run. |
| Scout creates Board tasks, for planned work only. | This reverses an earlier cut. Planning needs a write path, and outside workers can only claim what is on the board. |
| No standing lead agent. | Planning is an ordinary Scout task. Claim, renew, settle and retry are runtime code. |
| The operator starts each claim in v1. | Board text can come from teammates and from systems that sync into the board. No agent with a shell starts on that text without an operator act. |
| A `failed` task shows as waiting, labeled failed. | Board lets the owner reopen a failed task, and its dependents still wait on it. Someone owes a move. Scout does not add a failed state. |
| Board owns `state`. Scout owns acceptance. | One writer per field. A move from Scout is a command to Board; the result returns as an event. |
| Scout writes as the operator's principal with the `scout` profile. The acting agent is in a label. | Board profile names cannot hold Scout agent names, and short-lived sessions would fill the team's actor list. Labels stay on the board and do not sync out to other platforms. |
| Key actors, the allowlist and the custodian lease on the principal ID. | A second person can be added later without migrating records. See [Multi-user readiness](#multi-user-readiness). |
| One custodian runtime holds each board connection. | The cursor, the claim tokens and the outbox need a single fenced writer. The mesh gives reachability, not consensus. |
| Do not add a shared integration framework. | T3, Slack and Board have different shapes. Two or three providers do not justify one. |

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Owner | The operator | Puts work on the board through Scout, answers what is waiting, and reviews finished work. |
| Planner | Any session that receives an ordinary Scout task | Breaks work down and writes Board tasks with `needs` through a Scout MCP tool. |
| Mechanics | Runtime code on the custodian | Follows the feed, claims, renews, settles and retries. |
| Workers | Scout agents on any host, and any other client that speaks Board | Do the tasks. Board's lease keeps two workers off one task. |

The planning tool is the only path that creates a Board task from Scout.
`scout ask` must not write to Board. This makes "planned work" a mechanical
rule: a task is on the board because someone called the planning tool, not
because an agent judged it important.

The planning tool must not create a Scout work item. The work item appears
through projection, under the same deterministic ID, when the task's event
arrives.

## Setup

1. The operator runs `vercel login`. This is the only interactive step. Scout
   must not run it.
2. The operator runs `scout board connect`.
3. Scout creates a named board `scout` on the operator's team, with the
   channels `work` and `decisions`. Scout does not use the team's shared
   default board.
4. Scout records the custodian host for the connection.
5. Scout creates, claims and completes one probe task in a scratch channel.
6. Scout reports the connection as verified only after the probe task
   completes.

After setup the operator does not need the Board CLI. Board's viewer remains
available for inspection.

## Boundaries

```text
Vercel Board  (canonical: messages, tasks, claims, labels, grants)
     ^   |
     |   |  HTTPS, operator's credential, profile "scout", x-board-can
     |   v
Custodian runtime  (one per board and principal)
  follower   long-poll /events per followed channel, cursor
  projector  task root to work item (ExternalWorkContext)
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
- Board content enters Scout in two forms only: a projected work item, or a
  delivered message in an engaged thread. There is no general message mirror
  and no backfill.
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
| Board (URL and name) | A board connection | Holds the URL, credential reference, followed channels, `can`, allowlist and custodian host. |
| Channel | Nothing | A filter on the connection. A Board channel is not a Scout channel. |
| Task (root message and `task`) | Work item with `externalContext` | `adapterId: "vercel-board"`, `instanceId` is the connection, `workItemId` is the root ID, `sourceState` keeps Board's spelling. The Scout ID is a hash of (connection, root ID). |
| `needs` | `depends_on` relations | The target uses the same hash, so a dependency resolves before its own event arrives. |
| Task labels | Work item labels, prefixed | Skip `board.*`; those labels repeat the state. |
| Engaged thread | Conversation with a `ConversationBinding` | `platform: "vercel-board"`, `externalThreadId` is the root ID. |
| Reply in an engaged thread | Delivered message from a mapped actor | Idempotency key is (connection, Board message ID). An upstream edit updates the message. An upstream delete tombstones it. |
| Any other thread | Nothing | Read on demand. |
| Actor (principal and profile) | Scoped Scout actor, keyed on the principal ID | Display only. A mapped actor has no Scout authority. |
| Reactions, schedules, schemas, grants | Nothing in v1 | Attachment metadata can be listed. Bytes are fetched on demand. |

A thread is engaged when one of these is true: Scout holds or held the claim
on its task, an allowlisted actor mentioned the `scout` profile in it, or the
operator followed it.

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
  into the Done station. The Done station's judge then sets acceptance to
  pending. The projector must not set `acceptanceState` directly.
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

## Where state lives

| State | Store | Leaves the custodian |
| --- | --- | --- |
| Messages, tasks, claims, labels | Board | Not Scout's |
| Connection: URL, channels, `can`, allowlist, custodian host | Runtime config | No |
| Board credential | A credential reference, as the Slack integration uses | No. Never in argv, logs, status or records. |
| Feed cursor for each followed channel | SQLite, in the same transaction as the projection it covers | No |
| Last seen `version` for each task root | SQLite | No |
| Claim custody: task, epoch, token, expiry, holding agent, Scout work-claim generation | SQLite, outside the journal and outside every read model | No |
| Outbox: intended write, client `id`, attempts, result | SQLite | No |
| Projected work items, thread bindings | Runtime journal | Yes, as ordinary Scout records |

The runtime stores the claim token raw, because the runtime presents it to
Board. With 300-second leases, a restart that loses tokens loses every claim.
The custody row stays after a settle, marked settled, so a replayed
`task.completed` event can still be matched to Scout's own claim.

## Failure outcomes

Losing a claim is a normal event. Each case below has one named outcome.

| Case | Outcome |
| --- | --- |
| Follow | Reads are at-least-once. The projector applies an event only when its `version` is higher than the stored one. The cursor advances in the same transaction as the upserts. |
| Cursor rejected, or idle longer than the feed keeps | Do not replay. For each followed channel, list the open tasks and upsert each. Fetch individually each item that Scout shows open and the list omits. Then follow from the head. Run the same reconcile on a slow timer. |
| First connect | Head plus the reconcile. No history. |
| Claim answer lost | The claim request has no idempotency key, and Board shows the token once. Scout holds a claim it cannot use. Request the shortest lease on a first claim, let it lapse, and claim again. This is a known stall of at most 300 seconds. Do not retry the claim request. |
| Claim order | The runtime grants the Scout work claim only after the Board claim lands. It stores Scout's lease generation beside Board's `epoch`. |
| Renew | The custodian renews at a third of the lease, and only while the Scout flight for the work is alive. A dead agent stops renewals, and Board hands the task to another worker. |
| Claim lost during work | Causes: `claim_lost`, an expired lease, or an edited or deleted root. Cancel the Scout work claim, tell the agent that the task moved on, and keep its output as a Scout record. Do not write to the thread as the holder. |
| Settle answer lost | A retry returns `claim_lost`, which is ambiguous. Read the task. If the task is in the settled state and its `epoch` equals Scout's, the first attempt landed. |
| Custodian offline while an agent finishes | The result waits in the outbox. If the task is `ready` again and its `epoch` is still Scout's, claim again and complete with the stored result. Otherwise keep the result as a Scout record, show the item as waiting with "finished here, claim lost", and ask the operator. |
| Post or reply answer lost | The client `id` derives from the Scout message ID. Read the post by that `id` before a retry. |
| Root deleted upstream | Blank the title and summary in Scout, not only the state. Scout must not keep text that the team deleted. |
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
- **Mentions.** A mention of the `scout` profile wakes an agent only when the
  author is on the allowlist. A mention by any other author raises operator
  attention and wakes no agent.
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
| 1. Observe | Connection, follower, projector, reconcile, `scout board connect`. | Stop the runtime during a feed read and restart it. Scout's work items then match the board's task list exactly. |
| 2. Claim and settle | Custody, renew timer, outbox, operator-started claims, the planning tool. | An agent on a second host completes a task, and the board shows it completed by the `scout` profile. Each lost-claim case in [Failure outcomes](#failure-outcomes) gives its named outcome. |
| 3. Engaged threads | Bindings, inbound replies as Scout tasks, outbound replies, `block` and `unblock`. | To be written with the phase. |
| 4. Apps | Board items in the web and Mac apps. This work is in the apps repository, after core merges. | Not in this repository. |
| 5. Serve the protocol | A decision, not a commitment. See [Not in v1](#not-in-v1). | |

Phases 1 and 2 ship together.

## Code layout

```text
packages/protocol/src/
  board.ts            connection and mapping types
packages/runtime/src/board/
  connection.ts       config, validation, allowlist
  client.ts           HTTP: events, tasks, posts, claims
  follower.ts         long-poll, cursor, reconcile
  projection.ts       task to work item; pure
  custody.ts          claim, renew, settle
  outbox.ts           client IDs, serial lanes
  service.ts          wiring, as in t3/
  schema.ts           cursor, version, custody, outbox tables
```

- The runtime speaks Board's HTTP protocol directly. It takes no dependency on
  `@vercel/board` unless the spike requires one.
- If the spike shows that the login exchange is not stable HTTP, a supervised
  worker process holds the credential, as the Slack worker does. The worker is
  transport only. Claim tokens, the renew timer and the cursor stay in the
  runtime, and each claim write carries its epoch and token to the worker. The
  worker accepts a closed set of typed operations. The worker is not a general
  Board proxy.
- The fenced-lease pattern in `integration-worker-leases.ts` and the
  per-thread delivery in `integration-slack-delivery.ts` are the models.
  Reuse the patterns, not the Slack tables. Do not extend the Slack setup
  state machine.
- Run `bun run sync-exec:fence` if the adapter adds a worker process.

## Not in v1

- A general message mirror, Board channels as Scout channels, backfill.
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
2. **Request budget.** Does a caller narrowed with `x-board-can` read the feed
   for all followed channels in one request, or one request per channel?
3. **Client retries.** If the worker path is taken: does the Board client
   retry a claim on a network error by itself? A retried claim is the one
   write with no fence and no idempotency key.
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
   - One piece of work must be one work item. A Scout task today creates its
     own work item. When the runtime dispatches a Board task to an agent, the
     dispatch must attach to the projected item and must not create a second
     item. The mechanism is not designed yet.
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
8. **Mention matching.** The documentation is inconsistent about server-side
   mention matching on Vercel's board. Match mentions in the runtime on the
   stored actor ID until this is tested.
