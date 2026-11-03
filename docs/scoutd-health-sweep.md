# scoutd health sweep

scoutd checks host health and publishes active conditions for local clients.
It restarts only its retained base child. It does not repoint a service, restart
pairing, write app service configuration, or signal a pid found on disk.

## Conditions and actions

The supervisor requests a regular sweep every 30 seconds, starting at startup.
A bounded worker collects host observations and delivers notifications. The
supervisor continues polling its owned children while this work is in progress.
A result for a replaced base child is discarded. Shutdown cancels spawned probe
commands and does not wait for the worker thread. A disconnected worker emits
an explicit diagnostic with a failure count. Replacement starts after 30 seconds;
repeat failures double the delay up to ten minutes. Successful observations
spanning ten minutes reset the failure count. Outstanding delivery
reservations are preserved because the failed worker might already have sent
its notice. The slow-sweep deadline advances only when work is accepted.

| Condition | Grace | Action |
| --- | --- | --- |
| Startup projection degraded by SQLITE_FULL, ENOSPC, or equivalent text | 120 seconds | Wait for 2 GiB free space, then restart the owned base child once. |
| Other startup projection error | 120 seconds | At most three owned-base restarts; subsequent retries wait 120 seconds, then 240 seconds. |
| Existing projection incident still not mutation-ready | 10 minutes from the latest of `since`, sweep recovery restart, or the initial child spawn in this supervisor lifetime | Report a persistent outage, including unknown, failed or restoring health. A disk latch waiting for space keeps its free-space notice instead. This notice does not spend or replenish the restart budget. |
| Disk below max(2 GiB, min(5%, 10 GiB)) free | 60 seconds | Report low space and Scout's top three observed consumers. |
| Disk below max(1 GiB, min(2%, 2 GiB)) free | 60 seconds | Mark the same disk condition critical and refresh its consumer inventory. |
| Web expected but not running | 90 seconds | Report the cause. Never start or restart web from scoutd. |
| Pairing intent running without a relay listener | 90 seconds | Report the cause. Leave pairing claim retry to the runtime. |
| Version skew | None; checked every 10 minutes | Report differing service and CLI package installations and the repair action. |
| Unresolved Scout-owned stale files | None; checked every 10 minutes | Report preserved files that require operator inspection. |

A mutation-ready health response removes a projection condition. Five minutes
of continuously observed readiness replenishes its restart budget. A missing
or invalid health response does not clear an existing projection incident.

### Web expectation

Web is expected when a Scout app bundle is installed or runtime child-service
health reports web intent. Bundle discovery checks the service's recorded
`OPENSCOUT_APP_BUNDLE_PATH`, app ancestors of the service's installed paths,
and `/Applications/Scout.app`.

Runtime health exposes explicit intent as `services.web.expected`. A core-only
base retries entry discovery without requesting web startup until an entry is
available. A missing or rejected entry cannot terminate base. Configuration
failures are logged and retried, so a later app registration can recover. A direct web start request
sets intent even if startup fails.

If an expected web service has no entry, the condition says:

- Cause: `no web entry: legacy-app-services.json is missing`
- Action: `open Scout.app once`

scoutd does not write `legacy-app-services.json`. A headless host with neither
an installed app nor runtime web intent has no web condition. Unknown runtime
health skips web observation, including on hosts with an app installed. It does
not create or clear a web incident. A bounded loopback `/api/health` probe on the
runtime-reported web port accepts a healthy `openscout-web` surface even when
the broker does not own that web process.

### Version skew

The slow sweep reads the package directory in the service plist and resolves
the first executable `scout` on PATH to its package. It does not execute that CLI.

Runtime and CLI packages in the same source workspace share an installation
identity. Their package versions can differ. A checkout service never recommends
a shared-service repoint; a CLI from another installation requires an ownership
review. The app version is independent and is not compared.

For two installed `@openscout/scout` packages, a directory mismatch is actionable
even when versions match. The action names this one-time command, run from the
intended package:

```sh
OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT=1 scoutd install
```

The sweep only reports this command. It never runs it.

## Notifications and state

`scoutd-health.json` lives beside `scoutd-state.json`. Native `status --json`
exposes the same object as `healthSweep`. Each active condition has:

- `condition`, `cause`, `action`, and `since`;
- `escalated`, `notifiedAt`, and `notifyAfter`;
- `noticeLevel` and `notifiedLevel`: `recovery`, `outage`, or `manual`;
  `notifiedLevel` is null before a reservation.

The object also has `checkedAt` and restart-budget checkpoints. Menu clients
must treat old `checkedAt` values as stale evidence, not as recovery.

After a condition's grace, scoutd persists `notifiedAt` before dispatch.
Startup projection notices also require escalation: the restart budget must be
exhausted, a disk-related restart must be waiting for space, or an unresolved
incident must reach ten minutes without mutation readiness after the latest of
its original `since`, a sweep recovery restart, or the initial child spawn in
this supervisor lifetime. Crash respawns do not extend the deadline. Missing
health and other startup phases cannot suppress it, except while a disk-related
restart is still waiting for space. That condition keeps its free-space notice.
A pass that issues a restart never adds an outage notice. Sweep recovery and
scoutd startup each grant a ten-minute readiness window, including after scoutd
loads an old checkpoint. A restart that restores readiness within that window
remains silent. At most one notification is queued per pass.

