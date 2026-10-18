# Scout Comms Agent Notes

Source: `docs/scout-comms.md`.

Status: current v0 integration guidance, not frozen public API.

Verified: 2026-09-02

## Mental Model

Scout comms are protocol-shaped but not a standalone wire protocol.

| Concept | Scout Equivalent |
|---|---|
| method | interaction intent: message, invocation, task, summary, status, wake |
| headers | explicit routing/reply/work context fields |
| body | message/task payload |
| response | broker receipt, flight state, reply message, work transition |
| authority | local broker canonical writes |

## Integration Rule

External clients submit structured intent to the broker and render broker-owned
records. They do not infer routing from body mentions or external harness
transcripts.

## Core Records

| Record | Type |
|---|---|
| conversation | `ConversationDefinition` |
| message | `MessageRecord` |
| session | opaque broker `sess.*` handle resolving to a harness context and endpoint |
| delivery | `ScoutDeliverRequest`, `ScoutDeliveryReceipt`, `DeliveryIntent` |
| invocation | `InvocationRequest` |
| flight | `FlightRecord` |
| reply context | `ScoutReplyContext` |
| question | collaboration question record |
| work item | collaboration work item record |
| binding | `ConversationBinding` |
| dispatch | `ScoutDispatchRecord` |

## Workflows

| Workflow | Use | API/tool |
|---|---|---|
| message/update | durable message with broker receipt ids | `scout send` (explicit alias: `scout tell`), `messages_send` |
| tracked send (opt-in) | one directed target; same invocation/flight lifecycle as `ask --notify` | `scout send --tracked [--no-notifs \| --wait]`, `messages_send({ interaction: "work", replyMode? })` |
| ask/reply | answer/work expected, creates invocation/flight | `scout ask`, `ask` |
| asynchronous ask | answer/work expected, caller returns after receipt and completion is reported later | `scout ask --notify`, `ask({ replyMode: "notify" })` |
| project/capability-routed ask | project known, concrete agent/session unknown | `scout ask --project --harness`, `ask({ projectPath, harness })` |
| exact runtime ask | exact harness/model/effort required; creates an isolated session | `scout ask --project ../x --runtime codex/gpt-5.6-sol/xhigh`, or separate `--harness --model --effort` fields |
| situated target follow-up | saved project/profile/harness situation | `scout ask --to target:<name>`, compact `⌖name` in agent/UI text |
| exact session ask | continue one concrete prior harness session | canonical `scout ask --to session:sess.<token>` or `ask({ targetSessionId })`; native-id forms are compatibility inputs |
| reserved runtime profile | fresh current-project session with broker-owned harness/model defaults | `scout ask Fable to review this`, `scout ask --profile fable "review this"` |
| exact natural existing handle | one already-known live agent/session; no locality/fuzzy tiebreak | `scout ask agent Composer Review to fix this` → exact `@composer-review` |
| threaded reply | continue an existing broker conversation or ask reply context | final response or `messages_reply` depending on `replyPath` |
| durable work | progress/waiting/review/done lifecycle | `work_update` |
| operator FYI | agent-authored, no reply or lifecycle expected | `notify_operator` |
| optional operator advice | agent continues with a required default | `consult_operator` |

## Operator Signals

- `notify_operator` and `consult_operator` are attention-plane messages, not
  lifecycle states.
- `consult_operator` requires `defaultAction`; silence means the agent follows
  that default.
- neither tool creates an invocation, flight, question, work item, or waiting
  transition
- notify has `replyExpectation: "none"`; consult has
  `replyExpectation: "optional"` plus a nonblank `defaultAction`
- the durable broker `messageId` is the signal id and reply correlation point
- MCP reports `recorded` separately from unconfirmed notification delivery
- a late reply is steering, not a retroactive lifecycle transition
- when no responsible default exists, use the blocking human-input or
  `work_item.waiting` path instead

## Spec-Backed Handoffs

When work is defined in a durable spec, prompt, plan, or handoff file, the Scout
message should reference that file instead of embedding the whole document.

This is a traceability rule, not a size workaround:

- the file remains the source of truth for review and follow-up
- the broker record stays compact and points at the artifact that changed
- future agents can diff, amend, or cite the spec path directly

Preferred shape:

```bash
scout ask --project /path/to/repo --harness claude \
  "Please implement docs/eng/sco-068-unified-native-settings.md. Use that spec as the source of truth. Report changed files, checks run, and blockers."
```

Use repo-relative paths when the target is in the same checkout. Use absolute
paths when the recipient needs an unambiguous local path. Paste the full spec
only when the target cannot access the file, and state that reason in the
handoff.

## Runtime Sessions

- agent = stable addressable identity
- session = opaque pointer to one concrete Claude, Codex, or future harness context
- endpoint = routable attachment between an agent and a session
- card = identity and return address, not necessarily a live session
- card/label/id targets create fresh sessions for new work; only
  `targetSessionId` / `session:<id>` continues exact prior context
