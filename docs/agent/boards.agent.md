# Boards

## Role

A board is the read a Kanban client draws from. It is one work lifecycle:
its stations are the columns, and its work items are the cards, with the
content each card shows. The runtime produces it from its own records, so a
client needs only these two routes. It reads no control-plane database and
needs no Scout web.

Boards are read only. Moves, reviews and claims stay at `/v1/work/*`.
`GET /v1/work/board` is unchanged: it returns placements only.

## Routes

Both are `local` tier, like `/v1/work/board`.

| Route | Returns |
| --- | --- |
| `GET /v1/boards` | `BoardListResponse`: `{ boards: [{ id, name, version, isDefault }] }`, one per lifecycle |
| `GET /v1/boards/:id` | `BoardRead` for one lifecycle |

- `:id` is a lifecycle id. `default` names the default lifecycle
  (`scout.default`), unless a lifecycle has the id `default`.
- An unknown id returns 404 with `{ error }`.
- `closedSince` (ms) and `limit` mean what they mean on `/v1/work/board`.
  The board shows open work, plus work closed since `closedSince` (the
  default is the last seven days). `limit` defaults to 100, and the maximum
  is 500.

## Model

```text
BoardRead {
  board: { id, name, version, hash, description|null },
  columns: [{ id, name, state, purpose|null }],          // lifecycle order
  transitions: [{ from, to, name|null }],                // from may be "*"
  cards: [BoardCard],                                    // runtime board order
}

BoardCard {
  workId, column, revision, reviewPending, next,         // placement
  title, summary|null, state, acceptanceState, priority|null,
  ownerId|null, ownerName|null, nextMoveOwnerId|null, nextMoveOwnerName|null,
  conversationId|null, parentId|null, parentTitle|null,
  createdAt, updatedAt, lastMeaningfulAt, lastMeaningfulSummary|null,
  source: { adapterId, instanceId, workItemId, url|null }|null,
  activeFlight: { id, state, harness|null, sessionId|null, startedAt|null }|null,
}
```

- Placement fields come from the lifecycle service. They match
  `/v1/work/board`: `column` is the station, and `next` lists the stations a
  move can name.
- Cards are in the same order as on `/v1/work/board`: the most recently
  updated first.
- `ownerName` and `nextMoveOwnerName` are the actor's `displayName`, or the
  agent's when no actor record exists.
- `parentTitle` is the parent record's title.
- `source` is the work item's `externalContext.source`.
- `activeFlight` is the newest flight for the item that has not ended
  (`completed`, `failed` and `cancelled` are ended), by start time. A flight
  belongs to an item through its invocation's work id. `harness` and
  `sessionId` come from the flight's latest session trace entry.
- `lastMeaningfulAt` and `lastMeaningfulSummary` come from the newest of
  three things:
  - the item's latest ledger event, with its summary
  - its newest flight, at its end or start time, with the flight summary
  - the record's own update, with the progress summary, the summary, or the
    title

  On a tie, the event wins, then the flight.

## Missing data

- If a placement's work item cannot be read, the card is left out. A board
  never draws a card without a title. Because the board and its content are
  read from the same live registry in one synchronous pass, this does not
  happen in practice.
- Each other field that the registry cannot fill is `null`. This includes an
  unknown actor, a parent that no longer exists, an item with no external
  source, and a flight with no session trace.

## Invariants

- The runtime is the only producer. Boards read the live registry
  (`runtime.peek()`) and the journal's collaboration events. They write
  nothing.
- One read makes one pass over the named items' events, invocations and
  flights. It never makes a pass for each card.

## Code map

| Path | Holds |
| --- | --- |
| `packages/protocol/src/boards.ts` | `BoardRead`, `BoardCard`, `BoardListResponse`, `DEFAULT_BOARD_ID` |
| `packages/protocol/src/broker-routes.ts` | `scoutBrokerPaths.v1.boards`, `scoutBrokerBoardPath` |
| `packages/runtime/src/broker-boards.ts` | `BrokerBoardService`, `joinBoard` |
| `packages/runtime/src/broker-work-lifecycles.ts` | placements (`board`) that the read joins |
| `packages/runtime/src/broker-journal.ts` | `latestCollaborationEvents` |

## Verification

```bash
curl -s http://127.0.0.1:43110/v1/boards
curl -s 'http://127.0.0.1:43110/v1/boards/default?limit=20'
bun test packages/runtime/src/broker-boards.test.ts
```
