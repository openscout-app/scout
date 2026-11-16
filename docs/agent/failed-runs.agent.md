# Failed runs stay actionable

The runtime records a failed flight's cause in `metadata.failureCause`.
Terminal work promotion writes `waitingOn: { kind: "failed_run", cause,
flightId, retryable, label }`. The label gives the next action. The flight's
error and the work's progress summary retain the diagnostic details.

| Cause | Raised by | Retry |
| --- | --- | --- |
| `superseded` | Stale-flight reconciliation finds a newer terminal flight on the same execution owner. | No |
| `endpoint_lost` | Stale-flight reconciliation finds missing, offline, replaced or replayed endpoints; dispatch loses its target; a reply waiter observes session exit. | Yes |
| `harness_start` | Local endpoint preparation, unsupported executor, composer readiness or submit verification fails; a Codex process exits before replying. | Yes |
| `disk_full` | Local preparation or execution catches errno `ENOSPC`, including a wrapped error. | No: free space and inspect first. |
| `harness_error` | Execution reports a harness error, blocked delivery or empty reply. Permission failures stay here. | No: inspect and correct the ask first. |
| `unknown` | The flight has no recognized structured cause, including legacy records. | No: inspect first. |

`broker-local-invocation-service.ts` classifies errors where they become failed
flights. `failed-run-error.ts` carries source causes through adapter exceptions.
`broker-flight-lifecycle-service.ts` records reconciliation decisions from
`staleWorkingFlightFailure`. No board reader matches error prose.

## Work follows its newest flight

`broker-failed-work.ts` orders flights by their linked invocation's creation
time, then flight start time and id. A later completion time does not make an
older ask newer. Work identity comes from invocation metadata, not from a
shared endpoint or task text.

`BrokerWorkItemStore` projects that newest flight during terminal promotion.
A newer completion goes to Done, or In review when the requester chose
acceptance. A newer failure supplies its own cause. Unrelated work on the same
endpoint does not settle the item.

At startup, the daemon reconciles existing failed Waiting items in pages of
100, yielding between pages. The runtime records each repair with a
collaboration event and lifecycle placement. Repeated passes do not add moves
or events. Human Done, Drop, accepted work and explicit non-failure waits are
preserved. There is no new polling loop or automatic retry.

## Request a retry

Use `POST /v1/work/retry` with `{ "workId": "...", "attempt": 1 }`, MCP
`work_retry`, or `scout work-retry <workId> --attempt 1`.

Start at attempt 1. Reuse the same number after an uncertain receipt. Increment
it after the accepted retry fails or admission explicitly refuses to start a run. The runtime derives a request id from
the work id and attempt. It reserves the command durably before using the
existing delivery acceptance path. Repeated calls return the same flight,
including after restart and execution-history eviction. An explicit admission
refusal consumes the attempt and names the next attempt after target repair.
Retry reservations alone never dispatch work.

The retry keeps the task text, attachments, labels, execution preferences and
explicit-completion mode. It removes session and fork identities. A durable
agent target stays the same agent. A session-only target uses its verified
local project and harness to start a fresh session; an unavailable or ambiguous
project fails with instructions to make an explicit new ask. Retry does not
copy old reply addresses, permission grants or completion obligations.

Only `endpoint_lost` and `harness_start` can retry. Unknown, nonretryable,
nonfailed, missing-source and out-of-order requests fail with an actionable
diagnostic. Done and Drop remain lifecycle actions. The public core owns these
records and actions; clients need no agent or new board lane to classify them.
