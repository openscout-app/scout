# Pairing capsule cutover

`PairingTrustOwner.migrateToCapsule(migrationId, context?)` explicitly converts
one verified v1 store to v2. It is trusted local maintenance, not a phone/RPC
permission. Imports and normal startup do not initiate migration. A read can
help an already committed transition, as it can help an ordinary publication.

The result is `{migrationId, revision, logicalHead}` for the original cut.
An exact migration-ID retry verifies the durable receipt and current capsule,
then returns that original result without a trust mutation. Another ID refuses
after the root has migrated. This ID is separate from trust-mutation IDs.

## Before activation

1. Qualify a **compatible artifact set covering every store opener**: core
   CLI/host runtime and separately built apps. Each artifact must resolve the
   verified v2-aware runtime owner. App and core version numbers need not match.
   Do not ship the engine alone or activate while an installed opener still
   needs v1.
2. Verify release provenance. Build the runtime with
   `bun run --cwd packages/runtime build`; its compiled output must contain
   `trust-owner.js`, `trust-capsule.js`, `trust-cutover.js` and
   `trust-reclamation.js`. Run the source
   census and `bun run test:pairing-capsule`. Test the emitted owner under the
   supported Node 24 runtime, not only Bun source imports:
   `node scripts/pairing-cutover-compiled-smoke.mjs`. The root unit chain builds
   the runtime and runs this version-checked witness too.
3. Check each consuming artifact's dependency lock/build manifest against that
   exact runtime release and package integrity. For a bundled desktop/web
   artifact, inspect its bundler resolution metadata: all pairing owner/identity
   imports must resolve to that runtime, not a copied owner. Verify the installed
   CLI uses the same package. The source census is supporting evidence, not
   proof that an old installed binary was updated. A consuming private build
   needs its own artifact evidence; public source tests do not certify it.
4. **Drain and stop all processes that open this pairing root**, including
   core host runtime, CLI and separately built app processes. Use each program's normal stop mechanism.
   Prevent old binaries, raw editors and pre-owner projection writers from
   resuming. This is a one-time drain/restart, not zero-interruption migration.
5. Keep at least 3 GiB free for qualification. This observation is separate
   from the migration's real 320 MiB reservation. Preserve a diagnostic backup
   under quiescence if historical peer snapshots are needed. Backups are not
   live authority and cannot simply be loaded under another host identity.

Managed deployments must also provide their existing trusted adapter and native
gate. The owner rejects a different observable live invocation or a holder that
does not match actual `currentHolder`. It cannot enumerate versions or detect
every foreign process. Native old-writer exclusion remains the consuming host's
obligation. A dishonest acquisition cannot override a truthful older holder.

## Perform the one-time cut

Run trusted bootstrap code **before any listener starts**:

```ts
import {pairingTrustOwner} from "@openscout/runtime/pairing-security/trust-owner";

const owner = pairingTrustOwner(configuredPairingRoot);
// Managed hosts register their existing typed adapter here. No module loader,
// environment adapter selector or phone-supplied callback is accepted.
owner.pairingAuthorityStamp(); // Explicitly initializes an empty root if needed.
const receipt = owner.migrateToCapsule(stableMigrationId);
// Persist the operation's ID/result in trusted maintenance records, then start
// only the verified v2-aware core and consuming app artifacts.
```

The caller must retain the original migration ID for ACK-loss retry. The method
requires an existing root; an ordinary read of a missing root remains empty and
creates nothing. Explicit stamp initialization above creates no grant.

Migration helps any pending v1 publication using its original consumable
projection source, then captures one coherent verified state. Advisory last-seen
data is not checkpointed as authority. The cut preserves every exact saved
request/outcome/full key, original revision, lifetime byte charge, permanent
managed policy, raw projection bytes and pending standalone adoption baseline.
The #117 authority stamp is byte-identical when authority did not otherwise
change. Migration does not canonicalize the projection or rewrite missing bytes
as `[]`.

## Reservation and publication

An exclusive `.pairing-cutover` directory claims the single migration budget.
Before bulk staging, the owner writes and fsyncs **320 one-MiB files** with
non-sparse, incompressible payloads and checks their allocated blocks. Staged
sources reuse those allocated files, truncate excess bytes and rename within
the claim. The claim, plan, inventory and authority sources all use this pool;
they do not allocate a second bulk copy beside a reservation. Payload storage
stays within 320 MiB, separate from existing authority and filesystem metadata.
Storage that cannot provide the required allocated extents refuses. Thin or
overcommitted storage is not a physical durability guarantee.

