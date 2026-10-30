# Operator Attention And Unblock

Scout should treat "needs the human" as a first-class product state, not as a side effect of whichever harness happened to print the prompt.

This doc records the current posture and the next implementation steps for approvals, questions, waiting states, permission prompts, and notifications.

## Principle

Scout can only own data that enters Scout. Session events, broker messages, collaboration records, and Scout-created invocation state are first-party data. Native harness prompts that happen above Scout, such as an MCP client asking whether to allow a tool call, are not visible until the host forwards them or exposes a hook.

The operator-attention model should make that boundary explicit:

- Project attention from first-party session state when Scout already sees the event.
- Ingest host-level permission prompts through a host integration, not by pretending the MCP server can see a request that the host intercepted before the server was called.
- Record durable broker unblock requests for anything that can outlive a single session frame.
- Route notifications from the runtime/session attention model, with dedupe and clear ownership.

The Shared Interaction Model defines
the target handoff contract across Scout and external personal-agent interfaces:
one decision reference, an explicit next actor, action or artifact revision
binding, verified response authority, and a result returned to the waiting work.
Each surface presents the same decision according to its audience. Displaying
or dismissing it does not answer it. These are design requirements; current
coverage below does not yet provide the complete cross-surface lifecycle.

## Agent-Originated Non-Blocking Signals

Long-running agents also need a way to communicate without manufacturing a
block. Scout exposes two MCP tools for that attention-plane traffic:

- `notify_operator({ message })`: a useful one-way FYI. The agent continues and
  does not request a response.
- `consult_operator({ question, defaultAction })`: optional advice. The agent
  continues with the declared default unless the operator replies soon enough
  to influence later work.

Both are runtime-backed durable messages to the operator. The runtime message id
is also the signal id, so ordinary threaded replies provide correlation without
creating a second consultation state machine. Neither tool creates a flight,
changes a work item, or marks the agent waiting. The tool confirms when that
message is recorded; mobile or desktop notification delivery remains
best-effort and unconfirmed at call time.

The boundary is strict: if there is no responsible default, the agent must use
a real human-input or waiting path. Only `needs_input` may block. A late reply
to a non-blocking consultation is steering; it does not retroactively change
the task lifecycle.

## Alertable Events

Session attention already covers:

- `approval`: an action block is awaiting approval and can be approved or denied.
- `question`: an agent question is awaiting an answer.
- `failed_action`: a recent action failed.
- `failed_turn`: a recent turn failed.
- `session_error`: the session itself is in error.
- `native_attention`: adapter/provider metadata says the native harness needs input.

Broker and collaboration attention should cover:

- `question.open`: an answer is owed.
- `question.answered`: the asker needs to close or reopen.
- `work_item.waiting`: a named dependency or actor owns the next move.
- `work_item.review`: a reviewer owes accept/reopen feedback.
- `flight.failed` / `flight.cancelled`: an ask did not complete.
- `flight.completed`: notify only when the caller requested callback semantics.

Host-level unblock attention still needs explicit ingress:

- Codex approval prompts raised by the Codex host.
- Claude permission prompts raised by the Claude host or companion integration.
- MCP client pre-tool permission prompts.
- Local system permissions needed by Scout itself, such as notifications or APNs setup.

## Attention Retirement

Attention means a human is blocking work now, not that a collaboration record
was alertable at some point in its history. The web fleet projection therefore
retires collaboration-record attention when the record has not moved for seven
days (`ATTENTION_STALE_AFTER_MS`). A retired record keeps its state, history,
and conversation link and remains available through work and follow surfaces;
retirement neither deletes it nor changes a runtime-owned record.

The projection applies this age bound to every eligible collaboration state,
including `waiting` and `review`. Any later runtime-owned movement updates the
record and, if it remains otherwise alertable, makes it eligible for attention
again. Rows with the same title and owner are collapsed after the age bound,
keeping the most recently updated live row, so an old duplicate cannot hide a
current handback.

## Current Coverage

Implemented now:

- Runtime session attention projection exists in `packages/runtime/src/session-attention.ts`.
- Runtime-owned durable `unblock_request` records and events remain a planned
  integration boundary. The current protocol/runtime source does not expose
  that lifecycle; MCP feed schemas mentioning the kind are not an implementation.
- Mobile bridge inbox now uses session attention instead of approvals only.
- Bridge websocket now emits `operator:notify` for any projected session attention item.
- APNs alert routing now sends inbox alerts for any projected item.
- iOS Inbox can decode and display approvals, questions, failures, session errors, and native attention.
- Approval actions remain approve/deny.
- Non-approval attention items provide `Open Session` and local `Dismiss`, following the no-dead-end UI rule in `docs/eng/no-dead-end-ui.md`.
- The iOS tRPC route map includes `question/answer`, so timeline question blocks can use the existing answer-question bridge path.
- Scout MCP `ask` supports `replyMode: "notify"` and emits `notifications/scout/reply`.
- The optional [Linux Omarchy notification observer](linux-desktop.md) presents
  live broker communication, declared operator needs, delivery failures,
  operator-owned collaboration waits, and requested completion callbacks.
  It has separate inbound/outbound, attention, scope, and preview controls.
