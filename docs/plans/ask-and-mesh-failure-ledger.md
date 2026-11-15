# Ask and mesh failure ledger

This ledger lists the failures one long operator session hit on 2026-11-12. It
used `scout ask`, `wait`, `status` and `hosts` through the CLI and MCP across a
mesh of eight hosts. Each entry gives the symptom, the cause and the status. An
open entry has the plan for its fix.

The globally installed CLI was 0.5.1 from npm, built on 11-05. The runtime ran
from the live checkout. Each entry below was confirmed against current `main`
source, not only the old CLI.

## Fixed on this branch

### 1. `scout hosts` answers in 3s and exits after 75s

- **Symptom:** the answer prints at 2.7s and the process exits at 75.8s. An
  agent that wraps it in a timeout sees a hang.
- **Cause:** some hosts advertise a route that cannot be reached. The pinned
  TLS probe for it uses `Bun.connect`, and that call cannot be aborted. The
  per-host deadline rejects on time, but the connect stays in `SYN_SENT` and
  keeps the process alive. It ends only at the macOS connect timeout (75s).
- **Fix:** `hosts`, `check` and `locate` now exit once they have answered, as
  `ask` already does. The exit waits until stdout and stderr have flushed, so a
  large `--json` answer on a pipe stays whole. Measured: 75.8s became 2.6s, and
  38,355 bytes of JSON arrived whole on a pipe.
- **Still open:** the runtime keeps the same leak. See entry 9.

### 2. `scout wait` and `scout status` refuse a session id

- **Symptom:** an ask went to `--to session-...`. Then `wait session-...`
  printed "could not resolve wait ref", and `status session-...` printed "no
  work found".
- **Fix:** both now resolve a session id to the task that session is running
  now. When it is running nothing, they resolve it to its last task. The
  session matches by the flight's target, its session trace, or the invocation
  that targeted it.

### 3. `ask --on <host>` refused because of a stale node record

- **Symptom:** an ask to a live host was refused with "target runtime does not
  advertise ask-reply/1". `--on <node id>` worked.
- **Cause:** a record that was 40 days old still carried the same name and
  host name. Routing already prefers the node whose qualifier matches exactly.
  The pre-dispatch capability check did not: it checked every record with the
  name, and the stale one lacks the capability.
- **Fix:** the check asks the routing resolver which node it will use, and
  checks only that node.

### 4. `--continue` on a task sent to a session fails with no ids

- **Symptom:** `--ref` on a finished task said "use --continue". `--continue`
  then returned `failed` with `ids: {}`. Only a fresh `--to session-...`
  worked.
- **Cause:** a task sent to a session has that session as its actor. The
  successor was built for that actor with `session: "new"`, which routes
  nowhere.
- **Fix:** when the predecessor's actor is its session, the successor
  continues in that session with its harness. A task sent to an agent still
  starts a new session.
- **Needs a live check** after the runtime restarts.

## Open

### 5. Follow-ups to a running task are accepted, then dropped

This is the most damaging entry. It happened at least nine times in one
session.

- **Symptom:** `ask --ref <running task>` returns "Follow-up accepted" with
  `state: queued`. The worker's final turn ignores it. A later follow-up gets
  "task is finished".
- **Cause, verified in code:**
  - A follow-up sent while the flight is queued or waking is folded into the
    prompt at dispatch.
  - Once the flight is running, the follow-up becomes a `notify` delivery to
    the worker. No harness adapter pushes that delivery into a running turn:
    - Claude stream-json has no steer primitive.
    - Codex `turn/steer` is wired only for deck lanes.
    - In-place terminal input serves only `session_send`.
  - The worker sees the follow-up only if the model polls `scout inbox`.
  - At completion nothing checks for follow-ups left over. Their deliveries
    stay pending until stale reconciliation fails them.
