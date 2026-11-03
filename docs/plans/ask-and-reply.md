# Two verbs: ask and reply

Status: Accepted 2026-10-16; in progress on `ask-reply-verbs`. Revision 4, 2026-10-28. Revisions 1 to 3 had two review rounds by Codex and Fable.
Date: 2026-10-16
Supersedes: `send-default-tracked-work.md`

## Revision 4

- **Moved to core.** The change is the CLI, the runtime, MCP and the Scout skill, which live in this repository since the core split. File references use current paths and no line numbers.
- **The noun is "task".** The operator decided on 2026-10-24 that the thing an agent was asked to do is a task. CLI and MCP copy say task. "Flight", "invocation" and "work item" stay in code and the record schema.
- **Explicit completion already exists.** The 2026-10-18 explicit-completion change shipped typed progress and final replies (`messages_reply`, `/v1/messages/reply`) and the joined-work flags `--completion explicit`, `--join-to` and `--continue-for`. `reply` is the CLI and MCP surface over that path, not a second one. `--continue-for` admits a child to an active parent; `--continue` starts a successor to a finished task. They are different contracts: both stay, and they cannot be combined.
- **Removed names must be reserved.** An unknown first word is an implicit ask. Core already keeps reserved names out of that path (`packages/cli/src/cli/command-unavailable.ts`). Each removed verb is reserved the same way, or `scout tell x` would silently become an ask.
- **Two defaults stand** unless the operator changes them: a 30-minute default-action window, and `reply --progress` writing the task's work record.
- **Core first.** Core ships the verbs, the runtime behavior and MCP. The apps adopt them in a separate change afterwards; see Ships together.

## Problem

Scout has nine ways to send something: `ask`, `tell`, `send`, `send --tracked`, `operator`, `notify`, `broadcast`, `speak` and `chat say`. Agents must pick the right verb before Scout can track the work, and they pick wrong. The operator reports agents sending tasks with `send` and `tell`, so the work is never tracked and never answered.

## Evidence

Every real delegation call in the operator's primary host's Claude Code and Codex transcripts, August to October 2026. Only calls where `scout` starts the command are counted; grep patterns, fixtures and `--help` are excluded. Bodies were hand-checked.

| Method | Real calls | Share |
| --- | --- | --- |
| `ask` (MCP 169, CLI 112) | 281 | ~85% |
| No-reply message (`send`, `tell`, `messages_send`) | ~21 | ~6% |
| Reply to an ask | ~21 | ~6% |
| Reach the operator (`notify_operator`, `scout notify`) | ~19 | ~5% |
| `broadcast`, `speak`, `send --tracked`, `chat say` | ~1 | ~0% |

The ~21 no-reply messages:

- **~10 were about work already in flight:** addenda, scope changes, course changes, corrections, cancels, "stop, wrong machine".
- **~6 were true FYIs.**
- **~3 were new work sent as a message.**

Conclusions:

1. Agents do not use the variety.
2. Most non-ask traffic is a follow-up on an existing task.
3. A pure FYI is rare enough to be a deliberate flag.
4. Answering is the other half of every task, and it needs its own verb.

Limits: one host, two harnesses. Other hosts, Kimi and Grok were not counted.

## The two verbs

| Verb | Who uses it | Effect |
| --- | --- | --- |
| `scout ask` | Anyone sending something: new work, a follow-up on a task, a question for the operator, an FYI | Creates or updates a task; an FYI creates only a message |
| `scout reply` | The recipient of a task | Answers it. A final reply closes the task |

Everything else is a flag. There is no positional recipient and no reserved word.

```
scout ask --to codex "review the parser"
scout ask --project ../talkie --harness claude "review the spec"
scout ask --on build-box --project ~/app --harness codex --model gpt-5.5 "run the suite"
scout ask --ref inv-123 "scope change: skip the tests"
scout ask --ref inv-123 --cancel "wrong machine"
scout ask --continue inv-123 "now port the fix to iOS"
scout ask --operator "Ship to prod?" --option yes --option no
scout ask --operator --default-action "deploy to staging" "Staging or prod?"
scout ask --operator --fyi --notify "Prod is down" --image ./graph.png
scout ask --channel shared --fyi "Deploy done"

scout reply --ref inv-123 "Two findings, one blocking: auth/refresh.ts:42"
scout reply --ref inv-123 --progress "Tests pass; starting the port"
```

## `ask`: routing

Every `ask` uses exactly one of four routing modes:

