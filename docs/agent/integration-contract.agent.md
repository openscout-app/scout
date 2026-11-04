# Agent Integration Contract Notes

Sources: `docs/agent-integration-contract.md`.

Status: v0 integration guidance. Use this as the current Scout-native target, not as a frozen public API guarantee.

Original runtime guidance verified: 2026-06-10. Shared interaction design adopted:
2026-10-09; this addition is documentation only, with implementation gaps in the
source contract.

## Minimum Scout-Native Integration

The table below applies to harness-backed execution targets. External personal
agents and services can participate as clients without a Scout-managed runtime
session. Remote service targets describe their actual execution lifecycle.

| Requirement | Meaning |
|---|---|
| stable identity | resolves to one exact agent target |
| reachable endpoint | broker knows how to reach the agent |
| runtime session | concrete harness conversation/process attached to an endpoint |
| endpoint state | attachment state such as registered/attaching/waking/idle/working/unreachable/failed/superseded/stopped |
| message path | can receive durable messages with broker receipt ids |
| invocation path | can receive ask/work and produce flight result ids |
| reply context | replies preserve actor and conversation context |
| lifecycle state | reports queued/running/waiting/completed/failed/cancelled as appropriate |
| session diagnostics | reports missing or mismatched harness sessions clearly |
| broker guidance | returns candidates and remediation instead of opaque routing errors |
| token usage | reports exact usage or marked estimates when available |
| usage provenance | marks usage source as provider exact, tokenizer estimate, character heuristic, or manual estimate |
| permission posture | documents approval, sandbox, and wake behavior |
| data boundary | does not import external transcripts as Scout messages |

## Shared Interaction Design

The adopted interaction model defines these
requirements. Its coverage table is authoritative about implementation gaps;
this digest does not add wire fields or assert Poppy compatibility.

- Keep authenticated caller, represented principal, and executing agent distinct.
  Actor/requester metadata is attribution, not a verified permission grant.
- Effective permission is bounded by verified grants, resource policy, and
  execution restrictions. Delegation cannot expand it or borrow ambient operator
  credentials. Unsupported authority boundaries fail before dispatch.
- Keep authorization context, chat, work, invocation/flight, and runtime session
  separate. Correlate source ids with their authority and account context.
- Continue owned execution through durable work handles; changing a surface or
  harness session must not silently re-run or replace the work.
- A human handoff identifies the decision, relevant revision, respondent, and
  next move. Forward the outcome to the authority that owns the action; a chat
  reply or notification dismissal does not itself grant a host permission.
- Distinguish original human contributions from agent interpretations, and both
  from verified consent. Human unavailability is not approval.
- Declare adapter retry, replay, cancellation, and retention limits. A receipt
  is not completion; closing a conversation does not cancel linked work.

## Preferred MCP Tools

| Need | Tool |
|---|---|
| identify sender | `whoami` |
| resolve ambiguous target | `agents_resolve` |
| broker-native messages/status/errors | `broker_feed` |
| observed harness activity | `tail_events` |
| message/update | `ask` with `fyi: true` |
| work/requested reply | `ask` |
| project/capability known, agent unknown | `ask({ projectPath, harness })` |
| inspect flight | `invocations_get` |
| bounded follow-up wait | `invocations_wait` |
| work progress/waiting/review/done | `work_update` |
| session lifecycle | future `sessions_start`, `sessions_attach`, `sessions_inspect`, `sessions_stop` |

Card/session creation belongs to the pro integration layer for hosts and
Scout-native agents that intentionally manage identity infrastructure. Core
agents should route work with `ask`, especially `ask({ projectPath, harness })`
when no concrete instance is selected. Discovery is for ambiguity, not a
mandatory preflight.

## Reply Modes

| Mode | Use |
|---|---|
| `none` | receipt-only, durable ids returned |
| `inline` | short bounded wait only |
| `notify` | return quickly, deliver callback-style MCP notification later |

## Routing Rules

- one target -> DM
- base agent identity is the vanilla project/workspace identity
- harness, model, profile, node, and session are instance constraints unless a
  specialized profile is explicitly requested
- if the project/capability is known but the concrete agent/session is not,
  use `projectPath` plus optional `harness` instead of discovery-first routing
  or generic guesses such as `claude.main`
- continue with returned `ref`, flight, conversation, work, or session handles;
  pin/name a sibling only after the runtime-routed worker is known good
- group -> explicit channel
- everyone -> shared broadcast
- body text is payload, not routing metadata
- follow-up stays in same DM/channel/work item

## Human Dependency Rules

- Agent question -> question path.
- Action approval -> approval/action state.
- Durable work blocked on a person -> work item `waiting`.
- Host-level permission prompt -> host integration must forward to Scout; MCP server cannot see a prompt intercepted before tool call.
