# Flight supervisor

Status: proposed. Nothing in this document is implemented yet, except where
"Current behavior" says so.

A flight starts when an ask is accepted, and it ends in one recorded outcome.
The flight supervisor makes sure every flight gets that outcome. It works like
a control tower: each node's supervisor owns the flights running inside its
perimeter, watches them on a fixed clock, and closes each one with a reason.
Other nodes only show what the owner reports.

The supervisor also keeps two things apart that Scout mixes today: a run that
ended badly (`failed`), and a run that stopped without ending at all (`dead`).

## Current behavior

This section describes the code on `main` as of 2026-11-28.

- A flight has one of seven states: `queued`, `waking`, `running`, `waiting`,
  `completed`, `failed` and `cancelled`
  (`packages/protocol/src/invocations.ts`).
- Nothing watches flights on a timer. `reconcileStaleWorkingFlights` runs once
  at broker startup (`broker-daemon.ts`) and after each local agent sync
  (`broker-local-agent-sync-service.ts`).
- `staleWorkingFlightReason` (`broker-local-invocation-helpers.ts`) closes a
  working flight as `failed` when one of these is true:
  1. no live broker task holds it;
  2. it exited while it was waiting for a final reply;
  3. its dispatch was never confirmed;
  4. a newer finished flight exists on the same execution owner
     ("superseded");
  5. its endpoint is stale or was replayed;
  6. its agent was retired.
- Every broker runs this pass against its own copy of every flight it knows
  about, including flights that run on another node. No node is the
  authority for a flight.
- A closed flight gets `completedAt` set to the time of the pass, the same
  field a real finish uses.
- Each ask creates a placeholder flight. The real flight then replaces it,
  and the placeholder is cancelled as superseded.
- `failed` carries a cause from `FAILED_RUN_CAUSES`
  (`packages/protocol/src/failed-runs.ts`): `superseded`, `endpoint_lost`,
  `harness_start`, `disk_full`, `harness_error` or `unknown`. Several of these
  are guesses by the pass, not errors the run reported.

### What goes wrong

On 2026-11-28, arts-mini closed a live flight as superseded. The sequence was:

1. Flight A ran on arts-mini, and its reply came back to the operator through
   the air broker. arts-mini never recorded that A finished.
2. arts-mini's pass closed A as `failed` and set A's `completedAt` to the time
   of the pass.
3. A newer flight B was running on the same session. Rule 4 now saw A as a
   finished flight that was newer than B's start, so it closed B as
   superseded while B was still working.

openscout-app/scout#341 stops rule 4 from counting flights that a pass closed.
That fix is a patch. The underlying faults are:

- A node that does not run a flight can still close it.
- A guess and a real finish write the same timestamp.
- Supersession is decided by comparing times, not by who replaced whom.
- A run that stopped and a run that reported an error both show as `failed`.

## Design

### Perimeter and ownership

The **owner** of a flight is the node whose broker runs the harness session
for it. That node's supervisor is the only one that can change the flight's
liveness or close it with a reason other than a reported finish.

- The owner is recorded on the flight as `supervisor: { nodeId, epoch }`.
  `epoch` starts at 1 and increases by 1 on each handoff.
- A flight created for a local session is owned by the local node from the
  start.
- A flight forwarded with `--on <node>` is owned by the origin node until the
  target node accepts it. Then ownership moves to the target node (see
  "Handoff").
- Every other node keeps a **mirror**: a read-only copy that it updates from
  the owner's events. A mirror never closes a flight. Its one exception is
  `owner_unreachable` (see "Deadlines").
- The existing `metadata.taskHomeNodeId` marks where the task lives. It is
  not the owner. A task can live on the origin node while its flight runs on
  another node.

### Handoff

A flight moves between nodes only through an explicit handoff:

1. The origin sends `flight.handoff { flightId, toNodeId, epoch: n + 1 }`.
2. The target starts the session and replies `flight.accepted { flightId,
   epoch: n + 1 }`.
3. When the origin receives the acceptance, it changes its copy to a mirror.
4. If no acceptance arrives within `handoffDeadline`, the origin keeps
   ownership and closes the flight as `dead` with cause `handoff_unconfirmed`.
   It does not retry by itself, because a retry could start a second session.