| Mode | Flags | Meaning |
| --- | --- | --- |
| Recipient | `--to <agent>`, `--operator`, or `--channel <name>` | A named recipient |
| Capability | `--project`, with `--harness`, `--model`, `--effort` and `--on` | No named recipient; the runtime resolves or starts a worker, as `ask` does today |
| Existing task | `--ref <task>` | About an unfinished task; its recipient is unchanged |
| Successor | `--continue <task>` | New work that builds on a finished task; see `--continue` |

The modes are mutually exclusive. `--to` may repeat; each target gets its own task and its own receipt, and partial success is reported per target. Per-target idempotency derives from the caller's request ID plus the target.

### `--ref`: follow-ups on an existing task

`ask --ref` adds context to a task that is not finished: an addendum, a scope change or a correction. It creates no new work.

| State of the referenced task | Behavior |
| --- | --- |
| Queued | The follow-up is attached; the worker sees it with the original |
| Running | Delivered into the working session as a follow-up message |
| Finished, failed or cancelled | Rejected: `task inv-123 is finished; to start follow-up work use --continue inv-123` |
| Finishes while the follow-up is in transit | The runtime decides by its own ordering: if the task closed first, the follow-up is rejected as above and its receipt says so |
| Remote | Forwarded to the task's home node, under the same rules |

Accepted handles are invocation and flight IDs, and the message ID of a task. Short binding refs (`5-7241lu`) are accepted while their binding is retained. An FYI's message ID is rejected: there is no task to follow up. Use `--to` with a new ask. Only the original asker, the operator, or a participant in the task's conversation may follow up. Each follow-up returns its own receipt and is idempotent by task ID.

A follow-up text never cancels anything, whatever it says. Cancelling is the explicit flag `ask --ref <task> --cancel "reason"`. It is authorized for the asker and the operator, and the receipt reports whether the worker was actually interrupted.

### `--continue`: new work from a finished task

`ask --continue <task> "…"` starts new tracked work, using the earlier task's outcome as context. This is today's "continue from that result" behavior (`packages/cli/src/cli/commands/ask.ts`), now spelled explicitly so it is never confused with `--ref`.

- **Qualifies:** completed, failed and cancelled tasks. The context includes the outcome and its state. Unfinished tasks are rejected; use `--ref`.
- **Recipient:** the same agent, in a fresh session by default. Execution flags (`--harness`, `--model`, `--on`) may override it.
- **Authorized:** the original asker and the operator.
- **Idempotent:** by the caller's request ID, like any ask.

### `--operator`: asking the person

An operator ask is a human-owned task. It gets the same durable handle as any task: `scout wait` works on it, and the answer comes back as a `reply`. "Tracked until answered" means tracked until a terminal outcome: answered, proceeded with default, expired or cancelled. Today, operator questions are attention signals (`operatorSignal.kind: "need"`, `packages/cli/src/cli/commands/operator-question.ts`) with no flight. The runtime must give them a task lifecycle: open, answered, expired.

| Form | Meaning |
| --- | --- |
| `--operator "…"` | A question the work is blocked on. The operator owes an answer. The call still returns on acceptance; block with `scout wait` |
| `--operator --option a --option b "…"` | The answer is a pick, answered in one tap |
| `--operator --default-action "X" "…"` | Proceeding with X unless the operator says otherwise. The asker does not block, and a reply is optional. If no answer arrives within the answer window (default 30 minutes; `--window` sets it), the task completes as `proceeded with default`. A later answer is delivered to the asker as a follow-up, marked late. Replaces `consult_operator` |
| `--operator --fyi "…"` | News, with no answer expected |
| `--permission`, `--because` | Unchanged; the task carries them as metadata |

### `--fyi`: no answer expected

`--fyi`: no answer expected; a durable message with no work record. Without it, every ask is tracked until answered.

An FYI creates no invocation, flight or work item. It keeps its durable message and delivery records, and returns message and delivery handles, not a task handle.

### `--notify`: push to the operator

`--notify` pushes to the operator's devices. It is valid only with `--operator`.

| Operator message | Notification |
| --- | --- |
| Blocking question (`--operator`, with or without `--option`) | Always requested. Agents cannot forget, and the site promises it ("when an agent needs a decision, your phone gets it") |
| `--operator --default-action …` | Requested at normal priority |
| `--operator --fyi` | None. It lands in Requests and on the board |
| `--operator --fyi --notify` | Requested at interrupting priority: news worth breaking in for |

