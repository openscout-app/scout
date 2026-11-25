# Session search

Search **observed harness sessions** (Codex, Claude Code, and Kimi) after an
**opt-in and warm-up**. The index is off by default, including on existing
installs. This is not broker chat history and does not import
transcripts into Scout messages.

## When to use it

| Need | Prefer |
| --- | --- |
| “Read devon-2's last report” / a named Herdr panel | `sessions_inventory` or `herdr_workspaces` with `query: "devon-2"` first |
| Who is online / what just happened on the runtime | `scout who`, `scout latest` |
| Live harness firehose | `scout tail` |
| “What did a past session say/do about X?” | **`scout search`** |
| Exact session coordinates after a hit | session id + path from search hits |

### Resolve a panel before searching its history

A Herdr panel name is an operator label. It is separate from the terminal
title, harness-native session reference, and Scout agent address. Inventory
preserves those fields rather than making the caller infer one from another.
For example, `sessions_inventory { "query": "devon-2" }` returns the matching
panel coordinates, observed status/time, reported harness session, and any
existing Open/Attach actions correlated by exact harness + session id.
`herdr_workspaces` accepts the same query for a host-only lookup.

Both lookups are literal, bounded candidate searches. Multiple matches remain
ambiguous; a truncated or unavailable source cannot establish that a panel is
absent. A saved layout is last-known, not live, and carries no read command.
Live pane results include a structured `readCommand` (`command` plus `args`)
for reading terminal output through Herdr. That output may be a progress update
or a partial turn: it is not automatically a final report. A Herdr-reported
session reference is observation evidence, not independent transcript
verification and not a Scout routing address.

Only use transcript search once the request actually needs historical
content. Preserve its coverage and supported-harness limits: a panel being
discoverable does not imply its harness history is indexed.

## Contract

1. **Opt-in first** — turn on **Local search index** in **Settings › System**,
   or set `knowledgeIndexEnabled: true` in Scout `settings.json`. Missing or
   malformed settings mean off. CLI/MCP queries never enable it. Once enabled,
   the web Search page can refresh in the background.
2. Warm a **time span** (and optional harness), then query.
3. Query does **not** auto-index. If coverage is missing, Scout says so and
   suggests the warm-up command.
4. Hits are **derived** (QMD + FTS). Raw JSONL/wire files remain authority.
5. Database + WAL + QMD sidecars share a **256 MiB** cap. Oldest collections
   are evicted whole; coverage reports retained history, not a complete span.
   See [Local storage](./local-storage.md) for upgrade and disk-headroom rules.

## Commands

```bash
# Status + recent warm spans
scout search status

# Explicit warm-up
scout search index --source sessions --days 3
scout search index --source sessions --harness kimi --hours 12
scout search index --source sessions --harness claude --days 7 --force

# Query (only searches what was warmed)
scout search query "xcodebuild" --harness kimi --hours 12
scout search query "pairing flap" --project openscout --days 3
scout search query "iOS build" --harness kimi --json

# Continue a page: the token comes from the previous run's `next` field
scout search query "pairing flap" --limit 30 --after <page token>
```

### Flags

| Flag | Index | Query | Meaning |
| --- | --- | --- | --- |
| `--source sessions` | yes | (implied) | First product slice: harness sessions only |
| `--days N` / `--hours N` | lookback | coverage + optional mtime filter | Hours overrides days; max 30d |
| `--harness <id>` | filter roots | facet + coverage | `codex`, `claude`, `kimi` (repeatable) |
| `--project <name>` | — | facet | Project basename facet |
| `--limit N` | discovery cap | page size (max 500) | |
| `--after <page>` | — | continue a query from the previous page token | Query and filters must match the original search |
| `--force` | re-index | — | Ignore content-hash skip |

### Coverage honesty

| Message | Meaning |
| --- | --- |
| index off | Enable Local search index in Settings › System; no query or warm-up is run |
| bounded / retained history | Capacity eviction removed older collections; results cover retained history only |
| empty / not warmed | That source×harness×window was not explicitly indexed; run the suggested `index` command |
| warmed, no matches | Span was indexed; query simply had no FTS hits |
| warmed (stale) | Covered, but last warm is old relative to the lookback — re-index if you need fresher files |

## Where data lives

| Path | Role |
| --- | --- |
| Harness stores (e.g. `~/.kimi-code/sessions`, `~/.codex/sessions`, `~/.claude/projects`) | Authority transcripts |
| `~/.openscout/control-plane/knowledge/knowledge.sqlite` | Rebuildable FTS + warm spans |
| `~/.openscout/control-plane/knowledge/qmd/` | Derived markdown sidecars |