An event that carries an epoch lower than the flight's current epoch is
recorded and ignored. This keeps a late message from a former owner from
changing the flight.

The same rule covers a session moved within one node (for example by
`scout session transfer`). The flight keeps its id, and only the session
reference changes.

### Lineage replaces supersession

A flight is replaced only when a new flight names it:
`replacesFlightId: <id>`. The supervisor closes the replaced flight as
`cancelled` with reason `replaced`, and links the two flights in both
directions.

- The supervisor never infers replacement from timestamps or from a shared
  session.
- The ask path creates one flight and keeps its id from acceptance to the
  end. The placeholder flight goes away.
- `superseded` is removed from `FAILED_RUN_CAUSES`.

### Lifecycle

A flight's state machine becomes:

```
queued → waking → running ⇄ waiting
                     │
                     ├─→ completed   (the run reported a finish)
                     ├─→ failed      (the run reported an error)
                     ├─→ cancelled   (an operator or a replacement stopped it)
                     └─→ dead        (the supervisor stopped waiting for it)
```

`dead` is new. Each terminal state has one meaning:

| State | Who decides | Meaning |
|-------|-------------|---------|
| `completed` | the run | The run said it was done. |
| `failed` | the run | The run said it could not finish, with an error. |
| `cancelled` | an operator, or a replacing flight | Someone stopped it on purpose. |
| `dead` | the owner's supervisor | The run stopped without saying so, and the deadline passed. |

The product groups outcomes in two categories:

- **Finished**: `completed`, `failed` and `cancelled`. Something reported an
  end.
- **Unfinished**: `dead`. Nothing reported an end. This is the category for
  runs that did not drive themselves to a finished state.

`failed` keeps only the causes a run can report: `harness_start`,
`disk_full`, `harness_error` and `unknown`. `endpoint_lost` moves to `dead`.

### Liveness

While a flight is `running`, the owner shows one of three liveness levels.
Liveness is a display field, not a state change.

| Liveness | Condition |
|----------|-----------|
| `active` | The owner saw evidence within `quietAfter`. |
| `idle` | No evidence for `quietAfter`, and the session process is alive. |
| `stalled` | No evidence for `stalledAfter`, or the session process is gone. |

**Evidence** is anything the session produces that the owner can observe:
transcript or event writes, terminal output, tool calls, or a reply. A live
session process alone is not evidence of progress, but it keeps a flight from
being declared dead for silence alone.

A `waiting` flight (waiting for the operator or another agent) has no
deadlines. It stays `waiting` until something answers it or someone cancels
it.

### Deadlines

The owner's supervisor runs a tick every `tickInterval`. On each tick, for each
flight it owns:

1. A `running` flight with no evidence for `quietAfter` becomes `idle`.
2. A `running` flight with no evidence for `stalledAfter` becomes `stalled`.
3. A `stalled` flight becomes `dead`:
   - with cause `session_gone`, when its session process has been gone for
     `goneGrace`;
   - with cause `no_progress`, when it has had no evidence for `deadAfter`,
     even though the process is still alive.
4. A flight whose agent was retired becomes `dead` with cause
   `agent_retired`.

A mirror applies one rule: when it has not heard from the owner for
`ownerUnreachableAfter`, it shows the flight as "owner unreachable since
<time>". If the owner is still unreachable after `ownerLostAfter`, the node
that holds the task (`taskHomeNodeId`) may close the flight as `dead` with
cause `owner_unreachable`.

Proposed defaults, all configurable per node:

| Name | Default |
|------|---------|
| `tickInterval` | 15 s |
| `handoffDeadline` | 2 min |
| `quietAfter` | 2 min |
| `stalledAfter` | 10 min |
| `goneGrace` | 1 min |
| `deadAfter` | 60 min |
| `ownerUnreachableAfter` | 5 min |
| `ownerLostAfter` | 6 h |

### Time fields

- `completedAt` is set only when the run reports a finish or error, or when
  a flight is cancelled.
- `declaredDeadAt` is set when a flight becomes `dead`. `completedAt` stays
  empty.