- Scout MCP exposes `notify_operator` and `consult_operator`; the latter
  requires a safe default. Both write operator messages without creating a
  flight, and the runtime can fan out a generic APNs alert without putting agent
  content in the push payload. The relay preserves opaque conversation/message
  correlation and keeps these non-blocking alerts quiet.
- Web operator attention reads pairing-session approvals and collaboration
  attention. It must not be described as reading durable broker unblock requests
  until that record lifecycle exists.
- Managed Claude sessions rely on host or companion permission capture; Scout
  does not install Claude project hooks.
- Active managed Claude tmux sessions project a currently visible permission
  confirmation from the pane into web agent and operator attention. This is a
  live host projection, not a durable broker record.

Not done yet:

- Answering `question` items from the iOS Inbox.
- Host-level capture beyond managed Claude tmux and owned Codex command/file
  approval requests, including non-tmux Claude, attached foreign Codex, ACP
  attention bridging, and MCP client permission prompts.
- General desktop/web notification sinks for session attention beyond the
  optional Linux broker-event observer.
- Cross-device read/dismiss/decision synchronization beyond the current inbox item refresh. Current non-approval dismiss is intentionally local-only.
- Dedicated desktop/web signal presentation, coalescing, and per-agent signal
  policy beyond the existing push-relay rate limits.

## Practical Recovery Guidance

When an operator prompt appears stuck, first classify where the prompt lives:

- Scout-owned session question or action approval: answer or decide it through
  the Scout surface that rendered it.
- Broker unblock request: use the rendered action, or inspect the request by id
  before dismissing it.
- Host-side approval prompt: open the host UI or rely on a host integration that
  forwards the prompt into Scout. An MCP server cannot observe a prompt the host
  intercepted before the tool call reached the server.
- Long-running agent work: mark the work item or flight waiting with the human
  or dependency as next owner instead of leaving the caller blocked.

## Durable Unblock Model

Planned: runtime-owned unblock records for human actions that may outlive a
single websocket frame. This record lifecycle is not implemented in the current
protocol/runtime. Existing session attention and collaboration records remain
the implemented foundations; the fields below describe the target model.

Fields include:

- `id`
- `source`: `session`, `broker`, `host`, or `system`
- `kind`: `approval`, `question`, `permission`, `waiting`, `review`, `failure`, or `setup`
- `status`: `open`, `notified`, `resolved`, `denied`, `expired`, or `dismissed`
- `ownerId`: usually `operator`
- `sourceRef`: session/turn/block, flight, work item, or host request ids
- `title`, `summary`, `detail`
- `risk`
- `actions`: typed action affordances such as approve, deny, answer, open, retry, or dismiss
- `createdAt`, `updatedAt`, `resolvedAt`

The session inbox can continue projecting lightweight items, but durable host and broker waits should be represented by this record so a reconnect, another device, or a later agent can reason about what is still open.

## Implementation Path

1. Keep session attention as the fast path for first-party pairing events.
2. Expand broker attention/unblock projection from collaboration records and flights.
3. Expand host ingress for permission prompts:
   - Codex: surface host approval requests into Scout as unblock records.
   - Claude: use a host integration that forwards permission prompts without a
     project-wide pre-tool gate.
   - MCP: document that server-side tools cannot see client-side approval prompts unless the host forwards them.
4. Route all unblock records through a notification router:
   - `interrupt`: approval, question, host permission, failure.
   - `badge`: requested completion callbacks, review-needed, waiting states.
   - `silent`: ordinary progress/status.
5. Add action handling:
   - approvals call existing `actionDecide`.
   - questions call existing answer-question plumbing, with Inbox needing structured options before it can answer in-place.
   - host permissions call host-specific grant/deny callbacks.
   - work/review items call collaboration update APIs.
6. Add stale sweeps for `waiting`, `review`, and unresolved host permissions.

## Managed permission requests

Scout-driven Claude tmux and owned Codex app-server invocations have a runtime
permission bridge. `BrokerPermissionService` writes a durable `question` record
with `metadata.permissionRequest`, containing the exact visible prompt or native
request parameters, project root, live session, invocation, flight, version and
available decisions. The flight is `waiting` with `waitingOnPermission: true`.
The existing operator-signal push path carries the prompt through its sealed
paired-device notification; APNs alert text and custom payload remain generic.

`POST /api/operator-attention/permissions/decide` forwards
`{ requestId, version, decision: "once" | "project" | "deny" }` to the
machine-local runtime route `POST /v1/permissions/decide`. The runtime owns the
pending live callback, records an actuation attempt, rejects duplicate/stale
answers, and sends only to that process. The Requests page and Scoutbot share
this API through `useRequestActions`. No background resume, fork, or project hook
is installed.