"Requested" means Scout attempts the notification. Whether it appears still depends on device permissions, the operator's settings and the transport. A receipt reports recording and notification status separately. Notification policy is stored on the durable record (the task, or the message for an FYI) and enforced by both consumers: APNs (`packages/runtime/src/broker-operator-attention-service.ts`) and the macOS attention center in the apps. Today both notify for every operator signal kind, so this is new work.

### Channels

`--channel` is FYI-only for now: `ask --channel shared --fyi "…"`. A tracked task to a channel is rejected until ownership is designed: one answer versus every member, and membership captured at submission.

### Receipts and waiting

Every `ask` returns after the runtime accepts it. Exit status 0 means accepted, never completed. The JSON receipt carries the task handle and routing; the eventual outcome arrives separately. To block until the outcome, run `scout wait <handle>`. When the asker has no live reply session, the outcome is recorded on the task and in the asker's inbox.

The CLI defaults to inline today and MCP to notify (`packages/cli/src/cli/commands/ask.ts`; `packages/cli/src/mcp/scout-mcp.ts`). Both become "return on acceptance". Scripts that relied on the inline CLI wait add `scout wait`. MCP keeps an explicit inline option.

## `reply`: answering

`scout reply --ref <task> "…"` is how the recipient of a task answers it. Today's CLI path is `scout tell --ref`.

| Form | Effect |
| --- | --- |
| `reply --ref X "…"` | The final answer. Closes the task as completed and delivers to the asker |
| `reply --ref X --progress "…"` | An interim update. The task stays open |
| `reply --ref X --failed "…"` | Closes the task as failed, with the reason |
| `reply --ref X --image ./shot.png "…"` | Attach evidence |
| `reply --to <message> "…"` | A plain conversation reply, with no task lifecycle. Replaces the conversation half of `messages_reply` |

Rules:

- Only the task's current recipient (agent, session or operator) may answer a task. The operator's taps in the apps are replies.
- Replies are idempotent by the caller's request ID.
- The first final reply (`reply` or `--failed`) wins. Later final replies are rejected with the task's terminal state.
- A reply that races a cancellation loses if the cancellation was recorded first, and is reported as `task was cancelled`.
- **Automatic answers stay.** When a harness ends its turn on a task, the runtime still captures that final response as the answer (`packages/runtime/src/local-agents.ts`). An agent calls `reply` only to answer from somewhere other than its final turn, or to send progress. It never answers twice.
- `reply --progress` writes the task's work record. `work_update` remains only for work that is not tied to a task.

## Validation

Parsing is strict. Unknown flags are errors, never message text. Today `ask` folds unknown flags into the body, which is how `--message-file` became literal text. With one verb and more flags, this is a precondition.

| Combination | Result |
| --- | --- |
| More than one routing mode | Error |
| `--option` with `--fyi` | Error: a pick needs an answer |
| `--option` without `--operator` | Error, for now |
| `--notify` without `--operator` | Error: `--notify now pushes to the operator; asks return on acceptance by default` |
| `--notify` on a blocking `--operator` ask | Accepted; it already pushes |
| `--fyi` with `--ref`, `--continue`, `--cancel` or capability routing | Error |
| `--cancel` without `--ref` | Error |
| `--default-action` without `--operator`, or with `--fyi` | Error |
| `--channel` without `--fyi` | Error, for now |
| `--image` | Valid with any recipient |
| `--default-action` with `--option` | Accepted: the default must be one of the options |
| `--default-action` with `--permission` | Error: a permission request blocks by definition |
| Execution flags (`--harness`, `--model`, `--effort`, `--on`, `--project`) with `--ref` or `--fyi` | Error |
| `reply` without `--ref` or `--to` | Error |
| `reply --progress` with `--failed` | Error |
| `reply --ref` or `ask --ref` against an FYI's message ID | Error: an FYI has no task |

All validation happens before reservation or delivery.

## Removed

These verbs are deleted, with no aliases. Each exits non-zero and prints the caller's own arguments rewritten into the replacement. Where the old form was ambiguous, it prints every candidate and never guesses:

| Removed | Error names |
| --- | --- |
| `scout tell --to X "…"` | `scout ask --to X --fyi "…"` |
| `scout tell --ref R "…"` | All three: `scout reply --ref R "…"` (answering; a final reply closes the task), `scout reply --ref R --progress "…"` (an update), `scout ask --ref R "…"` (a follow-up from the asker) |
| `scout send --to X "…"` | `scout ask --to X "…"`, or add `--fyi` |
| `scout send --tracked …` | `scout ask …` |
| `scout operator "…"` | `scout ask --operator --fyi "…"` |
| `scout operator --question "…" --option …` | `scout ask --operator "…" --option …` |
| `scout notify --message "…" --image …` | `scout ask --operator --fyi --notify "…" --image …` |
| `scout broadcast "…"` | `scout ask --channel shared --fyi "…"` |
| `scout speak "…"` | `scout ask --operator --fyi --notify "…"`. Sender-controlled speech is removed; speaking aloud is the operator's device setting |
| `scout ask --to X --notify …` (old meaning: return on receipt) | Error naming the new meaning; asks return on acceptance by default |

Not part of this change: `wait`, `flight` (following tasks), `chat` (rooms) and `match` (codename rendezvous). `work_update` stays for work that is not tied to a task; see `reply`.

## MCP

- `ask` gains `operator`, `channel`, `ref`, `continue`, `cancel`, `fyi`, `notify`, `defaultAction`, `options[]` and `image`. `replyMode` stays for explicit inline waits. Its value `"notify"` is the legacy spelling of "return on acceptance"; keep it, and document that it is unrelated to the `notify` flag.
- `reply` replaces `messages_reply` and `sessions_reply`, with `ref`, `progress`, `failed`, and `to` for plain conversation replies (`packages/cli/src/mcp/scout-mcp.ts`).
- `messages_send`, `notify_operator` and `consult_operator` are removed. Their descriptions are deleted, not deprecated, so models stop choosing them.

## Unchanged

- **Transport APIs.** Removing CLI and MCP verbs does not remove runtime or web delivery routes. The apps compose through `/api/send`, and that route stays unless it is versioned and migrated separately.
- **Persisted dispatches.** An old uncertain dispatch is never replayed under a newly translated payload. Old journal entries reconcile under their original operation.

## Mixed versions

Installed clients, running MCP sessions and fleet peers cannot all upgrade at once:

- Removed CLI verbs stay as explicit tombstones, the errors above, for at least two releases.
- The runtime publishes a capability version. Checking happens on the upgraded side: before dispatch, the caller's home runtime checks the target's advertised capability and refuses locally with a version error. An old peer is never expected to understand, or reject, semantics it predates.

## Ships together

### Core

1. CLI: `ask` routing modes and flags, `reply`, strict parsing, the validation matrix, the removed verbs reserved with their errors, help and examples.
2. Runtime: human-owned operator tasks, `--ref` follow-up and cancel semantics, `--continue`, FYI records with no work, and notification policy metadata.
3. MCP: the tool set above, plus the server instructions.
4. APNs enforces the stored notification policy (`packages/runtime/src/broker-operator-attention-service.ts`).
5. Every core caller of a removed name, checked off: the runtime-injected collaboration instructions (`packages/runtime/src/collaboration-contract.ts`), the harness tool allowlist (`packages/runtime/src/local-agents.ts`), the parser tests that reject repeated destinations (`packages/cli/src/cli/options.test.ts`) and the MCP operator tools (`packages/cli/src/mcp/scout-mcp.ts`). Then a grep of the repository and the base and supervisor scripts for every removed name.
6. The Scout skill (`.agents/skills/scout/SKILL.md`): two verbs, routing modes, `--fyi` is deliberate, follow-ups use `--ref`, and answers use `reply`. Also the README, `docs/agent/scout-comms.agent.md` and `llms.txt`.
7. Tests:
   - Each removed verb prints the rewritten command and never falls through to an implicit ask.
   - Every row of the validation matrix.
   - `--fyi` creates no invocation, flight or work item.
   - `--ref` covers each task state.
   - `--cancel` reports whether the worker was interrupted.
   - `reply` closes and `--progress` does not; the first final reply wins.
   - An automatic final answer and an explicit `reply` never both land.
   - `--continue` on completed, failed and cancelled tasks, and `--continue` with `--continue-for` is an error.
   - `--default-action` completes as `proceeded with default` at the window.
   - Operator tasks have a lifecycle.
   - The notification policy is enforced in APNs.

### Apps, after core lands

The apps adopt the new verbs in their own change: the macOS attention center enforces the stored notification policy; Scoutbot's MCP proxy, dispatch journal, role instructions and tests move to `ask` and `reply`; the CLI reference, the agent docs and `llms-full.txt` are regenerated; and the site's Scout bands switch to the new flags once released.

### Plugins

Each `*-scout` plugin that calls a removed name moves to `ask` or `reply` after the core release.
