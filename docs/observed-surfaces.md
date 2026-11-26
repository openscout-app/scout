# Observed surfaces

Agents produce visual and editorial work long before they run `scout show`:
browser captures inside a turn, HTML layout studies in a checkout, and Markdown
plans or reviews written while investigating a problem. Scout projects those
artifacts alongside intentional shows through one machine-local read model,
`scout.observed-surfaces/v1`, without importing harness transcripts or copying
working files into runtime storage.

## Shows, session materials, and observed surfaces

Scout separates durable publication, raw file-touch telemetry, and visual or
editorial surface discovery:

| Model | Schema / routes | Scope | What it holds | Storage |
| --- | --- | --- | --- | --- |
| `ScoutShow` | `POST /v1/shows`, `GET /v1/shows`, `GET /v1/shows/:id/bytes`, `GET /v1/shows/events` | Project or host-wide | Screenshots, recordings, and finished files an agent intentionally put on the canvas with `scout show` or MCP `show` | Immutable blob + metadata copy owned by the runtime under `shows/` |
| `ObservedSessionMaterials` | `scout.session-materials/v1` · `GET /v1/observed-sessions/materials` | Single observed session | Worktree-relative files the session `read` or `modified`, with touch counts and coverage bounds (including source code and config) | Read-only parse of the harness transcript |
| `ScoutSurfaceInventory` | `scout.observed-surfaces/v1` · `GET /v1/observed-surfaces`, `GET /v1/observed-surfaces/:id/bytes` | Project or host-wide across harnesses | Screens (`>= 320x200`), standalone HTML studies, editorial Markdown, PDFs, SVGs, and videos ranked by provenance and stacked by subject revision | Zero-import projection: delegates `shown` to `shows/`, slices transcript base64 by byte offset, and reads checkout files in place |

Use `ObservedSessionMaterials` when asking which source files a session touched.
Use `ScoutSurfaceInventory` when rendering a project or host canvas, stepping
through revisions of a screen or plan, or inspecting visual evidence from recent
turns.

## Provenance tiers

Every `ScoutSurfaceItem` declares why it is on the canvas through
`ScoutSurfaceProvenance`:

| Provenance | How it enters the inventory | Minimum filters |
| --- | --- | --- |
| `shown` | Published explicitly by an agent through `scout show` or MCP `show` (`POST /v1/shows`). Carries `showId` linking to the backing `ScoutShow` record. | Regular file inside the caller's worktree passing `assertShowPath`; up to `128 MiB`. |
| `captured` | Screen evidence observed in a harness turn: inline base64 tool-result images, screenshot tool calls, shell capture commands (`scout browser screenshot`, `agent-browser screenshot`, `playwright screenshot`, `screencapture`, `action ... capture`), or harness scratch uploads. | Raster image (`png`, `jpeg`, `webp`, `gif`) with parsed dimensions `>= 320x200` and size `<= 32 MiB` (tiny icons and badges are ignored). |
| `written` | Standalone HTML studies and editorial Markdown files created, edited, or patched by a tool call during an observed session turn (plus direct HTML/Markdown artifacts in a harness session artifact folder). | Size `<= 8 MiB`. Skips app-shell `index.html` files that mount `/src/main.*` and skips repository boilerplate (`README.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `SECURITY.md`, `TODO.md`). Checkout Markdown must match editorial directory (`plans/`, `reviews/`, `research/`, `docs/`, `artifacts/`, `design/`, `studies/`, `notes/`, `specs/`) or filename hints (`plan`, `review`, `design`, `spec`, `brief`, `audit`, `roadmap`, `proposal`, `one-pager`, `dossier`, `study`, `notes`, `architecture`, `walkthrough`, `report`). |
| `workspace` | Ambient visual studies and editorial documents found on disk inside active project worktrees (`design/studio/`, `design/`, `plans/`, `reviews/`, `artifacts/`, `scratch/`, `docs/studies/`, depth `<= 3`) within the time window and not already claimed by a higher tier. | Same dimension, size, and boilerplate filters as `captured` and `written`; workspace images must sit under `scratch/`, `artifacts/`, or `design/`. Capped per project root so cold starts stay fast. |

Each item also carries a normalized `kind` (`ScoutSurfaceKind`):
`"screen" | "html" | "markdown" | "pdf" | "video" | "svg" | "document"`.

## Subject identity and revision stacking

Agents rarely produce a single static file: they capture the same route before
and after a CSS edit, capture the same native window across turns, or revise a
plan several times. Rather than flattening every capture into an unrelated card,
the runtime derives a `ScoutSurfaceSubject` (`{ key, kind, label }`) and stacks
revisions per `(projectRoot, subject.key)`.

### Subject keys

Subject derivation runs in priority order:

1. **`page:<host><path>` (`kind: "page"`).** Used when an `http:` or `https:`
   URL is known from the capture tool input or result. Trailing slashes are
   stripped (keeping `/` for the root) so `http://localhost:3000/settings/` and
   `http://localhost:3000/settings` resolve to `page:localhost:3000/settings`.
2. **`window:<id>` (`kind: "window"`).** Used when no page URL is present and
   the capture names a native window identifier (`wid`).
3. **`file:<rel>` (`kind: "file"`).** Used for checkout files and file-backed
   captures. Paths inside `projectRoot` normalize to POSIX project-relative
   paths; external scratch captures fall back to the filename. When
   `kind === "screen"`, trailing comparison or version suffixes on the filename
   stem (`-before`, `-after`, `-old`, `-new`, `-v1`, `_2`, etc.) strip down to
   the shared stem so `plans/header-before.png` and `plans/header-after.png`
   join `file:plans/header`.

Linked worktrees resolve `projectRoot` through Git's common directory, so work
across topic worktrees of the same repository shares one project scope while
preserving each item's exact `worktree` and `branch`.

### Revision numbers and `supersedes`

Within each `(projectRoot, subject.key)` group:

1. Items sort chronologically by `createdAt`, breaking ties by provenance rank
   (`workspace` < `captured` < `written` < `shown`) and then `id`.
2. Consecutive items with an identical `sha256` digest collapse into one
   revision, keeping the higher-provenance record (for example, when an agent
   captures a file in a turn and then runs `scout show` on the unchanged file).
3. Surviving items receive a 1-based `revision` (`1`, `2`, `3`, ...) and set
   `supersedes` to the immediate prior item's `id`.

Provenance filtering (`?provenance=shown`) runs **after** stacking so `revision`
numbers and `supersedes` pointers stay consistent with the full subject history.
Passing `latestOnly=1` keeps only the newest revision per subject while
preserving its `revision` count and `supersedes` link for before/after wipe
comparisons and document version stepping.

## Observed, never imported

Observed surfaces follow the same storage boundary as harness sessions:

- **Transcript images stay in the harness log.** When the runtime scans a
  Claude Code, Codex, Antigravity, or Kimi transcript, it parses image headers
  to check the `320x200` floor and SHA-256 digest, then records only a bounded
  in-memory pointer `(transcriptPath, lineOffset, lineLength, sha256)` — never a
  duplicate blob on disk. When a client requests
  `GET /v1/observed-surfaces/:id/bytes`, the runtime opens the transcript,
  reads only `[lineOffset, lineOffset + lineLength)`, decodes the matching
  base64 payload, verifies `sha256`, and serves the requested byte range.
  Parsed transcript metadata is cached in memory keyed by `(mtimeMs, size)`.
- **Checkout and scratch files stay in place.** `written` and `workspace`
  surfaces point to their canonical path on disk and read bytes on demand.
- **Only `scout show` writes runtime blobs.** Publishing with `scout show`
  copies the file into the runtime's local `shows/` directory so the snapshot
  survives later workspace edits or branch switches.

## Security posture

Scout assumes a trusted operator on their own host, not a multi-tenant sandbox,
and still enforces strict local-only and path-containment guards so browser tabs,
symlinks, and remote peers cannot turn surface routes into an arbitrary host
file reader:

- **Machine-local transport tier.** `GET /v1/observed-surfaces`,
  `GET /v1/observed-surfaces/:id/bytes`, and all `/v1/shows*` routes carry mesh
  tier `local`. Each handler also checks `request.transportContext` directly and
  returns HTTP `403` (`surface_forbidden` or `show_forbidden`) when the context
  is missing, `remote`, `peer`, `guest`, or `scoped`. `POST /v1/shows`
  additionally refuses any request carrying an `Origin` header (`403`) to block
  cross-origin browser writes.
- **Secret-path denial (`assertShowPath`).** Both the lexical path and the
  `realpath`-resolved target are checked against `assertShowPath`, which denies
  `.env*`, `.git`, `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.config`,
  `.docker`, harness state directories (`.codex`, `.claude`, `.gemini`,
  `.kimi-code`, `.openscout`, `.scout`, `.opencode`, `.pi`, `.grok`),
  `sessions`, `transcripts`, `node_modules`, key/certificate extensions
  (`.pem`, `.key`, `.p12`, `.pfx`, `.keystore`), SSH key files, `.npmrc`/`.netrc`/`.pypirc`,
  and filenames containing `credential`, `secret`, or `token`.
- **Worktree containment and safe roots.** Candidate files must resolve via
  `realpath` inside the target worktree (or inside the session's bounded harness
  artifact directory for harness-managed scratch files). Broad filesystem roots
  (`/`, `/etc`, `/var`, `/System`, `/Library`, user-home parent directories, the
  operator's home root, `Desktop`, `Downloads`, `Documents`, and `.ssh`) are
  refused as project roots. Build output directories (`dist/`, `build/`,
  `.next/`, `out/`, `coverage/`, `node_modules/`) are skipped.
- **Descriptor-level symlink and hardlink refusal.** Every file and transcript
  read opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and verifies `st.isFile()`
  and `st.nlink === 1` on the open descriptor (re-verified on `/bytes` reads),
  refusing symlinks, FIFOs/devices, and hard-linked files.
- **Isolated byte responses.** `GET /v1/observed-surfaces/:id/bytes` and
  `GET /v1/shows/:id/bytes` send `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'`, and
  `Cache-Control: no-store`. Only raster images (`png`, `jpeg`, `gif`, `webp`)
  and videos (`mp4`, `webm`, `quicktime`) are served `inline`; HTML, Markdown,
  SVG, PDF, and other documents are served as `application/octet-stream` with
  `Content-Disposition: attachment` so markup never executes in the runtime's
  origin. Client UIs that preview HTML studies render them inside a sandboxed
  frame (`sandbox="allow-scripts"` without `allow-same-origin`).

## Runtime HTTP API

### `GET /v1/observed-surfaces`

Returns a `ScoutSurfaceInventory` (`scout.observed-surfaces/v1`) sorted newest
first (`createdAt` descending).

| Query parameter | Type | Description |
| --- | --- | --- |
| `windowMs` | number | Lookback window in milliseconds. Default `259200000` (72 hours); clamped to `[60000, 2592000000]` (1 minute to 30 days). |
| `projectRoot` | string | Absolute project path; canonicalized via `realpath`. Returns `404 surface_project_root_not_found` when missing. Omit to query active projects across the host. |
| `harness` | string | Filter to one harness (`claude`, `codex`, `antigravity`, `kimi`, etc.). Skips ambient `workspace` scanning when set. |
| `provenance` | string | `shown`, `captured`, `written`, or `workspace`. Filtered after revision stacking. |
| `latestOnly` | `1` \| `true` | Return only the latest revision for each `(projectRoot, subject.key)`. |
| `limit` | integer | Maximum items returned (`1..1000`). |

Response shape:

```json
{
  "schema": "scout.observed-surfaces/v1",
  "nodeId": "node_local",
  "generatedAt": 1764115200000,
  "windowMs": 259200000,
  "items": [
    {
      "id": "srf_9f4c2a1b8e7d6c5a4b3f2e1d",
      "subject": {
        "key": "page:localhost:3000/studio",
        "kind": "page",
        "label": "localhost:3000/studio"
      },
      "revision": 2,
      "supersedes": "srf_1a2b3c4d5e6f7a8b9c0d1e2f",
      "provenance": "captured",
      "kind": "screen",
      "mediaType": "image/png",
      "nodeId": "node_local",
      "projectRoot": "/path/to/repo",
      "worktree": "/path/to/repo-feature",
      "branch": "feat/layout",
      "session": {
        "nodeId": "node_local",
        "harness": "claude",
        "nativeSessionId": "0d5a9c12-4b8e-4f10-9a11-7c3e2b1a0f99"
      },
      "url": "http://localhost:3000/studio",
      "dimensions": { "width": 1440, "height": 900 },
      "byteSize": 184320,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "title": "Updated header spacing on the studio route",
      "caption": "Updated header spacing on the studio route",
      "createdAt": 1764115190000
    }
  ],
  "counts": {
    "items": 1,
    "subjects": 1,
    "shown": 0,
    "captured": 1,
    "written": 0,
    "workspace": 0
  }
}
```

### `GET /v1/observed-surfaces/:id/bytes`

Streams the surface's bytes with `Accept-Ranges: bytes` and `ETag: "<sha256>"`.
Supports single HTTP `Range` requests (`206 Partial Content`; `416` with
`Content-Range: bytes */<size>` when unsatisfiable). Unknown or expired in-memory
surface IDs return `404 surface_not_found`.

### `GET /v1/shows` and `GET /v1/shows/events`

`projectRoot` is optional on both endpoints:

- `GET /v1/shows?since=<ms>` returns `{ shows: ScoutShow[] }` across every
  project on the host in ascending creation order; adding
  `projectRoot=/path/to/repo` scopes to that canonical project root.
- `GET /v1/shows/events?since=<ms>` opens a host-wide Server-Sent Events stream
  emitting `show.created` events (`projectRoot` scopes the stream to one
  project).

## CLI usage

Publish an immutable snapshot from the current worktree:

```bash
scout show ./artifacts/settings-after.png --caption "Settings panel after spacing pass"
```

List durable shows or observed surfaces from the terminal:

```bash
# Durable ScoutShow records for the current project
scout show --list

# Durable ScoutShow records across all projects on this host
scout show --list --all

# Latest revision of every observed surface (shown, captured, written, workspace) in this project
scout show --list --observed

# Host-wide observed surfaces filtered to one provenance tier
scout show --list --all --provenance captured

# Machine-readable ScoutSurfaceInventory JSON
scout show --list --observed --json
```

Passing `--provenance <shown|captured|written|workspace>` implies `--observed`
and requests `latestOnly=1` from `GET /v1/observed-surfaces`.