Private stages do not put v1 into capsule mode. After complete validation and
fresh baseline/holder checks, the exclusive hard link reserves **the exact next
v1 generation name** with an unsupported-v1 barrier. It competes with the real
v1 writer's CAS. A losing migration publishes no stale capsule and does not
retire the winner. A new attempt needs a fresh verified view.

The barrier authenticates the immutable plan and exact retirement inventory.
Its protected alias must be the same two-link inode. Helpers freshly validate
every outcome chunk, charge record, managed policy and inventory before any
retirement. They consume the single prewritten source for each capsule file by
atomic rename and never recreate it after `ENOENT`. Root synchronization makes
the barrier and capsule durable before retirement. Only inventory-named v1
files with matching inode, byte length and digest may be removed.

After retirement and another directory barrier, a helper consumes the
prewritten cutover receipt, synchronizes it, then deletes transition evidence
and releases the reservation. The permanent barrier and receipt remain.
Cleanup failure refuses readiness and further writes; a current membership
snapshot is not permission to bypass unfinished maintenance.

## Recovery and refusal

| Interruption | Action and invariant |
| --- | --- |
| Before migration CAS | V1 remains authority. Stages grant nothing. The abandoned claim is not reclaimed by age, PID or timeout. |
| Old writer wins the next name | Migration refuses and removes only its proven-owned uncommitted claim. Preserve the old winner; obtain a fresh view before another cut. |
| Barrier reserved, sync/verification incomplete | V1 reader/writer refuse. A v2 read completes from the exact retained sources or refuses. It never serves the old projection as fallback. |
| Barrier durable, retirement partial | V2 validates the complete capsule and inventory, then resumes exact authorized retirement. It never merges the remaining v1 prefix with v2 rows. Listeners remain stopped until ready. |
| Capsule, witness or inventory absent/corrupt | Refuse and preserve evidence. Do not reconstruct missing evidence from current peers, watcher state or process disappearance. |
| Retirement complete, ACK lost | Retry the same migration ID. Verify receipt, root, current capsule and directory barriers. Do not create another logical generation. |
| Paused v1 writer resumes | Its CAS loses or its old verifier refuses the barrier/gap. It cannot recreate a consumed projection source to overwrite a later revoke. |

After a committed barrier, retry a normal owner read or the exact migration ID
with the same managed adapter. If evidence is missing or corrupt, preserve it
for reviewed repair; do not delete the barrier, reset counters or start old
binaries. A receipt does not allow skipping failed resource cleanup.

For an **uncommitted** abandoned claim, prove all writers stopped first and
preserve the complete file inventory. Confirm the real v1 reader still verifies
the contiguous store and no committed barrier exists. Only then may reviewed
quiescent maintenance move the entire private staging directory outside the
active root, retain it as evidence and retry from a fresh view. Do not do this
after a barrier has won. The runtime provides no automatic takeover or
uncoordinated discard API.

## Slot reclamation and recovery

Ordinary v2 writers use structural reclamation. Each writer constructs a unique
`.pairing-claim-<uuid>` directory with its complete token file, synchronizes the
file and directory, then renames it onto a canonical `.pairing-v2-slot-N`.
Canonical slots are never directly created with `mkdir`. Every v2 writer must
use this protocol: the one-time drain also covers dormant R1 binaries that can
read v2 but still directly create slots. The exact combined release cohort is
required, not merely a v2-aware binary. Rename can atomically
replace an empty directory, but refuses a nonempty live claim on APFS and Linux.
The writer synchronizes the root before staging any bulk files. Claim tokens,
not persistent inode identity, bind ownership; descriptor pins protect each
check/use interval.

A slot emptied by release is already abandoned. If the releasing process dies
before `rmdir`, the next writer replaces it safely. A paused late release cannot
remove the replacement's nonempty token. Eight live token-bearing claims still
refuse a ninth writer. Eight abandoned empty slots do not brick revocation:
the next real mutation reclaims an empty slot and can revoke immediately. This
is structural authority, never an age, PID, process-disappearance or timeout
judgment.

A process can die before exposing its candidate or while holding a nonempty
uncommitted claim. Those objects are not automatically declared dead. A private
pre-rename candidate contains only one small token, no bulk files and no
authority; it consumes no canonical slot. For such metadata, or capacity occupied
by nonempty uncommitted claims, the trusted operator can recover under explicit
quiescence:

1. Stop every core host, CLI, separate app and maintenance caller. Prove that none
   can still access the root; do not infer quiescence from elapsed time.
