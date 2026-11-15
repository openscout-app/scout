# Derived records

## Role

A derived record is something made from a work item, by code or by an agent:
a presentation for a board, a label, a digest. It names the item version it
read. A reader uses it only while that version is current, and otherwise
shows the item as it is. A derivation that is late, wrong or missing never
breaks a page.

The runtime is the only writer. Scout already guards stored derivations
this way elsewhere: the search index keeps a content hash, routing docs keep a
source hash, and a work review names the placement revision it judged.

## Model

- `DerivedRecord { schema, kind, sourceId, sourceVersion, producer { id, kind, version? }, body, generatedAt, flightId? }`.
- One record per kind, kept in the item's `metadata.derived[kind]`. Only the
  latest is kept; a derived record is a cache, not history.
- The source version is `r<placement revision>.u<updatedAt>`
  (`collaborationRecordVersion`). A derived write leaves `updatedAt` as it is.
  So the write never reorders a board, never counts as activity, and never
  makes itself stale. Any other change to the item does.
- Read rule (`readDerived`): `current` when the version matches (and the
  producer version, when the reader passes one); `stale` otherwise, with the
  old record attached; `missing` when there is none.

## Making them

A lifecycle station names what its items need:

```json
{ "id": "waiting", "derive": [
  { "kind": "presentation", "instructions": "Pick what to show.", "skill": "work-board-curator",
    "projectPath": "/path/to/project", "harness": "claude" }
] }
```

- **Pending is computed, not queued.** An open item needs a kind when its
  station names that kind and the item has no current record of it. A
  restart finds the same set.
- **Pull.** Without `projectPath`, pending items wait for a producer:
  `derived_pending`, then `derived_write`.
- **Push.** With `projectPath`, the runtime starts one ordinary ask: a fresh
  one-time session in that folder, under the caller `scout.deriver`, labelled
  `scout:derived`. The request id is `derive.<workId>.<kind>.<version>`, so a
  retry is idempotent. The runtime allows one ask per item and kind per
  15 minutes and at most 50 asks a day. A change to a work item triggers a
  pass, and so does startup. Bursts coalesce into one pass.
- Work labelled `scout:derived` is never derived from itself.

## Invariants

- A write names the version it read. A write against an old version returns
  `stale` and changes nothing.
- A client write to a collaboration record keeps the runtime's derived
  records. It can neither drop nor forge one (`keepDerivedRecords`).
- An agent that makes a derived record never moves, answers or edits the item.
- A body is at most 32 KB of JSON.

## Forbidden

- Writing `metadata.derived` through the generic record write.
- Treating a stale record as current. Show it as old, or show the item.
- Starting derivation asks without a station that names a `projectPath`.

## Code map

| Path | Holds |
| --- | --- |
| `packages/protocol/src/derived-records.ts` | record shape, version, read rule, keeper |
| `packages/protocol/src/work-lifecycle.ts` | `WorkStationDeriver`, `derive` validation |
| `packages/runtime/src/broker-derived-records.ts` | write, read, pending, dispatcher |
| `packages/runtime/src/broker-http-router.ts` | `GET/POST /v1/derived`, `GET /v1/derived/pending` |
| `packages/cli/src/mcp/scout-mcp.ts` | `derived_read`, `derived_write`, `derived_pending` |

## Verification

```bash
bun test packages/runtime/src/broker-derived-records.test.ts
bun test packages/runtime/src/broker-http-router.test.ts -t "derived record routes"
```

## Not yet

- Judges still settle through `work_review` on the move ledger, because a
  reopen moves the item. They are the same pattern, but not yet the same
  record.
- Sources other than work items: sessions, conversations, shows.
- A derivation ask's own work item still shows on boards, in Doing.
