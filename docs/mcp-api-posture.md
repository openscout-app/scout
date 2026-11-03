# Scout MCP API posture

Scout uses two verbs for task communication: `ask` and `reply`. The user-facing
noun is **task**. Internal records remain invocations, flights and work items.

## First collaboration

1. Call `ask({projectPath, harness, body})` for fresh work. Use `to` for a known
   recipient, or `on` with the path on another mesh host. Do not invent agent names.
2. Keep the receipt's task, message and delivery handles. Acceptance is not
   completion. Reuse `requestId` after an uncertain result.
3. Follow the task with `invocations_get` or `invocations_wait`. A wait timeout
   ends only the caller's wait; it does not cancel the task.
4. Add context with `ask({ref, body})` while the task is unfinished. Cancel
   explicitly with `cancel: true`; text never cancels.
5. After completion, failure or cancellation, `ask({continue: ref, body})`
   starts a successor with the previous outcome as context.

Use exactly one route: `to`, `operator`, `channel`, capability
(`projectPath`/runtime), `ref` or `continue`. Channels require `fyi: true`.
A deliberate FYI creates only a durable message, with no invocation, flight or
work item. Unknown fields are errors.

## Answering

`reply({ref, body})` sends the final answer and completes the task.
`progress: true` writes its work record without closing it; `failed: true`
closes it as failed. Only the current recipient may answer. The first final
wins, including races with an automatic harness final or cancellation.

A captured harness final is already an answer; do not call reply as well.
For explicit-completion tasks, wait for joined work and refresh
`current_reply_context` before the final. `reply({to: messageId, body})`
is a plain conversation reply without a task lifecycle.

External mailbox deliveries include a task ref and a correlated return address.
Copy that address into `reply`; it retains session ownership and token checks.
The runtime's existing external-session HTTP transport remains available.

## Operator tasks

- `ask({operator: true, body})` creates a human-owned task and requests a push.
- `options` offers choices. `permission` and `because` carry permission metadata.
- `defaultAction` lets work proceed. At the answer deadline (default 1800
  seconds; `window` overrides it), an unanswered task completes as
  `proceeded with default`. A late answer is marked late, not substituted
  for that outcome.
- `fyi: true` is news with no task. Add `notify: true` only for news worth
  interrupting. Default-action tasks request normal priority.
- Recording and notification status are separate. A requested push remains
  unconfirmed and depends on device permission, settings and transport.

## Waiting and other tools

Both CLI and MCP asks default to returning on acceptance. MCP retains an
explicit `replyMode: "inline"` wait. The legacy value `"notify"` means
acceptance and is unrelated to operator `notify`.

Use `whoami` when identity is unclear, `agents_search` and `agents_resolve`
for discovery, `broker_feed` for broker records, and `tail_events` for observed
harness activity. Transcripts are not Scout messages.
`work_update` remains for work not tied to a task.

The protocol catalog in `packages/protocol/src/mcp-core-tools.ts` defines the
default core tool set. Removed sending tools have no deprecated definitions.
Old CLI sending verbs are reserved tombstones that print replacement commands
and never deliver. Runtime and web transport routes remain unchanged; uncertain
old dispatches reconcile under their original operation. Upgraded callers
require the target runtime's `ask-reply/1` capability before dispatch.

See [agent communication rules](agent/scout-comms.agent.md) and
[the accepted contract](plans/ask-and-reply.md).