- `lastEvidenceAt` records the time of the newest evidence. Liveness is
  computed from it.

No rule may use the time a flight was closed by the supervisor as the time
the work ended.

### Correction

`dead` is the only terminal state that can change. If the owner later gets
authoritative evidence from the session itself, such as the final reply, it
changes the flight to `completed` or `failed`. It records
`correctedFrom: "dead"` and the time of the correction.

- A correction comes only from the owner at the current epoch.
- When an unreachable owner returns, its record wins over any
  `owner_unreachable` close that the task's node made.
- `completed`, `failed` and `cancelled` never change.

### Startup

At broker startup, the supervisor reads every flight it owns and applies the
deadline rules using `lastEvidenceAt`. It does not close a flight only
because the broker restarted. A session that is still running after the
restart keeps its flight.

## Migration

1. Add `dead` to `FlightState`, and add `supervisor`, `lastEvidenceAt`,
   `declaredDeadAt`, `replacesFlightId` and `correctedFrom` to the flight
   record.
2. Rewrite existing records:
   - `failed` with `metadata.reconciledStaleFlight: true` becomes `dead`;
     move `completedAt` to `declaredDeadAt`;
   - `failed` with cause `superseded` becomes `cancelled` with reason
     `replaced` when a replacing flight can be found, otherwise `dead`;
   - placeholder flights cancelled as superseded are removed from lists
     but kept in storage.
3. Set `supervisor.nodeId` to the node that holds the session. If that is not
   known, use the node that created the flight, with `epoch: 1`.
4. Replace `reconcileStaleWorkingFlights` and `staleWorkingFlightReason` with
   the supervisor tick. Remove the calls at startup and after agent sync.
5. Old peers do not send handoff or epoch messages. A node treats a flight
   from such a peer as mirrored from the node that runs it, and never closes
   it, apart from `owner_unreachable`.

### Product surfaces

- Work cards and flight lists show `dead` as "Didn't finish", with its cause
  and `declaredDeadAt`. They use a neutral treatment, not the error treatment
  for `failed`.
- `idle` and `stalled` show on running flights as a quiet label with the time
  since the last evidence.
- Roll calls (`packages/web/shared/roll-call.ts`) count a job whose flight is
  `dead` as `unfinished`, separately from `done` and `stopped`. A roll call
  with an unfinished job is not complete.
- The failed-runs actions (`FAILED_RUN_ACTIONS`) gain matching actions for
  each `dead` cause.

## Exclusions

- The supervisor does not retry. A retry is a new ask by an operator or an
  agent, as it is today.
- The supervisor does not kill sessions. Closing a flight as `dead` does not
  stop its process.
- This spec does not change how work items are created, or how replies are
  routed.

## Acceptance checks

1. A flight that runs on node B and finishes through node A's broker is never
   closed by node A or node B as anything other than `completed`.
2. The 2026-11-28 case: flight A is closed as `dead` on its owner, and a newer
   flight B on the same session stays `running`.
3. No code path sets `completedAt` on a flight that becomes `dead`.
4. A flight is cancelled as `replaced` only when another flight names it in
   `replacesFlightId`.
5. One ask creates one flight. No placeholder flight appears in any list.
6. A running flight with no evidence moves to `idle` after `quietAfter`,
   `stalled` after `stalledAfter`, and `dead` after `deadAfter`. Each step
   can be tested with an injected clock.
7. A flight whose session process exits without a reply becomes `dead` with
   cause `session_gone` within `goneGrace` plus one `tickInterval`.
8. A `waiting` flight stays `waiting` past every deadline.
9. A broker restart does not close a flight whose session is still running.
10. A handoff without an acceptance leaves the origin as owner, and the
    flight becomes `dead` with cause `handoff_unconfirmed` after
    `handoffDeadline`.
11. An event with an older epoch does not change the flight.
12. A `dead` flight that later gets its final reply from the owner becomes
    `completed` and records `correctedFrom: "dead"`.
13. A mirror never changes a flight's state, except `owner_unreachable` after
    `ownerLostAfter`, and the owner's record replaces that close when the
    owner returns.
