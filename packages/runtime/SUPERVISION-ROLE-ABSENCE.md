# Staged legacy role capture and absence inspection

## Result and limits

The process-sample hypothesis holds only with additional conditions. A
confirmed missing PID or changed boot/birth identity can discharge **that
recorded process**. It does not prove a complete role absent. An executable or
UID change alone does not discharge a process: [exec replaces the process
image](https://pubs.opengroup.org/onlinepubs/9799919799/functions/exec.html), and
inherited listeners or descendants can remain. The inspector therefore treats
a changed executable with the same birth as occupied, and unavailable/foreign
UID evidence as unknown. It never uses generic `different_sample` as absence.

The legacy runtime does not retain a complete durable role inventory. Missing
PID files, empty memory after a restart, stop acknowledgments, health snapshots
or log lines cannot supply the missing coverage. This slice builds the missing
**durable capture surface and conditional inspector**, not a production legacy
capture adapter. Existing machines still return unknown without that adapter.
P1, readiness and live handoff remain closed.

## Measured legacy records

This audit inspected the runtime source at the process-evidence baseline. It
imported no daemon and read no installed app state.

| Role | Existing records and read-only views | Why they do not prove absence |
| --- | --- | --- |
| `web` | `BrokerWebControlService.webServerProcess`; `readChildServiceSnapshots()` and `status()` in `broker-web-control-service.ts` | The child handle is memory-only. Snapshots expose PID/health, invent terminal-relay and local-edge rows, and carry no complete descendant/listener inventory. A null PID after broker restart does not establish absence. The terminal relay is inside web and not probed by that snapshot. |
| `scoutbot` | `BrokerScoutbotService.child` and `pid()` in `broker-scoutbot-service.ts` | Memory-only process handle, no durable native birth/boot record. It does not inventory other resident web answerers or their registrations. The separate assistant claim is not a role-owner or complete absence certificate. |
| `phone-controller` | Base's `pairingProcess`; `pairing-supervisor.ts` reads `runtime.pid`, `supervisor.pid`, `supervisor.json`; web's `core/pairing/runtime/runtime-state.ts` writes/clears the runtime PID | PID-only hints and desired-state/restart intent, without native identity or complete relay/session/listener/mDNS/rendezvous incarnations. Existing helpers collapse missing/invalid/unreadable files to null and use `kill(pid, 0)` for liveness. Those helpers are deliberately not used as proof readers. |
| `app-edge` | Base's `caddyProcess`; `createLocalEdgeAdvertisementOwner()` in `local-edge.ts` holds an internal mDNS child array; base logs Caddy's PID and config path | No durable complete child/advertisement record. The advertisement owner drops its array after requesting stop, not after proving exit/withdrawal. A Caddyfile is configuration, not custody. **Old runtime Caddy and mDNS advertisements both count as occupied evidence.** |
| `menu` | `MenuHelperSupervisor` in `menu-helper-supervisor.ts` holds the PID of the declared helper it found in `ps`, in memory only | The PID is matched by executable path and checked with `kill(pid, 0)`. The supervisor has no exit status, because LaunchServices owns the process. Helpers of other bundles are not inventoried. No complete LaunchServices/login-job/GUI-reopen inventory is retained. |

The mesh bridge's separate `mesh-bridge.json` and coarse `ps` start time are
not an app-role inventory. Neither that record nor process names can fill this
gap. Read-only access to the views above can provide positive occupancy hints;
no negative value in them certifies complete absence.

## New durable capture

`SupervisionHandoff` accepts an optional third argument, `LegacyRoleSources`.
It contains trusted **read-only local adapters**, not request JSON, callback
names, environment overrides or library paths. Default adapters are absent.
No daemon or private host installs them in this slice.

An explicitly authorized R0-to-P1 drain precedes capture:

```
await sdk.exclusive("R0", role, generation, async lease => {
  await lease.captureLegacyInventory(captureId);
});
```

Capture requires the reserved handoff authorization, R0/draining ownership,
resolved receipts and the same stable-inode custody lock. The trusted producer
must verify an approved running artifact, enumerate all old-role resources,
and hold all resource-creation/restart/manual/GUI sources closed with deferred
work quiescent. It must cover descendants and canonical receipt obligations,
not only the primary process. The producer must not infer completeness from
whatever records happened to be readable. These native coverage/barrier
adapters are **still missing**; a version or empty list cannot replace them.

`assertFenced(context)` must verify a retained barrier for the whole enclosing
scope, not merely report two quiet instants. Capture checks it before and after
collection. Source callbacks do not acquire the custody lock again, signal,
start, stop, register or withdraw resources. They only inspect already-held
native barriers and resource state. Failure leaves no complete capture record.

The strict `legacy-role-capture/1` manifest binds instance, role, R0 generation,
capture ID and allowlisted runtime artifact. Every fixed surface below must
exist. An empty surface is the trusted producer's explicit complete census,
not a missing field. Process entries carry the native sample; other entries
carry an exact opaque resource incarnation. Incarnations are non-secret
identifiers, never bearer credentials. Unknown fields, duplicate IDs,
invalid samples or missing surfaces refuse.

| Role | Required surfaces read by this inspector |
| --- | --- |
| `web` | server, terminal-relay, listeners, descendants, jobs, relaunch, in-flight |
| `scoutbot` | worker, resident-answerers, descendants, jobs, relaunch, in-flight |
| `phone-controller` | controller, relay, listeners, mDNS, rendezvous, descendants, jobs, relaunch, in-flight |
| `app-edge` | Caddy, mDNS, listeners, descendants, jobs, relaunch, in-flight |
| `menu` | application, LaunchServices, login-jobs, descendants, jobs, relaunch, in-flight |

The manifest is cloned, then appended inside the existing fsynced custody
journal as optional `legacyCaptures` state. It is keyed by role/R0 generation
and bound to that exact handoff authorization and its floor policy. Changing
the policy invalidates this certificate. No second database or lock is
introduced. Same-ID capture replay is inert. A different capture cannot replace
it or discard an unknown obligation; explicit resume and a new authorized
generation are needed. Old records remain. The staged bounds are 64 resources
per capture and 32 captures globally, also subject to the journal's 16 MiB
limit. Capacity refuses without eviction. These are not production retention.
Torn-append repair and steady-state retention remain rollout gates.

## Reading absence

For a standalone read, call `sdk.inspectRoleAbsence(role, generation)`. Invalid
roles refuse; stale generations, missing/unsafe/corrupt/busy stores and failed
proof reads return unknown. This read grants no authority.

Inside an already-held role scope, call `lease.inspectLegacyAbsence()`.
It uses the same transaction without reacquiring flock. An escaped or invalid
scope refuses. This is the method an ownership adapter should use for a
worker's `absence()` callback inside that scope.

The inspector reads the persisted capture, checks its exact authorization and
role generation, then asks trusted adapters for:

- Positive current-owner `liveOccupants` by surface, including Caddy and mDNS.
  Empty results prove nothing; failure remains unknown.
- Each recorded PID's current native sample, using the existing read-only
  sampler unless an explicit trusted source supplies it.
- Each non-process incarnation's exact `gone`, `occupied` or `unknown` state.
  A different registration, closed port or stop acknowledgment is not `gone`.
- The old source barrier before and after these observations. The barrier
  remains pinned through the read and subsequent protected effect scope.

Positive evidence wins as occupied. Otherwise any missing, partial, failed or
uncertain evidence is unknown. Absence requires every recorded process and
resource discharged, complete coverage, no uncertain SDK effect and a retained
source fence. An adapter checks absence before admitting its native effect. A
pending receipt with no effect intent can be inspected; an existing uncertain
effect intent cannot be ignored or cleared by this read. Current process samples are validated, including PID/instance;
wrong-PID or malformed samples cannot discharge an obligation. No signal is
issued and no process is adopted.

During R0 drain the capture uses that generation and reserved authorization.
After the exact transfer, P1's next generation can inherit it only through the
same used authorization. Resume/reverse generations cannot silently reuse it.
Capture/fence/resource contexts refer to the captured R0 generation;
`liveOccupants` refers to the current owner generation.

**Bootstrap limit:** an inherited R0 capture cannot cover resources later born
under P1. Once the current P1 generation has a recorded start effect, this slice
returns unknown even after a later stop receipt. Full current-owner native
inventory/descendant exit integration is still required for replacement starts.
A recovered start with no recorded child still counts as a birth attempt.
This conservative gate prevents a legacy-only inventory from reporting an
active new role absent. The [direct-child custody adapter](SUPERVISION-CHILD-CUSTODY.md)
now separates missing births, missing direct exits and missing descendant
coverage, but even a proven direct exit does not lift the whole-role gate.
It is not a production restart implementation.

## Consumer and rollout contract

The result is `{ state: "occupied" | "unknown" }` or the existing SDK full
`Absence` object. The worker adapter maps `proof.state` to its existing
`"absent" | "occupied" | "unknown"` result. No worker result enum, pending-receipt
API, receipt identity, role generation or protocol changes. The SDK constructor
and scoped capture/read methods are additive; the staged journal adds the
capture records described above. Consumers must pin a compatible artifact,
not choose a floor from version agreement alone.

This does not automatically replace `HandoffInspector.observe`. Its owned-child
and exact-exit integration remains separate. Do not call the standalone SDK
read from inside an existing role lock; use the scoped method. No reader result
releases ownership, resolves a receipt or opens the production gates.

Production legacy capture producers, integrated protected native exit/custody, complete
current-owner coverage, real legacy effect wiring, native jobs/registration
barriers, repair, retention and operator authorization remain open. No app is
registered, started, stopped, signaled or selected by this capture adapter.
The later [custody fence pass](SUPERVISION-CHILD-CUSTODY.md) adds the read-only
SIGCHLD probe and fixed-library-path policy; it does not add role absence proof.
