# Agent-selected shows

The runtime owns this local-only, conversation-independent store. A show is an
immutable copy, not a reference to a mutable working file. It does not send a
message, import a transcript, or add a file to Review. No client source belongs
in this repository.

## Agent entry points

- CLI: `scout show <path> [--caption <text>]`
- MCP: `show { path, caption? }`

Both use ordinary Scout sender resolution and the process's current directory.
Session and harness context are supplied when available. Registered endpoints
supply harness identity; a conflicting session fails with HTTP 409. Unregistered
local callers retain their asserted ordinary sender ID, so no card, hook, skill,
or harness setup is required. This is the existing trusted-local-user model,
not authenticated multi-tenant agent attribution.

Files must be regular files within the caller's worktree (or current directory
outside Git). Save screenshots and recordings there before showing them. Both
lexical and canonical paths pass the secret-path policy; symlink targets cannot
launder denied paths. Hard-linked files are refused. Denied locations include
environment files, key/credential directories and files, Git internals, common
harness stores, sessions/transcripts, and package dependency stores. This is a
path policy, not a guarantee that an ordinary document contains no secrets.
Agents must still choose safe content.

## HTTP contract

Every route has mesh tier `local` and independently refuses non-local transport,
peer, guest, scoped, or missing transport context. They are not forwarded.

- `GET /v1/shows/capability` → `{ "shows.v1": true, fileBytes, storeBytes,
  records, captionCharacters }`. Check this boolean, not a version string.
- `POST /v1/shows` takes `{ path, caption?, caller: { actorId,
  currentDirectory, metadata?: { sessionId?, harness? } } }` and returns HTTP
  201 `{ show: ScoutShow }`. Browser-origin writes are refused. The JSON body
  cap is 16 KiB; bytes are copied directly by the runtime, not base64 uploaded.
- `GET /v1/shows?projectRoot=<absolute-root>&since=<milliseconds>` returns
  `{ shows: ScoutShow[] }` in ascending creation order. `since` is exclusive
  and defaults to zero. This lists retained versions, not just newest cards.
- `GET /v1/shows/:id/bytes` returns the fixed bytes, `Accept-Ranges: bytes`,
  content length, SHA-256 ETag and `Cache-Control: no-store`. Single byte ranges,
  open-ended ranges and suffix ranges return 206; unsatisfiable/multipart ranges
  return 416 with `Content-Range: bytes */<size>`. Unknown/evicted IDs return 404.
  Raster images and video are inline; everything else downloads as octet-stream.
  HTML/SVG/documents never execute in the runtime origin. Responses have nosniff
  and a sandbox CSP. Media type is extension-derived metadata, not validation.
- `GET /v1/shows/events?projectRoot=<absolute-root>&since=<milliseconds>` is
  project-filtered SSE. Event name: **`show.created`**. `id` is the show ID;
  `data` is the full `ScoutShow`. This dedicated stream is not the control-plane
  message/event journal. Connect first, then list and deduplicate by show ID.
  Reconnect and list after disconnect: SSE is live invalidation, not replay.
  Slow streams disconnect; at most 32 streams are admitted.

## Record

`ScoutShow` is exported by `@openscout/protocol`:

```ts
{
  id: string;
  itemId: string;
  supersedes?: string;
  agentId: string;
  sessionId?: string;
  harness?: string;
  nodeId: string;
  projectRoot: string;
  worktree: string;
  branch?: string;
  sourcePath: string;
  kind: "image" | "video" | "document" | "other";
  mediaType: string;
  byteSize: number;
  sha256: string;
  caption?: string;
  createdAt: number;
}
```

Project roots collapse linked worktrees through Git's common directory. Worktree
and source paths are canonical absolute paths. Outside Git, project root and
worktree are the current directory. Detached HEAD has no branch. Missing native
session/harness context is omitted rather than invented. Join `agentId` to the
roster to obtain the display number/name.

`itemId` is SHA-256 of the JSON tuple `[projectRoot, worktree, sourcePath]`.
Re-showing the same path, even with unchanged bytes, creates a new ID and sets
`supersedes` to its previous version. Different worktrees do not collapse into
one item. To detect "Changed since shared", compare a saved version ID with the
newest retained ID for that item; compare hashes separately for content equality.
Shared-version pinning/export is not implemented: old shared versions can be
evicted just like other superseded versions.

## Bounds and storage

- Per file: 128 MiB. Retained blob bytes: 1 GiB. Records: 10,000.
- Captions: 4,000 characters. One copy runs at a time; concurrent attempts get
  HTTP 409 `show_busy_retry`. Copying uses fixed-size buffers, and byte responses
  honor backpressure rather than buffering a whole video.
- Eviction removes oldest superseded versions only. The newest version of
  **every** item is protected, including the currently shown item until commit.
  If admission cannot fit without deleting a newest version, HTTP 507
  `show_store_full_newest_protected` refuses it. A cap is not permission to
  silently destroy the canvas's newest cards.
- Staging can temporarily use another 128 MiB. Metadata is separately bounded
  by the record/caption limits. The next write cleans interrupted staging and
  uncommitted blobs. Committed metadata is atomically renamed after its blob.
- Rows and blob files live under the instance support directory's `shows/`.
  These are runtime-owned files, not message attachments or replicated records.
  Evicted predecessors may leave dangling `supersedes` IDs by design.

## Separate finding

`/v1/deliver` calls `readValidatedRequestBody` without a larger body limit;
`/v1/messages/reply` calls `readRequestBody` without one. Both therefore inherit
`broker-http-helpers.ts`'s 1 MiB JSON default. Base64 plus envelope overhead makes
large `ask --image` / `reply --image` requests fail well below the CLI's 25 MiB
image limit (roughly 750 KiB decoded). This feature does not change that limit.
