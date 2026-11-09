# Pairing trust owner contract

The public runtime owns pairing trust persistence for one resolved pairing root.
The unified core host pairing, reconnect membership checks and host peer-delete
route use this owner. `packages/pairing/src/core/pairing/runtime/security`
re-exports runtime identity/security; it has no independent trust writer.
Separately built apps must consume this authority rather than copy its writer. Phone pairing is not operator-decision
entitlement. This mechanism introduces no host policy, input actuator, session
registry, authorization endpoint or automatic adapter installation.

## Public interface and compatibility

`@openscout/runtime/pairing-security/trust-owner` exports `pairingTrustOwner`,
`PairingTrustOwner`, `PairingTrustError` and the transaction types.

- `read(context?)` returns an owned snapshot of authoritative peers and the owner
  revision, with display-only advisory `lastSeen` values merged in memory.
- `mutate(expectedRevision, mutationId, mutation, context?)` publishes one grant,
  full-key revoke, or explicit managed adoption. A conflicting revision
  refuses. There is no automatic retry of a relative change.
- An exact mutation-ID/request retry returns the persisted original outcome,
  including after a later revision or a lost ACK. Reusing an ID with another
  request refuses. Keep the original expected revision when retrying an ID.
- `refresh(publicKey, lastSeen, context?)` validates current membership, then
  best-effort records display-only metadata in `trusted-peers.last-seen.json`.
  It refuses a missing/revoked key. Advisory I/O failure never fails the
  handshake. Handshake completion uses this check for existing peers, including
  `trustOnComplete:false` paths. A reconnect never changes the digest-covered
  projection or creates a generation. `lastSeen` is never an admission input
  or proof of current presence.
- `revokePrefix` resolves either the existing 16-character display prefix or a
  full 64-character key against the current snapshot. The persisted operation
  and outcome always name the full key.
- `migrateToCapsule(migrationId, context?)` is explicit trusted local maintenance.
  It preserves logical authority and exact retries while changing the retained
  representation. Follow the [cutover runbook](./pairing-capsule-cutover.md)
  before activation; no remote permission or automatic upgrade is provided.

**API behavior change:** `DELETE /api/pairing/peers/:fingerprint` returns **409**
for an ambiguous prefix instead of deleting all matching keys. Use the full
public key to select one peer. A missing peer remains 404. An unavailable store,
including a CAS/publication failure, returns 503 rather than a false success.

`trusted-peers.json` retains the `TrustedPeer[]` JSON shape. Successful publication
updates this file atomically; it is not a stale compatibility mirror. Existing
valid stores are adopted lazily on their first mutation, without an opt-in lock.
A read of a missing root is empty and creates nothing. Explicit mutation creates
an owner-controlled root if needed. New directories have mode 0700 and their
parent creation is synchronized. New files have mode 0600. Legacy peer files can
be readable by group/others, but must be owner-controlled, non-writable by them,
regular, single-link and non-symlink. Owner metadata and marker files require
0600 discipline. Invalid or unsupported state refuses instead of granting trust.

## Advisory last-seen file

`trusted-peers.last-seen.json` is separate from the authority chain and projection
digest. Its shape is `{schema: "scout.pairing-last-seen/v1", entries: [...]}`,
where each entry has a full `publicKey` and a parseable timestamp `lastSeen`.
It affects display and sorting only. The owner never uses this file for
admission, membership, grant or revoke, and never copies merged metadata into
an authority publication.

Reads merge entries only for current authoritative members. The later timestamp
wins between the projection and advisory file, with `pairedAt` as the grant-time
floor. Thus an old binary's newer projection timestamp still counts. A missing,
malformed, oversized or unsafe advisory file is ignored, never quarantined.
Non-member entries cannot restore a revoked key and are pruned on the next
successful refresh write. Writes contain at most one entry per authoritative
peer (4096 maximum), within the existing 1 MiB per-file limit.