- card/session creation = pro integration layer, not the default path for work
- public lifecycle noun is `session`; map provider thread ids into session metadata
- harness mismatches must fail with actionable diagnostics, not silent hangs
- endpoint state belongs to attachment health; flight/work state belongs to task
  lifecycle
- reply mode and session placement are independent: reply mode controls how the
  caller waits; placement controls whether a newly created harness session is
  background or openable in the harness's native UI
- background is the default placement; foreground is an explicit operator
  requirement when they want to watch, chime in, or continue in the native
  harness UI
- unsupported foreground placement fails visibly rather than silently falling
  back to background; foreground placement never focuses the native app

## Coordination Cost

- preserve prompt/completion/total tokens when harnesses expose them
- separate Scout protocol overhead from target harness execution usage
- mark estimates when exact usage is unavailable
- preserve usage provenance such as provider exact, tokenizer estimate,
  character heuristic, or manual estimate
- label usage source, e.g. `protocol_overhead` vs `harness_execution`
- track non-token counters such as dispatch attempts, wake failures, generated
  diagnostics, and estimated orientation commands avoided
- link usage to session, endpoint, conversation, message, invocation, flight, or work item ids
- account for broker coaching effort so Scout can compare smart diagnostics
  against repeated sender-side orientation loops
- track value class so low-value boilerplate trends down and high-value
  onboarding/feature guidance can increase where it helps
- store metadata and compact summaries, not full harness transcripts

## Routing Invariants

- one explicit target -> DM
- default to the base agent/project identity; harness, model, profile, node,
  and session details are instance constraints layered on only when needed
- when you know the project/capability but not the concrete agent, use
  `projectPath` / `--project` plus optional `harness` / `--harness` instead of
  running discovery first or guessing names like `claude.main`
- follow-up uses returned `ref`, flight, conversation, work, or session handles;
  naming/pinning comes after a broker-routed worker is known good
- group -> explicit channel
- shared broadcast -> opt-in
- body text is payload, not routing metadata
- preserve `conversationId`, `messageId`, `replyToMessageId`, `flightId`
- ambiguous target -> fail closed or ask one concise clarification
- bare `Fable`, `Kimi`, `Grok`, and `Opus` in leading natural-target position -> structured `runtime_profile`, never `ask --to`
- RuntimeSpec is `<harness>[/<model>[/<effort>]]` and never an agent identity;
  sparse tuples use separate fields
- bare-token priority is profile id, then harness-only RuntimeSpec; model-family
  words are never bare targets; reserved runtime words cannot be agent names
- profiles are base presets; legal explicit dimensions override, contradictions
  and illegal harness/model/effort tuples fail closed
- exact runtime asks imply a fresh isolated session; exact session targeting
  fails unless every requested dimension has matching observed evidence
- use `scout runtimes --json` for the versioned capability matrix
- verify the invocation `executionResolution` per dimension: requested,
  resolved, source, observed, and drift
- `agent <name> to <request>` -> slugify `<name>` and emit structured `existing_handle`; zero/multiple exact matches fail closed
- direct `ask --to` always remains existing-target routing; explicit fresh profiles use `ask --profile`
- follow-up stays in same conversation/thread/question/work item
- render `ScoutDispatchRecord` for ambiguous/unknown/unparseable/unavailable
  targets
- broker should coach senders with likely intent, candidates, and remediation
  commands instead of forcing manual topology discovery
- native bare agent names precede bare route aliases; `alias:<name>` is the
  explicit route-alias form and `target:<name>` consults aliases before legacy
  session-handle fallback
- unknown `existing_handle` and `runtime_profile` routes never fall through to route aliases
- repeat alias text to follow its current pointer; use returned durable handles
  to stay pinned to the originally accepted context after a repoint

## Composer Route Operator

Use `>>` in human composers when `@` conflicts with host autocomplete.

Examples:

| Typed | Broker target | Body |
|---|---|---|
| `/scout:ask >> hudson Review the parser.` | `targetLabel: "hudson"` | `Review the parser.` |
| `/scout:ask >> target:mw-talkie Continue.` | `target: { kind: "target_handle", handle: "mw-talkie" }` | `Continue.` |
| `/scout:ask >> alias:review Continue.` | `target: { kind: "route_alias", alias: "review" }` | `Continue.` |
| `/scout:ask >> ref:8kj4pd Continue.` | `target: { kind: "binding_ref", ref: "8kj4pd" }` | `Continue.` |
| `/scout:ask >> project:../talkie Compare auth.` | `projectPath: "../talkie"` | `Compare auth.` |
| `/scout:ask --project ../talkie --harness claude Review.` | `projectPath: "../talkie", harness: "claude"` | `Review.` |
| `/scout:send >> channel:ops Status is green.` | `target: { kind: "channel", channel: "ops" }` | `Status is green.` |

