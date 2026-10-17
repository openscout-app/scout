# T3 Orchestrator adapter

Scout can inspect a T3 environment, attach an existing T3 thread, run a fresh
board card, and project its board into durable Scout work items. T3 remains authoritative for
its projects, cards, workflows, and transcripts. Scout owns the coordination
records and the return path for work requested through Scout.

Status: alpha adapter for local developer pilots. The adapter targets
[T3 Orchestrator commit `46e3533`](https://github.com/leonaaardob/t3-orchestrator/tree/46e35332722e6cc7da2dfb47a7b1f8795ab3b7e0).
T3's Effect RPC interfaces are internal APIs. Check compatibility before
changing the T3 version.

## Configure a connection

Run T3 with a configured execution provider and a project in its environment.
Use T3's own setup flow to obtain access to that environment. The Scout broker
must be able to reach the T3 environment's WebSocket endpoint.

Configure connections in the **broker process environment**:

```sh
export OPENSCOUT_T3_CONNECTIONS='[{"id":"local","url":"http://127.0.0.1:3773","tokenEnv":"T3_ACCESS_TOKEN"}]'
```

Replace the example URL with the environment's actual origin. An origin or
`/ws` URL is accepted. HTTP and WS are allowed for loopback connections.
Remote connections require HTTPS or WSS. URLs must not include credentials,
query parameters, or fragments.

Supply the access token to the broker process under the environment variable
named by `tokenEnv`. Use the machine's credential manager to inject the value.
Do not put the token in the connection JSON, a CLI argument, or a request body.
Restart the broker through its normal lifecycle after changing its environment.

Each `id` identifies one T3 environment. Keep the ID stable when rotating a
token. Scout uses the connection ID to scope source identities. Configure a new
connection ID when connecting a different environment with overlapping IDs.

The adapter acts with the authority of the configured T3 token. The connection
configuration does not create narrower per-project grants in T3. Use this alpha
with environments the operator is authorized to inspect and control.

## Inspect, attach, and follow work

List the source projects and threads:

```sh
scout integration t3 inspect --connection local
```

Inspect a project board using the exact T3 project ID from that result:

```sh
scout integration t3 board --connection local --project <t3-project-id>
```

The project ID is an opaque T3 ID. It is not a local directory path. Board
inspection uses `createIfMissing: false` and does not create a board in T3.

Attach the exact T3 thread that should receive work:

```sh
scout integration t3 attach --connection local --thread <t3-thread-id>
```

The JSON receipt contains a Scout session ID. Continue that session through
the normal ask path:

```sh
scout ask --to session:<scout-session-id> "Inspect the current project and report the result."
```

T3 is an orchestrator host. Its thread's configured provider remains the
execution backend. `--harness t3` is not a valid execution request.

Refresh the board's observations in Scout:

```sh
scout integration t3 refresh --connection local --project <t3-project-id>
```

All integration commands return JSON. Repeated refreshes update the same
Scout work IDs for the same connection, project, and card. A refresh is a
snapshot operation; it does not install a background monitor.

## Run a board card

Create and configure the card through T3. The alpha run path requires a fresh
`Ready` card with no existing implementation thread. T3 retains its configured
worker, review, repair, workspace, and approval policies.

```sh
scout integration t3 run --connection local --project <t3-project-id> \
  --card <t3-card-id> --request-id <unique-request-id>
```

The broker records a normal Scout ask before it calls T3's card runner. The
JSON response contains the normal conversation, message, flight, and work
receipt. Reuse a request ID only to recover that same receipt. Use the flight
ID to follow execution through Scout's normal status and wait commands.

Scout sends the card-run RPC once. T3's claim operation accepts only `Ready`
cards. If T3's scheduler claims the card first, Scout cannot claim the same
card again. If the run response is interrupted, a new thread appearing on the
board does not prove which caller started the thread. Scout records the
observation and leaves ownership unconfirmed instead of replaying the run.

After a confirmed run reaches `Review`, the Scout flight completes and reports
that human acceptance remains pending. The source card's Scout work record
stays in `review` with pending acceptance. `Done` projects source-reported
acceptance. A provider turn ending alone does not complete the board workflow.

Card observation uses a bounded 30-minute window. An unfinished run remains
waiting and can be reconciled from its retained delivery receipt. Reconciliation
never relaunches the card. Board cancellation and decisions remain with T3's
native UI. Scout cancellation stops tracking; an exact correlated thread can
be interrupted only when the adapter has verified that source turn.

## Shared board and workflow context

`WorkItemRecord.externalContext` adds optional source context to existing work
items. Existing work items need no external context.

| Source concept | Shared representation |
| --- | --- |
| T3 environment, project, and card | `source.adapterId`, `instanceId`, `projectId`, and `workItemId` |
| Board and column | `board.id` and `board.column` |
| Card status | `sourceState`, retaining the source spelling |
| Implementation, review, and repair | `workflow.stages` with source thread references |
| Current workflow stage | `workflow.activeStageId`, when the source identifies one |
| Human acceptance | `workflow.humanAcceptance`, independent of stage execution |
| Snapshot time | `observedAt` |
| Prerequisite cards | Scoped `depends_on` work relations, retaining source IDs |

T3 uses card states as its board columns. Scout preserves those states and
projects a separate Scout work state. `Review` projects to `review`, while
`Blocked` and `Needs Decision` project to `waiting` with the human dependency.
Source IDs are scoped by connection and project; equal card IDs from separate
environments do not identify the same Scout work item.

A card reaching `Review` keeps acceptance pending. An existing review thread
reference alone does not establish a passing verdict. T3 can also skip review
under approved Fast Mode. When the card records a review bypass, Scout marks
that stage `bypassed`.

T3 documents `Done` as the human acceptance gate. Scout projects a source
`Done` card as accepted. This observation does not prove who accepted the card
or when; the adapter does not invent decision provenance. Provider execution
state is not inferred from a board column.

The source intent brief remains available with the work item. Numeric source
priority and area/slice context are retained without translating an unspecified
priority scale into Scout's priority labels.

See the pinned [board contract](https://github.com/leonaaardob/t3-orchestrator/blob/46e35332722e6cc7da2dfb47a7b1f8795ab3b7e0/packages/contracts/src/agentBoard.ts)
and [workflow description](https://github.com/leonaaardob/t3-orchestrator/blob/46e35332722e6cc7da2dfb47a7b1f8795ab3b7e0/README.md)
for the source meanings.

## Broker API

The CLI sends these requests to the Scout broker. Credential values never
travel through these request bodies.

| Method and path | JSON body | Operation |
| --- | --- | --- |
| `POST /v1/integrations/t3/inspect` | `{ "connectionId": "local" }` | Read projects and threads |
| `POST /v1/integrations/t3/board` | `{ "connectionId": "local", "projectId": "..." }` | Read an existing project board |
| `POST /v1/integrations/t3/attach` | `{ "connectionId": "local", "threadId": "..." }` | Register the exact source thread as a Scout session |
| `POST /v1/integrations/t3/refresh` | `{ "connectionId": "local", "projectId": "..." }` | Refresh durable Scout work observations |
| `POST /v1/integrations/t3/run` | `{ "connectionId": "local", "projectId": "...", "cardId": "...", "requestId": "..." }` | Record a Scout ask and run a fresh Ready card once |

## Failure and recovery

The transport bounds connection time, request lifetime, frame size, and
buffered stream items. Authentication, remote errors, malformed source state,
disconnects, and timeouts remain explicit failures.

The transport sends a mutation once. If a connection drops after dispatch,
the execution outcome can be unconfirmed. Inspect the original Scout flight
and the exact T3 thread before issuing another request. A stream acknowledgement
does not prove that the requested work completed. The adapter does not promise
exactly-once execution.

After reconnecting, inspect the same connection and source thread. Retain the
Scout session and work IDs from the original receipts. Use `refresh` to obtain
a new board snapshot. Scout stores the external context with the durable work
record, so the source correlation survives reopening the control-plane database.

T3 retains its complete transcripts. Scout stores links and coordination
context rather than importing those transcripts as first-party messages.

## Verify against a real T3 environment

The opt-in live suite uses an actual T3 server and coding provider. Use a
disposable Git project with a configured provider, board, and implementation /
review presets. Provide an existing thread as the configuration template. The
suite creates separate source threads and a fresh card, writes proof files in
the fixture project and its T3 worktree, and runs an independent review. It
does not commit or publish the fixture work.

Set these variables, then run the test:

```sh
export SCOUT_T3_LIVE_URL=http://127.0.0.1:<t3-port>
export SCOUT_T3_LIVE_TOKEN_FILE=<private-file-containing-a-t3-access-token>
export SCOUT_T3_LIVE_PROJECT_ID=<t3-project-id>
export SCOUT_T3_LIVE_THREAD_ID=<template-t3-thread-id>
export SCOUT_T3_LIVE_PROJECT=<absolute-fixture-project-path>
export SCOUT_T3_LIVE_RECEIPTS=<existing-output-directory>
bun test packages/runtime/src/t3/broker.live.test.ts
```

The suite verifies exact-session dispatch, a broker restart during execution,
one correlated source request, the result in the original Scout conversation
and return mailbox, source-turn interruption, and a board run reaching the
human review gate. Repeating the card request with the same request ID must
return the same Scout invocation. Each broker is isolated and stopped by the
test harness. T3 setup and shutdown remain with the caller.

Without the live variables, these tests are skipped. Transport, source
correlation, persistence, projection, and cancellation unit tests remain
available under `packages/runtime/src/t3`.