The owner stages a new owned mode-0600 regular file, synchronizes the file and
replaces the advisory path by rename without following a destination symlink.
Reads reject symlinks, hard links, wrong ownership or group/other permissions;
they use nonblocking, no-follow opens. Broken or unsafe files can be replaced by
the next successful refresh. If staging, synchronization or rename fails, the
owner ignores that failure and cleans up its temporary file. No directory sync
is required for this file. A non-file obstruction can prevent replacement but
cannot make authority unavailable or fail a handshake.

Updates need no managed gate and remain **outside managed guarantees**. The
membership check still obeys the authority contract. Concurrent refreshes in
two processes can lose one advisory update. Crash or I/O failure can also lose
an update, so `lastSeen` can lag; the projection/grant timestamp remains the
floor. A concurrent revocation can leave a stale advisory entry, but reads
ignore it because it is no longer an authoritative member.

## Named on-disk delta: `scout.pairing-trust-owner/v1`

The same root gains immutable `trusted-peers.owner.<revision>.json` generations.
Each is an envelope containing a `generation` and its SHA-256 checksum. A
generation contains:

- schema, root identity (see [Root identity](#root-identity)), and contiguous revision;
- hash of the previous generation's bytes (the legacy seed hash for revision 1);
- the complete peer array and the digest of its exact JSON projection;
- the managed marker value, or null;
- that revision's mutation-ID/request/outcome record, including full-key revokes;
- optional `adoption` hashes (`fromProjectionHash`, `toProjectionHash`) recording
  an unmanaged outside baseline used by this mutation, or null;
- `projectionStage`, the basename of the already-synchronized projection stage,
  in new envelopes. Completed older envelopes remain valid without this field.

The owner reconstructs deduplication from every immutable generation. It does not
copy the entire historical outcome map into each successive file.

Mutation outcomes are not pruned. The owner refuses at 65,536 generations, 1 MiB per
file, 128 MiB of generation bytes, or 4096 peers. There is no automatic compaction,
reset or age-based loss of deduplication. Capacity/recovery/migration must be an
explicit reviewed operation; deleting owner metadata is not a supported reset.
Only real trust mutations (grant, revoke, managed adoption) grow this chain.
The dormant v2 representation below reduces retained peer snapshots. It does
not reset these limits or activate compaction for an existing store.

There is no mutable head pointer and no new unmanaged cross-process lock.
A writer stages and synchronizes the peer projection and complete generation,
revalidates its baseline, then hard-links the generation to the unique next
revision name. `EEXIST` is a CAS refusal. Only that winner can replace the peer
projection by rename. The staging hard link remains until that rename, so a
reserved generation has two links and cannot be mistaken for a completed
unmanaged baseline. Generation reads tolerate two links, but require exactly
one matching protected staging alias; projections still require a single link.
After rename, the owner removes its staging link, synchronizes the parent
directory, verifies the committed chain and only then ACKs. An ID retry also
synchronizes the directory before returning its recorded outcome, so a prior
failed directory sync is not mistaken for a durable ACK.

### Pending publications and roll-forward

A pending generation retains its protected staging hard link and its
synchronized projection source, even if projection rename fails. The next
owner read, refresh or mutation helps finish this publication. Unmanaged
completion needs no new lock; managed completion runs under the operation's
already-held adapter gate. The owner validates the whole chain, root identity,
marker and gate context before attempting completion. Missing generations,
gaps, corrupt checksums, marker mismatch and ambiguous staging aliases still
refuse. Completion cannot bypass those checks or create a missing marker.

The owner encodes the head generation's peers and checks their hash against
`peersHash`. It also verifies the shared projection source's bytes against that
hash before rename. Original writer and helpers consume the **same** named
source by atomic rename. They never recreate a consumed source. Thus only one
rename can succeed, even if the original writer was merely slow, not dead.
A late writer treats `ENOENT` from that rename as another helper's completion,
verifies the current chain/outcome, synchronizes the directory and returns its
original outcome. It does not replay a mutation or overwrite a later revoke.
If another owner already advanced the head, the original writer verifies its
recorded outcome without rewriting the projection.

Older envelopes without `projectionStage` can recover from a unique retained
projection temp with the verified head hash. Absence or ambiguity with a
mismatched projection refuses; the owner does not guess or create an
uncoordinated replacement source. A new generation always binds its source
before reserving the revision and retains it on publication failure.

A pending stage is classified as `publication_incomplete`, not `unsafe_path`
or an outside-write diagnosis. Ordinary operations complete valid pending
work transparently. If completion cannot finish, or a reentrant observer runs
inside the rename, they refuse `publication_incomplete` without exposing an
old projection. A managed store with a changed projection **and no pending
stage** still refuses `external_change_or_incomplete` strictly. No ACK does
not imply rollback; no age-based takeover or process-liveness guess occurs.

An old binary can write the projection while unmanaged publication is pending.
Roll-forward overwrites that outside write with the reserved head's peers.
This is consistent with unmanaged mode's lack of outside-writer protection.

#### Manual completion

Retry an owner `read()` with the same pairing root to request completion; the
original mutation ID is not needed. A managed host must supply its existing
trusted adapter and hold the normal gate. An exact-ID/request retry also
finishes pending work and returns the original recorded outcome, without a
new generation. Do not remove a generation, marker or staging witness to reset
the store, and do not retry a relative mutation with a fresh expected revision
as a substitute for recorded-ID retry.

If `publication_incomplete` persists, preserve the files and stop all writers,
including old binaries, before manual repair. Under that proven quiescence
(and the managed gate where applicable), reviewed maintenance can validate the
root/chain/marker, reconstruct the exact projection from the head's peers,
verify its `peersHash`, stage/synchronize it, atomically replace the projection,
quarantine unusable projection-source temps if necessary (never the generation
witness), and invoke owner completion to synchronize the directory and remove
the witness. Never reconstruct a consumed source while a paused writer could
resume. Missing/corrupt authority evidence or marker mismatch needs separate
reviewed repair, not this projection-completion procedure.

Readers verify checksums, sequence, root identity and managed state. They refuse
a concurrent changed generation listing instead of combining snapshots. In
managed mode, projection-digest mismatch refuses strictly, without a watcher.
In unmanaged mode, a validated changed projection is the current baseline, as
specified below; it does not rewrite the existing owner ledger.

The file and directory barriers are actual synchronous filesystem `fsync`
operations. This is a specified filesystem publication model, not hardware
power-loss certification. Native bounded cancellation/durability qualification
for a host's combined authority-and-journal hold is a separate prerequisite;
this additive seam does not certify it. A JavaScript timeout cannot release a
host gate while an uninterruptible native operation continues.

## Completed-v2 store and explicit cutover

The same runtime owner can read, mutate and recover a **completed**
`scout.pairing-capsule/v2` store. New stores and existing v1 stores still write
v1 until trusted local maintenance explicitly calls
`owner.migrateToCapsule(migrationId, context?)`. There is no environment activation
flag, remote route, listener hook or automatic startup upgrade. Ordinary reads
can complete an already committed cutover; they never initiate one.

The completed-store engine and cutover ship together. **No upstream milestone
may carry the engine without the cutover.** See the
[cutover runbook](./pairing-capsule-cutover.md) for the one-time drain, actual
320 MiB reservation, recovery and compatible-artifact verification for every core and app store opener. The live-session registry is a separate follow-up. Storage cutover
does not add transport close codes or credential behavior.

### Retained authority and logical identity

A completed v2 store retains these root-bound files:

- One permanent `trusted-peers.owner.<cut-revision+1>.json` barrier. It commits
  to the last v1 logical head, initial outcome digest, policy, legacy byte
  charge and initial chunk inventory. A missing completion receipt in
  `trusted-peers.v2.cutover.json` refuses unless the committed barrier and its
  retained transition evidence permit verified roll-forward.
- One current `trusted-peers.v2.commit.<serial>.json` capsule. It contains
  current peers, logical revision and head, exact projection digest, complete
  outcome-chunk inventory, permanent managed policy, charge, candidate claim
  and bounded retirement record. During collection, the previous commit can
  also remain. More committed epochs refuse.
- Immutable `trusted-peers.v2.data.<token>.json` outcome chunks. Each row stores
  mutation ID, logical revision, type, full key, changed flag, **exact request
  string**, legacy byte charge and any managed-adoption marker. All rows are
  retained in logical order. Initial cut chunks never change; later writes
  copy only the last post-cut chunk or append a new chunk.
- A `trusted-peers.v2.done.<serial>.json` collection receipt binding the current
  physical capsule hash. The barrier and initial cut receipt remain permanent.

Every authority operation opens, hashes and validates every retained outcome
chunk and row. There is no positive cache, mtime shortcut, skipped prefix or
unverified checkpoint fast path. The reader validates the contiguous logical
revisions, unique IDs, byte-charge sum, complete and initial outcome digests,
current peers and projection, marker, root and managed invocation. A changed
early chunk refuses after warm reads as well as cold reads. An unexpected
v1 generation in the active namespace refuses. An unsupported highest serial
refuses; the reader never falls back to an older readable capsule.

The first capsule keeps the v1 **logical** head. It does not substitute the
physical capsule checksum in the pairing authority stamp. Later mutations
advance the logical head from the previous logical head, current peer digest,
policy, exact request/outcome, adoption and complete outcome digest. Physical
serials identify publications, not logical authority. Fixture tests prove stamp
continuity across both synthetic completed fixtures and real migration.

Three hashes remain distinct: the last committed logical peers hash, the
normalized current checkpoint peers hash and the exact raw projection-byte
hash. Standalone outside-write adoption preserves the original logical baseline
and records the changed raw hash on the next mutation. Reads do not canonicalize
the outside file. A missing projection uses the empty-byte hash. Encoded `[]`
and noncanonical JSON have different raw hashes. An empty file is malformed JSON
and refuses. Managed projection changes refuse.

The managed policy is derived from the retained adoption row and checked
against the barrier and head. Deleting the marker or clearing a head flag
cannot turn managed history into standalone history. The real registered
adapter, invocation and current holder are still required. The inherited
outside-writer and same-user-forgery limitations below remain unchanged.

V2 gives up fresh replay of retired historical **peer snapshots**, not outcome
history or current membership. An external archive is diagnostic material,
never authority. A checksum of archived bytes does not verify unread bytes.
Neither format provides a durable anti-rollback anchor against a same-user
editor who forges the entire root.

### Publication, recovery and bounded collection

A writer prepares a unique `.pairing-claim-<uuid>` directory with its complete
token file, synchronizes both, then atomically renames it onto one of eight
`.pairing-v2-slot-<0..7>` directories. It never directly creates a canonical
slot directory. A directory rename replaces an empty destination atomically;
a nonempty live claim refuses replacement (`ENOTEMPTY` or `EEXIST`). The root is
synchronized before any bulk staging. Only eight canonical claims can stage
bulk payloads, each within its 3 MiB bound.

**An empty canonical slot proves abandonment.** No live claim is exposed before
its token exists. A crash after token unlink leaves a safely replaceable empty
slot; the next writer can reclaim it without an operator or ownership guess.
Two claimants racing that empty slot have one rename winner. A stale release
cannot remove the winner's nonempty claim. Claim tokens identify ownership over
time; device/inode alone does not. Inventory, sync and release retain directory
descriptor pins across their check/use intervals.

Pre-rename candidates contain only the small token, never bulk payloads or
authority. An interrupted candidate does not consume a canonical slot or enter
the authority inventory. Nonempty canonical claims remain occupied and are
never inferred dead. No PID, age, timeout or inode-only takeover exists. See the
[cutover and recovery runbook](pairing-capsule-cutover.md) for quiescent cleanup
of interrupted candidates or nonempty uncommitted claims.

Before bulk staging, the writer checks the 3 MiB candidate budget, 1 MiB file
bound and resulting authority limits. It writes and synchronizes the new
chunk, projection, capsule, optional first managed marker and collection
receipt source. It synchronizes the directory, freshly revalidates its
baseline, and asserts all prior rows are unchanged. An exclusive hard link
to the exact next serial is the CAS. A competing winner causes refusal, not
an automatic retry or relative-update merge.

The commit staging link remains as a pending witness. Original writer and
helpers atomically rename the **same pre-staged source** to publish the marker
and projection. They never reconstruct a consumed source. After verifying the
current head and projection, they unlink the witness and synchronize the
directory. Before collection they establish another directory barrier. Only
files named in the capsule's retirement record can be removed, after checking
their recorded inode and byte hash. The record contains at most the previous
commit, previous receipt and replaced last chunk. The collector synchronizes
retirement, consumes the pre-staged collection receipt by rename, synchronizes
again, then releases the claim. A late helper cannot overwrite a later revoke
or recreate a retired receipt. Exact-ID retries return the original outcome
after establishing durability, even after lost ACK or later mutations.

A collector failure refuses reads and new mutations until completion succeeds.
It never authorizes unbounded accumulation of retired epochs. A resurrected
retired file beside a completed collection receipt refuses. Uncertain CAS I/O
retains candidate evidence rather than deleting a potentially committed source.
Structural errors retain their precise refusal codes; unavailable publication
or collection never returns an old positive snapshot.

The bounds remain 65,536 logical mutations, 4096 peers, 1 MiB per file and
128 MiB lifetime legacy-generation charge. Compaction preserves each old charge;
new mutations charge the canonical v1-equivalent envelope size. Current retained
capsule authority is also limited to 128 MiB and 256 chunks. Compatibility
projection bytes and the separately bounded staging claims are not counted as
retained authority. Reads are linear in all retained outcomes, not constant
time. The 65,536 format ceiling is not a latency qualification.

### Completed-store verification

Run the regular owner suite plus the capsule fixtures and controls:

```sh
bun test packages/runtime/src/pairing-security/trust-capsule.test.ts \
  scripts/pairing-trust-owner-process.test.ts
bun scripts/pairing-capsule-controls.ts /tmp/pairing-capsule-evidence
bun scripts/pairing-capsule-benchmark.ts realistic
bun scripts/pairing-capsule-benchmark.ts large
```

`bun run test:pairing-capsule` runs the process/census suite and planted capsule
and cutover controls in the root unit-test chain, including hosted CI when dispatched. Give
the controls an explicit evidence directory to retain their individual logs.

Process tests interrupt actual writes at staging, CAS, directory barriers,
projection consumption, witness removal, collection, receipt consumption,
claim release and ACK. They also pause two next-serial contenders and late
helpers, inject candidate/collector failures and recover managed publications.
Source controls deliberately cache a positive, skip an early chunk, erase
managed policy, substitute a physical stamp or reset the byte charge. Each
healthy fixture must pass before its isolated broken-source copy fails.

The production-owner gate uses 100 generations/4 keys and 10,000/32, three fresh
processes per tier on each supported test Bun. Each path (`read` and stamp) gets
100 warmups then 1000 timed reads; raw samples and CPU time are emitted. Every
run must independently meet p50/p95/max of 5/15/50 ms and 25/75/200 ms respectively.
The runner stops on a timed maximum breach or failed percentiles. This qualifies
the migrated-store read path, not registry admissions, gate holds,
idle CPU, native durability or physical phones.

## Root identity and external writers

All default call sites use `resolveOpenScoutPairingHome`: the supported
`OPENSCOUT_PAIRING_HOME`, `SCOUT_PAIRING_HOME`, `OPENSCOUT_PAIRING_DIR`, explicit
`OPENSCOUT_SCOUT_HOME/pairing`, and instance defaults have one path resolver.
The owner normalizes lexical/ancestor aliases, binds the root's device/inode
for the life of the open owner, and checks that identity around I/O. A final symlink root, symlink data file,
hard-linked data file, wrong owner, writable-by-others root/file or replaced
bound root refuses. Different roots have separate owners. Aliasing an ancestor
does not create a second owner; final symlink roots remain unsupported.

**Unmanaged mode offers no protection against outside writers**, as before.
During a mixed-version rollout, an older installed binary can normally rewrite
`trusted-peers.json` directly. Reads adopt that validated array as current peers,
without changing owner revisions or mutation-ID outcomes. The next owner trust
mutation derives from that array and records its baseline adoption hashes.
Deletion adopts an empty baseline; malformed or unsafe files still refuse.
The chain remains the owner's own CAS/deduplication ledger, not a quarantine
instrument for legacy projection writes. Owner callers get lost-update refusal
among themselves and full-key revocation. An outside writer can still lose an
update or resurrect a revoked key; unmanaged mode does not claim otherwise.

**Strict external-change refusal starts at managed adoption.** An out-of-band
active-file grant, revocation or deletion then makes the store unavailable;
it is not imported. Registration alone does not turn a root into managed mode.
The marker/generation pairing remains mandatory, so missing a marker cannot
downgrade an already managed generation into unmanaged adoption. Generation
checksums detect accidental metadata edits, not a hostile same-user editor
that forges the entire store and its checksums. This is not same-user sandboxing.
Detection cannot cancel an operation admitted before an external write.

**A managed marker cannot constrain an old binary that does not check it.**
Old binaries and raw editors are unsupported writers after managed adoption.
Detection is not exclusion. A consuming host must separately prove old-writer
exclusion before relying on gated admission. A store's records are bound to
the host pairing identity, not to a path or inode; see [Root identity](#root-identity).

## Root identity

Persisted records carry `rootId: "r2:<hex>"`. The hex is an HMAC-SHA256 over the
label `scout.pairing-trust-root/v2`, keyed by HKDF-SHA256 (info
`scout.pairing-trust-root-key/v1`) of the host pairing private key in
`identity.json` in the trust root. The id survives reboots, device renumbering
and moves, and reveals nothing in plain text. A new host identity yields a new
id, so the old store refuses with `generation_invalid`: paired peers pinned the
old key. Without a readable identity the owner refuses with
`root_key_unavailable` (or `root_key_unsafe` for a group- or world-writable
file) when it first needs the id. `PairingTrustOwnerOptions.rootKey` injects
another key source.

Records that name a file or directory inside the root (the cutover claim,
capsule slot claims, retirement and reclamation proofs) carry
`identity: "o2:<hex>"`, an HMAC with the same key over the root id, the inode
and, on macOS, the birth time. It detects a replaced object without exposing
its inode.

`dev:ino` is used only within one process: `root_replaced` while an owner is
open, and the lstat/fstat matches around each read. It is never persisted:
`st_dev` is assigned at mount time and can change across a reboot.

Stores written before this format carry legacy `dev:ino` ids. A legacy root id
is accepted when its inode matches the current root's, and a legacy object id
when its inode matches the object's; the device part is ignored. New records
use `r2:` and `o2:`. Managed markers are compared after normalizing their root
id, so a legacy-to-`r2:` transition is not a `managed_downgrade`. A legacy store
copied to a new directory (a new inode) still refuses. After the first `r2:`
write, a binary that predates this format refuses the store. Historical
capsule rows are carried byte for byte and keep their original ids.

## Dormant managed-store seam

The factory installs no adapter. Imports perform no filesystem or process work.
Unmanaged standalone operation uses CAS and needs no host package. Only trusted
bootstrap code can call `owner.register(adapter)` with typed function references.
There is no environment, request JSON, CLI flag, module-path loader or remote
provider registration route. Registration is not an untrusted-plugin sandbox.

An adapter identifies its supported protocol by a stable ID and implements
`withGate(root, body)` plus `currentHolder(root)`. It must acquire the native
cross-process gate for that canonical root and hold it until the callback
settles, including Promise results, with release on every exit. Synchronous
legacy writers require synchronous adapter acquisition; an adapter must not
pretend an async lock was acquired. The callback's holder object is checked by
identity against `currentHolder` at operation boundaries. The generic mechanism
cannot establish a dishonest adapter's native ownership; native qualification
belongs to the trusted host's separate evidence.

Managed adoption requires a registered adapter, an invocation context, expected
revision and mutation ID. It publishes the protected root-bound
`trusted-peers.managed.json` marker (`scout.pairing-trust-managed/v1`) and its
matching generation. It creates no operator entitlement. Adoption is explicit
migration; startup never performs it. Missing adapter, wrong adapter ID, unknown
marker protocol, missing marker/generation, mismatched root or partial adoption
refuses. No unmanaged fallback is permitted once the managed generation/marker
exists. Removing a registration does not remove the marker.

`withInvocation(body)` supplies an opaque context. It is non-serializable,
root/owner-bound, valid only inside that live invocation and its current gate
holder, and permits at most one new publication. An exact already-recorded ID
retry is not another publication. Captured contexts fail after return, in a
different concurrent invocation and in another process. Internal reads can
repeat; nested gate acquisition is unnecessary when a valid context is passed.
The adapter must preserve the host's authority-before-journal lock order.
Human approval and editor waits must occur outside both locks.

The full-key live-session transport registry and any cross-owner commit manifest
are not implemented here. A host's stronger multi-record transaction cannot be
inferred from this single-owner publication protocol.

## Verification

Run on a non-root account with adequate disk space:

```sh
bun test packages/runtime/src/pairing-security/trust-owner.test.ts \
  scripts/pairing-trust-owner-process.test.ts \
  scripts/pairing-trust-owner-census.test.ts
bun scripts/pairing-trust-owner-controls.ts /tmp/pairing-owner-evidence
bun scripts/pairing-trust-owner-census.ts
bun run sync-exec:fence
bun run check:presentation
```

The process suite coordinates two real processes without sleeps as an ordering
proof, tests reconnect storms (zero generations and unchanged projections),
current advisory timestamps, unsafe-file replacement, old-binary timestamp
merging, unmanaged adoption and managed refusal, ACK loss and publication
interruption. Crash tests recover both unmanaged and managed publications;
a two-process live-writer race proves a helper and later revoke survive the
original writer resuming. Real Noise handshakes through the unified core bridge also complete through
injected advisory sync/rename failures. The suite instruments actual
file/directory barrier calls. Its instrumentation must observe operations; no-op
instrumentation fails. The negative controls use disposable mutated source
copies, not production switches or edits to the checkout. The source census
also tests a planted direct sink/default registration/adoption. It is an audit
of the known persistence routes, not confinement of arbitrary filesystem code.

## Explicit relay pairing

New relay grants use a single-use, root/room/baseline-bound local opportunity.
See [relay pairing opportunities](./relay-pairing-opportunities.md) for opening,
expiry, cancellation, reconnect behavior and the limits of pairing revocation.

## Exhaustive authority views

`owner.readAuthority(context?)` returns `{revision, peers, stamp}` from one
verified owner operation. `peers` is a detached authority snapshot, without the
advisory last-seen merge. `stamp` is byte-identical to `pairingAuthorityStamp()`
on the same completed authority. Like that stamp method, a missing root is
created before the operation. This local API installs no listener, migrates no
store and registers no transport session.

The capsule view and full read use the same structure, row, digest, policy,
capacity, inventory and holder validation. Only materialization is a parameter.
Every call rereads, hashes and validates all retained authority. The view keeps
only the duplicate-ID set and last row instead of the saved-outcome lookup,
all parsed rows and all chunk buffers. No result survives between calls.
Legacy reads retain their full validation and materialization.

A pending publication completes or refuses before the view returns. Completion
uses a full state, then a fresh exhaustive view. Mutation, exact retry and
recovery still use the full build by default. `read()` retains its advisory
metadata behavior; consumers must not combine independent reads and stamps to
pretend they have one coherent authority view.