2. From trusted local maintenance code, call the canonical owner operation with
   a stable recovery ID. The assertion is an operator fact, not a liveness test:

   ```ts
   const receipt = owner.reclaimCapsuleStaging(recoveryId, {quiescent: true});
   ```

   Call this **outside** any existing owner invocation. An observable holder or
   live invocation refuses before acquisition. Managed roots still require
   their matching registered adapter for this operation's own gate. The method
   cannot discover unobservable foreign processes; keep all users excluded.
3. Preserve the returned receipt and evidence. The operation first completes
   committed publications using the existing owner recovery protocol. It then
   freshly verifies the completed capsule and every full token before moving
   only unreferenced canonical claims, their exact token-qualified payloads,
   and complete pre-rename candidates. A committed claim is completed, never
   treated as abandoned. A reused slot index is not an ownership reference;
   the full token must match. No PID, age, timeout or process-disappearance
   inference is used.

   The retained evidence is a private sibling directory:
   `<canonical-root>.pairing-reclamation/op.<recoveryId>/`. It must be owned,
   non-symlinked and on the same filesystem. `plan.json` binds the root,
   verified authority and each resource's token, identity, byte length and
   digest. Payloads move before their claim directory, so every interrupted
   partial state remains readable. Files and directories are synchronized;
   each move is followed by evidence-directory and root synchronization.
   Token-bearing staging resources are moved by rename, never deleted. Normal
   committed-publication recovery retains its existing exact retirement rules.

   Retry the **same ID** after interruption or lost acknowledgement. The
   operation verifies each artifact at its source or retained destination,
   resumes the remaining moves, synchronizes again and freshly verifies current
   authority. It never overwrites an unrelated destination. `receipt.json` and
   the returned receipt list every source, retained destination, full token,
   kind and non-reference reason, plus plan hash and the verified authority.
   An exact retry returns the original receipt only after fresh verification;
   it is not a cached membership result. Reclamation itself creates no trust
   generation.
4. With callers still stopped, run a complete owner read and a deliberate
   trusted local mutation before restarting listeners. Use the normal owner
   API for the intended trust change; do not edit the projection. The process
   suite proves that a real revoke succeeds after recovery of eight stranded
   claims and after each interrupted maintenance move/synchronization.

Empty candidates and empty slots have no complete token. They are retained and
reported, not inferred dead or deleted by this operation. Ordinary writers can
already structurally reclaim empty canonical slots. Corrupt/incomplete token
records, ambiguous resources, referenced payloads, changed root/files,
conflicting evidence or a plan exceeding one MiB refuse and retain evidence.
A scan exceeding 1,024 candidate/slot directories also refuses. These are
maintenance bounds, not changes to the eight-slot or authority-store limits.

The pre-CAS **`.pairing-cutover` migration directory is not covered**. The
operation requires a fully verified v2 capsule; a still-v1 root refuses with
`reclamation_capsule_required` and an abandoned pre-CAS cut retains
`migration_busy`. The earlier reviewed offline migration repair procedure
still applies there. Malformed claims, partial/corrupt maintenance plans and
unknown obstructions likewise require reviewed offline repair rather than
normal file surgery or guessed ownership. Preserve them; never reset a barrier,
remove authority, delete token evidence or infer that a writer is dead.

There is no remote endpoint, startup hook, automatic collector or environment
selector for this method. The code replaces routine slot/candidate recovery,
not the operator's proof of quiescence or exceptional forensic repair. Tests
use real process exits before and after every move and sync, retained-byte/receipt checks,
holder/invocation refusal, committed-publication help, platform collision
injection and paired healthy/broken-source controls.

## Inherited limits and qualification

Pre-owner raw-projection writers are **not excluded** by the cut. Standalone
adoption remains unchanged and can import an outside grant or revocation.
Managed mode detects projection changes but still needs real old-writer
exclusion. Checksums do not prevent a same-user editor from forging the whole
root, and neither format supplies a durable anti-rollback anchor.

Historical peer snapshots are retired, not freshly replayed on admission.
External archives are diagnostics; their hashes do not prove unread bytes.
All retained outcomes and current authority are freshly read and verified.

The process suite pins and hashes the byte-exact v1 owner's entire recursive
import closure (`trust-owner.ts`, `support-paths.ts`, `instance.ts`) from
509c7595, without current-code shims. All three sources ship with the fixture
for shallow CI. The suite interrupts every table row,
tests both CAS outcomes and paused old writers, measures actual reservation
extents/barriers, and checks source mutations against healthy fixtures. The
read gate must run on **real migrated stores** at both tiers/Buns, three fresh
processes each, with every 100 warmup and 1000 timed sample retained. This does
not certify native deadlines/power loss, registry admissions/idle CPU, transport
close codes, credentials or physical phones.