Control-plane SQLite (messages, flights) is **separate**. Search never writes
Scout-owned conversation records from harness text. These commands search
the local index; they do not search other machines' transcripts through mesh.

## Agent guidance

When the operator asks about prior agent work across sessions (what was built,
which session ran a command, where a harness instance lived):

1. `scout search status` — is anything warmed?
2. If off, ask the operator to enable it. If enabled but not covered: `scout search index --source sessions --harness <id> --hours N`
3. `scout search query "…" --harness <id> --hours N`
4. Report session id, project/cwd, and source path from hits — do not invent peers.

Do **not** grep entire `~/.codex` / `~/.kimi-code` trees by hand when this
path is available. Do **not** bulk-import transcripts into Scout messages.

## Related

- Checkpoints: `docs/archive/eng/session-search-checkpoint-1.md`, `docs/archive/eng/session-search-checkpoint-2.md`
- Design: `docs/eng/sco-062-qmd-knowledge-search-and-context-index.md`
- Runtime: `packages/runtime/src/knowledge/`
- CLI: `packages/cli/src/cli/commands/search.ts`

## Scoutbot read-only tools

Scoutbot can use `sessions_search` to query this same existing FTS index without
indexing or opening raw transcript files. Queries are bounded to 300 characters,
1–20 hits (default 8), and 1–720 hours (default 72). Optional harness and project
basename filters use existing index facets. This is lexical search; a natural
language request is translated into search terms, not a semantic embedding query.
The response always includes warm coverage and staleness. Missing coverage skips
the search and returns the explicit warm-up suggestion for the operator.

`sessions_inventory` reads the existing canonical session views and observed
terminal inventory, with literal filters and at most 20 returned results. The
underlying view is bounded (80 sessions / 100 terminal records), so it does not
prove that a session or process does not exist. `live_attachable` requires a
terminal surface observed as live or detached. `history_only` requires all matched terminal surfaces to be explicitly exited;
it does not rule out an independent harness process. Missing terminal evidence,
unknown surface state, or unavailable inventory is reported as `unknown`.

Search hits receive an Open session link only when their harness-native identity
matches a canonical session, and an Attach terminal link only for an observed
live/detached surface. Index-only hits retain source coordinates and have no
fabricated action. Both tools are read-only; neither imports transcripts, warms
an index, launches a shell, resumes a harness, or dispatches work. Returned source
text remains untrusted observed material.


## Scoutbot attachment inspection

`attachments_read` accepts an attachment id and optional originating message id.
It requires an active runtime reply context and a canonical operator message in
that same conversation. The reader actor is the reply context's `toAgentId`,
not the operator who authored the message. The runtime rechecks current actor
authority, conversation membership and the committed message/blob binding on
every read. A successful earlier read does not grant later access.

The tool selects `attachment.blob.sha256` from that message. A URL-only legacy
attachment returns `supported: false` with an unavailable reason; its URL and
`blobKey` are never translated or fetched. The message's `originNodeId` selects
the exact owner. Local reads use `POST /v1/attachments/read`; remote reads use
the local runtime's fixed attachment operation on `/v1/hosts/web-request`. The
tool checks both the transport status and the inner operation status. Missing
node identity or wrong authority is a refusal, never permission to try another
node or store.

The configured broker Unix socket is used when present, with no HTTP fallback
from a failed socket. Otherwise the tool uses the local loopback broker control
URL. The attachment reader sends no web cookie and performs no web bootstrap.
Redirects, arbitrary URLs and attachment filesystem reads are not allowed.

Text/code attachments must match their declared MIME type, contain valid UTF-8
text, and stay within 256 KiB. Returned text is limited to 32,000 characters and
reports truncation. The `attachments_read` tool does not expose image, audio,
video, PDF, or other binary inspection; accepting such a file in the composer
does not imply that the assistant can inspect it. HTML, SVG and MIME charset
aliases are not supported by the canonical text allowlist.

The successful MCP output shape is unchanged: `attachmentId`, `fileName`,
`mediaType`, `supported`, `bytes`, `truncated`, `text` and `sourceTrust`.
`bytes` is the runtime's full byte count, even when returned text is truncated.
The runtime's `untrusted_attachment` marker maps to the existing MCP marker
`untrusted_operator_attachment`; neither means trusted instructions. Refusals
preserve the runtime HTTP/operation status and error code, not empty content.
The reader bounds JSON transport responses to 512 KiB in addition to the
256 KiB inspection and 32,000-character output limits.

App previews use the runtime's separate [authorized image-mode read](attachments.md),
which permits up to 25 MiB for the existing image MIME allowlist. This does not
raise the text tool's inspection or transport limits.