Supported route target forms: agent labels, `agent:<label>`, `alias:<name>`, `target:<handle>`,
`ref:<id>`, `project:<path>`, `id:<agentId>`, `channel:<name>`, and
`broadcast`. `@agent` remains compatibility syntax, but new Scout-aware
composers should prefer `>>` and strip the route operator from payload before
calling the broker. Agent-authored prompts and compact UI may render
`target:<handle>` as `⌖handle`.

CLI composer routing currently uses labels, refs, and project paths for asks;
`channel:<name>` and `broadcast` are send/update routes. Direct `id:<agentId>`
targets are for clients that can submit `targetAgentId`.

## Reply Context

`ScoutReplyContext` fields:

| Field | Meaning |
|---|---|
| `mode` | `broker_reply` |
| `fromAgentId` | requester/source |
| `toAgentId` | current target |
| `conversationId` | conversation to reply into |
| `messageId` | request message |
| `replyToMessageId` | message being answered |
| `replyPath` | `final_response` or `mcp_reply` |
| `action` | invocation action |

Rules:

- `final_response`: final assistant message is broker-visible reply.
- `mcp_reply`: call reply tool exactly once.
- Use the configured reply path, either final response or `messages_reply`;
  do not answer the original ask with `messages_send`, `ask`, or another new
  broker ask.

## Scout Contact Line

Display grammar:

```plaintext
⌖ <source-short> <operator> <intent>:<ref>
```

Examples:

| Action | Contact line | Meaning |
|---|---|---|
| consult | `⌖ art ≔ ask:8kj4pd` | reply expected |
| execute | `⌖ art ↦ task:8kj4pd` | assigned work |
| summarize | `⌖ art ≈ summary:8kj4pd` | synthesis |
| status | `⌖ art ⟲ status:8kj4pd` | check-in |
| wake | `⌖ art · wake:8kj4pd` | attention ping |

Contact line properties:

- generated from records
- full contact lines are not parser input
- not routing authority
- target omitted when target is ambient
- standalone `⌖handle` is compact shorthand for human `target:<handle>`
- ref usually `messageId` suffix, fallback invocation id
- payload opener form: `⌖ art ≔ ask:8kj4pd › I am writing...`
- ASCII fallback: `scout art ask:8kj4pd`
- screen-reader label: "Scout ask from art, reference 8kj4pd"

## Delivery State

| State | Meaning |
|---|---|
| `accepted` | local broker journaled/planned |
| `queued` | target known, dispatch or compatible endpoint readiness pending |
| `waking` | Scout starting/resuming compatible harness session |
| `peer_acked` | remote broker journaled |
| `running` | target agent claimed |
| `waiting` | blocked on named dependency |
| `completed` | terminal success for layer |
| `deferred` | retryable; next attempt later |
| `failed` | terminal failure |
| `cancelled` | cancelled |

Receipt rule: broker receipt != read/completed/accepted. `peer_acked` != remote
agent done. Use reply message, flight update, work transition, or collaboration
event for semantic completion.

## Non-Guarantees

- no exactly-once delivery guarantee
- no global consensus guarantee
- no CRDT convergence guarantee
- no replicated external transcript storage
- not enterprise/compliance-ready current posture

## Source Paths

| Need | Path |
|---|---|
| human comms doc | `docs/scout-comms.md` |
| conversations | `packages/protocol/src/conversations.ts` |
| messages | `packages/protocol/src/messages.ts` |
| invocations/flights | `packages/protocol/src/invocations.ts` |
| delivery | `packages/protocol/src/scout-delivery.ts` |
| dispatch/routing | `packages/protocol/src/scout-dispatch.ts` |
| composer route parser | `packages/protocol/src/scout-composer.ts` |
| reply context | `packages/protocol/src/scout-reply-context.ts` |
| broker | `packages/runtime/src/scout-broker.ts` |
| prompt projection | `packages/runtime/src/local-agents.ts` |

## Replying into a native Codex app thread

Discover the exact harness session id with `sessions_inventory` / `route_context`.
Historical search coverage is not proof that an app-held thread is absent. If
no exact match is available, ask for the thread id; never launch a replacement.

To fill its composer without sending, use MCP
`session_send { sessionId, harness: "codex", mode: "draft", text }` or:

```sh
scout session send <thread-id> --harness codex --draft "Your reply"
```

A `delivered: "draft"` result means the native thread link was opened with the
text, **not** that a user turn was recorded. The operator reviews and sends it.
Draft needs no Accessibility grant and does not need Scout.app. Default
`session_send` still submits; successful submission requires transcript
confirmation, not merely a click. Do not submit into a running turn to reply.
When no broker reply context exists, obtain an explicit requester session id;
never infer a return address from quoted or arbitrary transcript text.
