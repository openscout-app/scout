# Local storage limits

## Local search index

`knowledgeIndexEnabled` in Scout `settings.json` is the single opt-in. Its
UI is **Settings › System › Local search index**. It defaults to false on new
and existing installations. Disabling it stops new collection commits and
future CLI, MCP and web indexing jobs. Search, `scout where` and topic-based
`scout check` return an index-off explanation and activation instructions;
they do not interpret missing coverage as no matches. Live checks without a
topic do not depend on this setting.

Once enabled, explicit CLI warm-ups and the web Search background refresh use
the same bounded store. Turning the setting off does not delete raw harness
transcripts. A web-server startup maintenance child can trim an existing
**derived** index even while indexing is off; it does not discover transcripts.

### Byte budget and retention

The ceiling is **268,435,456 bytes (256 MiB)** combined across:

- `knowledge/knowledge.sqlite`;
- `knowledge/knowledge.sqlite-wal`;
- every file in `knowledge/qmd/`, including unpublished leftovers.

QMD counts because it duplicates extracted content and otherwise allows the
same search feature to exceed its disk budget outside SQLite. SQLite shared
memory and the writer lease are small coordination files, not corpus storage.

Before admitting a write, the store checkpoints the WAL and reserves physical
pages for the transaction, FTS merges and QMD publication. SQLite's page limit
and disabled cache spills enforce that reservation even for poorly compressible
content. The at-rest database is deliberately smaller than the overall cap;
headroom is part of the budget, not additional disk entitlement. A pinned WAL
reader or another writer pauses writes instead of growing storage without limit.

Eviction removes complete collections in `updated_at, id` order, including
chunks, facets, source references, FTS entries and owned QMD files. SQLite
space is reclaimed with incremental vacuum. Legacy databases need a full
`VACUUM` to enable incremental vacuum; it runs only when free disk is at least
**twice the current database file size**, as with control-plane archive
maintenance. An inherited oversized database can therefore remain oversized
until readers release it and sufficient disk is available. Repair can bootstrap
a small foreign-key lookup index before pruning an already-oversized cache;
within-cap schema upgrades use the normal reservation. No new indexing is
admitted in that state. Startup cleanup can resume on the next startup or
explicit indexing attempt. No live service restart is required to change the
setting.

The cross-process writer lease covers QMD publication as well as SQLite writes.
Interrupted building collections are not treated as ready; abandoned temporary
QMD directories are reclaimed. Symlinked database/WAL/QMD storage is rejected
rather than followed or undercounted. Paths outside the configured QMD root are
never deleted. If a writer dies before writing its lease PID, verify no writer
is running before removing the incomplete `<sqlitePath>.writer` directory;
ambiguous ownership fails closed.

Capacity eviction clears complete-window claims and exposes bounded coverage.
Index jobs retain at most 100 records and warm spans at most 200 records.
Session-level facets (including touched paths, tools and record kinds/tags)
are stored once per collection and joined into search results; chunks keep
only document-specific facets. All distinct touched paths remain filterable.
The extractor removes harness plugin lists, local-command caveats and system
reminders from turns and nested tool payloads before titling/chunking. Extractor
and chunk-policy versions invalidate earlier extractions.

## Registry liveness and broker events

Canonical registry rows and durable journal upserts retain the **complete
latest record**, including liveness. The following event kinds are appended
only for a first record or a substantive change:

| Event | Liveness-only fields |
| --- | --- |
| `node.upserted` | `lastSeenAt`, `meshEntrypoints[].lastSeenAt`, plus the shared metadata fields below |
| `actor.registered` | Shared metadata fields below |
| `agent.registered` | Shared metadata fields below |
| `agent.endpoint.upserted` | Shared metadata fields; repeated `metadata.lastFailedAt`; `metadata.startedAt` only when `metadata.source` is `scout-channel` |

Shared metadata fields are `metadata.lastSeenAt` and `metadata.staleAt` when
`staleLocalRegistration` or `staleMeshRegistration` is already true. Stale
flags, replacement agent IDs, peer origin, endpoint state and error text are
substantive. The first `lastFailedAt` remains eventful; later identical failure
observations only refresh the row.

Node discovery renews signed cards on each heartbeat. A forward renewal with
finite increasing `card.issuedAt`/`card.expiresAt`, unchanged positive TTL, and
changed nonce/signature treats those four envelope fields as liveness. Card
appearance/removal, signature-only mutations, TTL changes, keys, fingerprints,
TLS, URLs and capabilities remain substantive. The new signed card is still
persisted and used by mesh verification; event suppression does not weaken
verification.

This is an explicit allowlist, not recursive timestamp removal. Creation,
registration, lifecycle and observed-runtime timestamps remain substantive.
No historical events are deleted by this change; the rolling
retention window still governs retained event history.

### Why consumers do not need per-minute registry events

- `broker-durable-record-store.ts` records canonical `*.upsert` journal entries;
  `sqlite-projection.ts` applies those entries to registry rows independently of
  control events. Restart replay therefore retains current liveness and cards.
- `broker-journal.ts` snapshots/compacts registry upserts by identity. Control
  event suppression does not remove registry replay material.
- Mesh discovery, rendezvous and `mesh-peer-filter.ts` read current node
  records/snapshots, not a history of `node.upserted` notifications.
- Web event policies in `client/lib/broker-event-kinds.ts` invalidate roster and
  fleet data on substantive changes. Roster/fleet polling (60 seconds), home
  polling (30 seconds), and independent `presence.updated` events still refresh
  liveness. Chat does not use endpoint upserts as turn progress.
- The runtime SSE feed still carries substantive registry changes. JetStream's
  message publishing is independent of these four event kinds.

## Agent stdout and stderr

Codex app-server and Claude stream-json transports, plus the tmux pane pipe,
use the same byte-bounded writer. Each stdout/stderr stream keeps an active
file of at most **10 MiB** and one `.1` file of at most **10 MiB**. Oversized
single writes are split; old oversized files are bounded on their next write.
Codex retains its ordered wire-log queue, input backpressure, flush-on-close
and error retention; the queue writes through the bounded sink. Rotation is
synchronous in the owning process so pending appends cannot race a rename.
The tmux pipe is self-contained and works in packaged server bundles
under Bun and Node ESM. Inactive historical logs are not swept retroactively.

## Control events reference their record

Most control events announce the record their command just journaled:
`flight.updated` carries the flight, `message.posted` the message,
`invocation.requested` the invocation. When an event's record equals the record
line the journal wrote last for that id, the event line stores its envelope and
`payloadRecord: { field, id, sha256 }` instead of a second copy
(`broker-journal-event-refs.ts`).

- Every journal reader restores the copy before a visitor sees the entry, so
  the SQLite projection, compaction, history rotation and diagnostics receive
  complete events. The digest proves the restored record is the one the event
  carried.
- A tail replay continues from the records its previous pass held, so a record
  written just before the replay cursor still resolves.
- Compaction re-thins against the records its output retains. An event whose
  record line is dropped is written complete.
- An event whose record line is gone is read as `{ id }` with
  `recordUnavailable: true`, never as a different version.
  `unresolvedEventRecordCount()` reports how often this happened; it is 0 in a
  healthy journal.
- Registry events (`node.upserted` and similar) keep their copies: compaction
  keeps only the latest registry upsert, so an older version is not there to
  reference.