The reservation includes the notice level. An outage or manual-repair escalation
can notify after a lower-level space/recovery notice. Exhausted automatic recovery
therefore produces a new repair notice, not just the earlier instruction to free
space. A late delivery result for a lower level cannot delay the new notice.
Incident timestamps use epoch milliseconds, including across laptop sleep.

A cleared condition retains a per-condition notification cooldown of 30 minutes
in the checkpoint. Re-entry during that window does not send another notice,
even after a supervisor restart. A higher-level escalation bypasses a lower-level
cooldown, including after a brief ready sample; repeat same/lower-level notices
remain subject to cooldown. Conditions still clear on confirmed recovery.

The persisted reservation prevents a supervisor restart from resending the
same incident. Dispatch uses
the service package's `scout notify` implementation, which shares the
`sendScoutMessage` operator-signal path with MCP `notify_operator`. The command
uses the supervised instance, not the ambient client instance. If the runtime
cannot accept the notification, macOS receives a local notification instead.

An explicit delivery failure clears the reservation and schedules a retry in
five minutes. Clearing a condition sends no notification. Notification display
and reading remain unconfirmed. The durable reservation gives at-most-once
crash behavior: a crash between reservation and dispatch can lose a notice,
rather than duplicate it after restart.

The supervisor keeps a 64-KiB Scout-owned temporary reserve for ENOSPC/EDQUOT
state publication. It releases only a verified reserve and retries publication
once. It replenishes the reserve after disk recovery. This does not authorize
removing any user data.

## Disk inventory and cleanup

Disk samples use one `statvfs` call. Only transitions into warn or critical run
an inventory. The inventory uses seven fixed Scout-owned roots, at most 512
entries per root, depth six, and a 20-ms budget per root. It skips symlinks and
marks incomplete results as bounded estimates. It reports the largest three
observed allocations. These are estimates, not a complete filesystem census.

The slow sweep can remove only these pid/lock files:

- pairing `supervisor.pid`;
- pairing `runtime.pid`;
- relay `on-air.lock`.

A file must be owned by the current user, regular, singly linked, and written
before this boot. Its recorded pid must be dead or demonstrably not Scout.
Unknown process identity preserves the file. A legacy lock without a pid is
preserved and reported. Live Scout holders are never signalled.

Journal orphan cleanup accepts only
`broker-journal.jsonl.<pid>.<timestamp>.tmp` directly inside the control-plane
directory. Both its timestamp and modification time must be older than ten
minutes. Its pid must be dead. A bounded `lsof` probe must prove there is no
holder. Errors, timeouts, symlinks, hardlinks, and changed files are preserved.
The scan examines at most 4096 directory entries and 20 orphan candidates.

The regular sweep rotates fixed Scout-owned child log names. A bounded tail is
retained in `.1`, then the active append inode is truncated. Sweep and spawn-time
rotators use the same nonblocking advisory lock on that inode. A competing
rotator skips the pass rather than blocking or overwriting the retained tail;
append writers do not need to take the lock. If advisory locking is unavailable,
scoutd logs that once and falls back to the previous unlocked rotation. The
ownership, inode, link and symlink guards still apply. Symlinks and
multiply linked files are not truncated. Rotation occurs before notification
state writes so that reclaimable log space can support diagnosis. If ENOSPC or
EDQUOT prevents a snapshot, scoutd can discard the owned active log to reclaim
space. Other write errors do not authorize that emergency truncation.

## Verification

`SupervisionTestHooks` supplies health, disk, relay, web, and slow observations.
It intercepts restart and notification actions. Loop tests cover detection,
grace, bounded action, clear, notification retry, persisted deduplication, and
slow-cadence scheduling. Collector derivation tests cover checkout identity,
external web health, unknown runtime health, and named-instance pairing ports.
Worker tests hold host work while the supervisor polls and shuts down. Probe
tests cover cancellation and deadlines. Filesystem tests cover cleanup and
rotation guards, including retry after a partial ENOSPC write.

Run the foreground recovery smoke test after building the checkout binary:

```sh
bun run scoutd:build
bun scripts/scoutd-health-recovery-smoke.ts
```

The script derives a new `dev-health-smoke-<pid>` instance. It injects a
file-controlled projection-open error into a scratch source copy, clears the
fault, verifies a new supervised base pid, waits for `mutationsAdmitted:true`,
and verifies that the projection condition disappears. It stops only its owned
foreground supervisor. It never installs, stops, restarts, or repoints the
shared service. The script prints its state and log locations.

The smoke test disables operator delivery for its dev instance through
`OPENSCOUT_HEALTH_SWEEP_TEST_NO_NOTIFY=1`. That switch is ignored for prod.
Notification routing and actions are covered by the hook tests rather than
sending test notifications to the operator.