A runtime restart loses the live callback. Each record names the node that wrote
it, and the runtime reconciles the open records of its own node that no process
waits on: once at startup, then every minute. If the session's pane still shows
the same prompt (compared without the cursor), the runtime rebinds the record to
that pane and watches it until the prompt is answered or leaves. The flight that
raised it has ended, so an answer goes only to the session. Otherwise the runtime
declines the record and records why. A decision on a record with no waiter tries
the same rebinding first. When nothing can answer the request, the route returns
`410` with `outcome: "ended"` and `sessionOpen`. A record with a recorded
actuation attempt is never rebound, and the sweep never touches records from
another node.

The operator can always end an open request to them. `POST
/v1/operator-requests/dismiss` with `{ requestId }` is machine-local like
decide. It declines the record with the answer "Dismissed by the operator" and
sends nothing to any session. It takes permission requests, including one whose
session lookup keeps failing or one from a node that is gone, and the
`operator-question:` records of questions agents ask the operator. A permission
request that a session still waits on is refused with `409`: answer it with a
decision instead. A record that is already settled returns `410` with
`outcome: "ended"`.

Permission scope is not invented:

- Claude folder trust offers **Allow for project** and **Deny**. Claude persists
  trust itself; presenting that choice as **Allow once** would be misleading.
- Claude tool dialogs offer **Allow once** and **Deny**; **Allow for project** is
  exposed only when the live native menu explicitly offers project/folder/
  directory-scoped permission (including the exact project path). Switching to auto mode is not a project grant.
- Codex command/file approval requests offer **Allow once** and **Deny**.
  `acceptForSession` is not relabeled as a project grant. Scout does not write a
  persistent Codex policy amendment in this bridge.

### Capture and answer map

| Harness / surface | Detection and current boundary | Live answer path |
| --- | --- | --- |
| Claude folder trust, managed tmux | `local-agents.ts`: `waitForReadyComposer`, `tmuxPaneTailBlockingHarnessDialog`; `tmux-permission.ts`: `parseTmuxPermission`. Human wait does not spend the boot deadline. | Re-read the bound pane, select the visible trust/exit choice, `tmux send-keys`; confirm the prompt leaves before continuing startup. |
| Claude tool approvals, managed tmux | `parseTmuxPermission` uses `continuation/dialog.ts`; capture during dispatch verification and reply polling. Unparsed dialogs stay native. | Revalidate the visible dialog fingerprint, send its offered choice to the bound live pane, verify disappearance. |
| Claude, Herdr | Web `herdr-host-attention.ts` and `herdr-continuation.ts` already parse blocked panes. Not ingested by this runtime permission bridge. | Existing `herdr-permission-answer.ts`: `answerHerdrPermission`, audited/revalidated `herdr agent send-keys`; currently a separate path. |
| Claude stream JSON / pairing adapter | Runtime `claude-stream-json.ts` observes result `permission_denials`; Claude adapter spec declares no normalized approval decision channel. Not an interactive permission bridge. | Needs a native bidirectional control channel; cannot turn a terminal denial/result into a live grant. |
| Codex, Scout-owned app-server | Agent-sessions `local/transports/codex-app-server.ts`: `handleServerRequest`, runtime `codex-app-server.ts`: bound `onPermissionRequest`. Command/file approval requests are held instead of receiving an unsupported-request error. | Reply to the same JSON-RPC request id on the existing stdio transport; bind thread/turn/request identity. Attached foreign app-servers are excluded. |
| ACP: Grok / OpenCode / Kimi / Devin / Cursor | Agent-sessions `adapters/acp/adapter.ts`: `handlePermissionRequest` supports interactive, safe-reject, and auto-approve policies. Kimi/Devin broker invocations currently auto-approve; Cursor safe-rejects. Grok/OpenCode use adapter defaults. No new bridge in this slice. | Adapter `decide` answers `session/request_permission` on the existing ACP process. Policy changes and attention ingestion remain separate work. |
| Grok tmux and Claude Ghostty / unowned terminals | `local-agents.ts` checks Grok composer readiness and delivers to attached terminals, but has no permission parser for these surfaces. This bridge does not inject hooks or scrape arbitrary foreign sessions. | Native host input; a future explicit host integration must bind a live prompt before sending keys. |
| Pi RPC and unowned terminal/client prompts | No permission request ingress in `pi-rpc.ts`; unowned MCP client prompts remain invisible to the server. | Native host UI or an explicit host-owned integration; no hooks injected into foreign sessions. |

`scout operator --question/--permission` now also writes a collaboration question
linked to its durable message. The existing declared-message Requests projection
and offered-answer reply path remain; a threaded operator reply closes the
collaboration record. This manual question is not authority to grant a native
harness permission and does not manufacture a waiting flight.
