# Scout MCP API posture

Scout uses two verbs for task communication: `ask` and `reply`. The user-facing
noun is **task**. Internal records remain invocations, flights and work items.

## Choose a local tool profile

Both `scout mcp` (stdio) and `scout mcp serve` (shared HTTP) register **14
tools by default**. Unregistered tools are absent from `tools/list` and cannot
be called. A profile selects tools; it does not grant runtime permissions.
Opting into a group does not add it to Claude's default tool allowlist.

| Default tools | Use |
| --- | --- |
| `whoami`, `hosts_list`, `agents_search`, `agents_resolve` | Identify the sender and find a machine or recipient. |
| `ask`, `reply`, `current_reply_context`, `invocations_get`, `invocations_wait` | Start, answer or follow a task. |
| `messages_inbox`, `messages_channel`, `broker_feed`, `attachments_read` | Read recent broker context and inspect a supported attachment on an inbound message. |
| `show` | Put a local file on the operator's project canvas. |

Use `--profile full` to register all local tool groups. To add only
the tools you need, pass one or more group names separated by commas. Every
group adds to the default; selecting two groups gives you their union.

| Group | Additional tools |
| --- | --- |
| `aliases` | `aliases_list`, `aliases_resolve`, `aliases_set`, `aliases_repoint`, `aliases_unset` |
| `chat` | `chat_status`, `chat_catch_up`, `chat_ack` |
| `git` | `worktrees_changes`, `diff_read` |
| `integrations` | `integrations_setup`, `integrations_get`, `integrations_verify`, `integrations_manifest`, `integrations_start`, `integrations_pause`, `integrations_disconnect`, `integrations_resume`, `vercel_board_plan`, `vercel_board_dispatcher` |
| `mailbox` | `sessions_attach`, `sessions_get`, `sessions_poll`, `sessions_ack` |
| `operator` | `decision_read`, `feedback_send`, `post` |
| `routing` | `where`, `check`, `route_context` (also enables the Scout routing prompt) |
| `sessions` | `agents_start`, `card_create`, `session_attach_current`, `sessions_inventory`, `sessions_search`, `sessions_names`, `sessions_rename`, `tail_events` |
| `terminals` | `herdr_workspaces`, `rex_start_agent`, `rex_status`, `session_send` |
| `work` | `plays_list`, `plays_run`, `flight_cancel`, `labels_brief`, `labels_feed`, `work_update`, `work_retry`, `work_move`, `work_review`, `work_lifecycle`, `derived_read`, `derived_write`, `derived_pending` |

```sh
scout mcp --profile git,work
OPENSCOUT_MCP_PROFILE=sessions scout mcp serve
scout mcp install --host codex --profile full --force
```

The flag overrides `OPENSCOUT_MCP_PROFILE`; `--profile default` explicitly
selects the 14 tools. Use `full` on its own. Unknown names and empty selections
are errors. The deprecated `invocations_ask` requires **both** `full` and
`OPENSCOUT_EXPOSE_DEPRECATED_INVOCATIONS_ASK=1`; prefer `ask`.

A stdio install saves an explicit selection (flag or environment) in the
host entry. Codex stores it in the MCP server's environment so Scout-managed
sessions keep it when they supply their own launcher. Other hosts store it in
the launch arguments. Without a selection, Scout uses the environment passed
by the host. Use `--force` to replace an existing entry.

A shared install saves one profile for all clients. For example,
`scout mcp install --shared --profile git` enables the default tools plus the
two Git tools. Reinstalling without a selection keeps the shared profile. To
change it, run `scout mcp install --force` to switch hosts back to stdio,
let the old sessions exit and the shared server drain, then install the new
shared profile. A session cannot enlarge the server's tool list at call time.

The hosted gateway uses its own `mcp:core` catalog. Local flags and environment
settings do not change that contract.

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
for discovery, `broker_feed` for broker records, and the `sessions` group's `tail_events` for observed harness activity.
Transcripts are not Scout messages. The `work` group includes `work_update`
for work not tied to a task.

The protocol catalog in `packages/protocol/src/mcp-core-tools.ts` defines the
hosted core tool set. Removed sending tools have no deprecated definitions.
Old CLI sending verbs are reserved tombstones that print replacement commands
and never deliver. Runtime and web transport routes remain unchanged; uncertain
old dispatches reconcile under their original operation. Upgraded callers
require the target runtime's `ask-reply/1` capability before dispatch.

See [agent communication rules](agent/scout-comms.agent.md) and
[the accepted contract](plans/ask-and-reply.md).