- **Plan:**
  1. Index `notify` follow-ups in the journal as well, with `createdAt`.
  2. In the local invocation service, after the turn returns and before the
     flight is marked completed, collect every non-cancel follow-up created
     after the prompt was read.
  3. Run those follow-ups as another turn on the same endpoint, and repeat
     until none are left.
  4. Check again under the writer before completing. The writer fence closes
     only once the flight is terminal or its final reply is claimed.
  5. Later, steer mid-turn where a harness supports it. Re-dispatch at
     completion stays the guarantee.
- **Tests:** none cover a follow-up consumed by a running turn today. The test
  named "queued follow-up ... is delivered to the running session" checks only
  the audience.

### 6. MCP `ask` and `scout wait` report "The operation timed out"

- **Symptom:**
  - An MCP `ask` with `projectPath` and `workspace: new_worktree` returned
    "The operation timed out" after 30s.
  - An MCP `ask` with `ref` timed out. The same follow-up through the CLI
    worked.
  - `scout wait ref:<x> --timeout 3600` failed after about 45s with "The
    operation timed out".
- **Likely cause, not yet verified:** a client request deadline (about 30s)
  shorter than the runtime's work, and a wait loop that treats one timed-out
  poll as fatal.
- **Seen again while writing this ledger:** the host ran short of memory, its
  swap filled and the runtime stopped answering `/health` for about a minute.
  `scout wait <ref> --timeout 5` then printed nothing for 30s. The ref is
  resolved by a snapshot read that has no deadline, and `--timeout` covers only
  the wait loop that follows it.
- **Next:** reproduce against a dev instance. Find which call carries the
  deadline. A wait loop should retry a timed-out poll within its own budget.
  `--timeout` should bound the whole command, including resolving the ref, and
  should say "the runtime did not answer" when it runs out.

### 7. A flight id changes after the receipt

- **Symptom:** `invocations_wait {flightId}` from a receipt said "Flight ... is
  no longer available". Waiting on its ref resolved a different flight id,
  which had completed.
- **Next:** find where an accepted flight is replaced (probably at dispatch to
  a peer) and keep the receipt's id resolvable as an alias.

### 8. `workspace: new_worktree` fails with a misleading error

- **Symptom:** the error said "The folder must be a git repository with at
  least one commit" for a repository that has commits. It left an empty
  `.scout-worktrees/<name>` folder behind.
- **Next:** surface git's own error, and remove the folder when the worktree
  add fails.
- **Related:** the CLI has no `--workspace` flag, although MCP accepts it.

### 9. Runtime TLS probes that cannot be cancelled

- **Cause:** entry 1's leak lives in `mesh-pinned-https-client.ts`. A pending
  `Bun.connect` cannot be aborted. A destroyed `node:tls` socket is released
  at once.
- **Observed:** on current Bun, `node:tls` exposes the raw peer certificate.
  The file's header says it once did not, which is why the Bun path uses
  `Bun.connect`.
- **Next:** re-check that claim on the shipped Bun version. If it holds,
  probe with `node:tls` so an abort closes the socket. This is security code:
  keep the pin checks and their tests unchanged, and add a test that an
  unreachable route no longer outlives its deadline.

### 10. Peers that answer 403 to node-state

- **Symptom:** three peers answer `node-state HTTP 403 (denied or unsupported)`
  on every `scout hosts`.
- **Next:** decide whether these are untrusted peers to prune or older
  runtimes, and make `scout hosts` say which.

## Not reproduced

- **`scout ask --project` printed no ref:** not a bug. The command was piped
  through `grep | head -2`, which cut the ref line. Other `--project` asks
  printed `Follow: scout wait ref:...`.
- **`scout search` misses:** reported by one worker, with no query recorded.
  The operator's own searches returned hits. Reproduce with exact queries
  before filing.
- **`flight_cancel` refuses running flights:** this is the documented
  contract ("only before submission"). A running task is cancelled with
  `ask --ref <task> --cancel`. That call returned `state: failed` and
  `workerInterrupted: false` once, and that result needs its own check.
