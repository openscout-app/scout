# Home layout

Status: decided, 27 November 2026 (revised from 26 November 2026 proposal). For implementation in order below.

## Outcome

Scout keeps its files in **one home folder** on the host: **`~/.openscout`**
(overridden by `OPENSCOUT_HOME`), identical on macOS and Linux.

Inside `~/.openscout`, every entry belongs to one of four classes, each with
one owner and one rule:

| Path under `~/.openscout` | Owner | Rule | Holds |
| --- | --- | --- | --- |
| Top level (`config.json`, `user.json`, `project.json`, `continuation-policy.json`, `crew.json`, `skills/`, `artifacts/`, `reports/`, `reviews/`) | the operator | You open it, edit it, or hand it to an agent. | User config, Scout skills, recipes, deliverables, reports, reviews |
| `state/` | Scout | Scout writes it. You never edit it. `state/pairing/` is mode `0700` and never handed to agents. | Runtime, control plane, logs, non-prod instances, pairing and mesh identity, deployments, integrations |
| `cache/` | Scout | Scout can delete and rebuild it at any time. | Derived indexes, build and release evidence, other rebuildable files |
| `.<tool>/` (`.desk/`, `.studio/`, `.feed/`, ...) | that tool | Each tool beside the core keeps its own dot-folder inside `~/.openscout`, apart from the runtime's own entries. | Scout Desk (`grabs/`, `history.db`, dictation, settings), Studio, Feed, and future tools |

One OS-level exception stays outside `~/.openscout`: **Unix domain sockets**
live in a short private per-user runtime directory so paths stay well under
macOS's 104-byte socket limit (see Sockets).

`~/.scout`, `~/.scout-desk`, and `~/Library/Application Support/OpenScout` (or
`${XDG_STATE_HOME:-~/.local/state}/openscout` on Linux) all fold into
`~/.openscout` through an explicit `scout home migrate` command.

## Current layout

Measured on one operator's Mac, 26 November 2026:

| Folder | Size | Written by | Contents |
| --- | --- | --- | --- |
| `~/.openscout` | 4.8 GB | runtime, CLI, web server, macOS app | `config.json`, `user.json`, `project.json`, `continuation-policy.json`, `run/` sockets, `control-plane/` (3.5 GB), `instances/` (645 MB), `.studio/` (389 MB), `work-archives/`, `backups/`, `release-evidence/`, `relay/` |
| `~/.scout` | 411 MB | runtime, CLI, pairing | `pairing/`, `local-edge/`, `artifacts/` (220 MB), `reports/`, `work/`, `world-team*/`, `skills/` |
| `~/Library/Application Support/OpenScout` | 2.9 GB | runtime, macOS app, scoutd | `runtime/` (2.4 GB), `logs/`, `deployments/`, `settings.json`, node and TLS identity, mesh files, Slack and Discord state, stray `.bak` and `.tmp` files |
| `~/.scout-desk` | 736 MB | Scout Desk | `grabs/` (538 MB), `dictation-recovery/`, `history.db`, settings |

The code already names the problem. `deriveOpenScoutInstanceLayout` in
`packages/runtime/src/instance.ts` gives every non-prod instance one root
(`~/.openscout/instances/<name>`) and describes prod as a "scattered legacy
layout" with `root: null`.

## Problems

1. **Four homes for one product.** `~/.openscout`, `~/.scout`, `~/.scout-desk`,
   and `~/Library/Application Support/OpenScout` each hold a mix of operator
   files, tool data, and Scout's own state. No single rule tells a person or an
   agent where a file lives or where a new tool should write.
2. **Conflicting variables.** `resolveScoutHome` in
   `packages/runtime/src/scout-home.ts` returns
   `SCOUT_HOME || OPENSCOUT_HOME || ~/.scout`. `resolveOpenScoutHome` in
   `support-paths.ts` uses `OPENSCOUT_HOME` for `~/.openscout`, while
   `OPENSCOUT_SUPPORT_DIRECTORY` moves a third folder. Setting `OPENSCOUT_HOME`
   in a test or dev instance leaves readers disagreeing on where state lives.
3. **Half-finished move.** `scout-home.ts` treats `~/.scout` as the new home
   and `~/.openscout` as a read fallback. `moveLegacyScoutHomeOffline` refuses
   to run when both exist, and the journalled merge it requires does not exist.
4. **No state vs cache boundary.** Large rebuildable files (release evidence,
   derived indexes) sit beside durable SQLite databases and private keys, so
   cleanup and agent read boundaries have to guess what is safe to touch.

## Target layout

### Placement

| Today | Target under `~/.openscout` |
| --- | --- |
| `~/.openscout/config.json`, `user.json`, `project.json`, `continuation-policy.json`, `crew.json` | unchanged (`~/.openscout/`) |
| `~/.scout/skills/`, `artifacts/`, `reports/`, `reviews/` | `~/.openscout/skills/`, `artifacts/`, `reports/`, `reviews/` |
| `~/.openscout/control-plane/`, `relay/`, `instances/`, `work-archives/`, `backups/` | `~/.openscout/state/` |
| `~/Library/Application Support/OpenScout/*` (`runtime/`, `logs/`, `deployments/`, `settings.json`, node/TLS/mesh identity, Slack/Discord state — minus stray `.bak`/`.tmp`) | `~/.openscout/state/` |
| `~/.scout/pairing/`, `local-edge/`, `world-team*/` | `~/.openscout/state/` (`state/pairing/` mode `0700`) |
| `~/.openscout/release-evidence/`, `evidence/` | `~/.openscout/cache/` |
| `~/.openscout/.studio/` | unchanged (`~/.openscout/.studio/`, with any rebuildable cache inside `.studio/cache/` or `~/.openscout/cache/studio/`) |
| `~/.scout-desk/` | `~/.openscout/.desk/` |
| `~/.openscout/run/` sockets | short per-user runtime directory (see Sockets) |
| `~/.scout/work/` | unchanged until moved with `git worktree move` (new worktrees use `~/.openscout/work/` or `<project>/.scout-worktrees/`) |

A non-prod instance keeps one root, now under
`~/.openscout/state/instances/<name>`, with the same internal layout
(`config.json`, `state/`, `cache/`). The instance registry, the repair scan of
legacy instance roots, and the prod-overlap guard in
`packages/runtime/src/instance.ts` all move in the same change as `instances/`.
Otherwise repair misses moved instances and the guard rejects their new roots.

`state/pairing/` holds the host's pairing keys (mode `0700`). Agents that read
operator catalogs (`~/.openscout/skills/`, `~/.openscout/artifacts/`,
`~/.openscout/reports/`) never receive access to `~/.openscout/state/`.

`config.json` stays at `~/.openscout/config.json` because the operator edits it.
Scout may still write to it (setup records ports there), so every write keeps
the operator's other keys and formatting, and Scout's own computed values go to
`~/.openscout/state/` instead.

`~/.scout/work/` holds live Git worktrees, and a plain directory rename breaks
their `.git` backlinks to the main repository. Existing worktrees stay where
they are until moved with `git worktree move`; `scout home migrate` never
renames them.

### Sockets

Sockets never live inside `~/.openscout`. A dev instance's broker socket under
`~/.openscout/state/instances/<name>/state/runtime/broker.sock` can pass
macOS's 104-byte limit for a Unix socket path, and the broker cannot bind.

All sockets go in a short private per-user runtime directory, mode `0700`:

- macOS: `<user temp dir>/scout/<instance>/`. The runtime takes the user temp
  dir from `confstr(_CS_DARWIN_USER_TEMP_DIR)`, not from `$TMPDIR`, so a process
  started by launchd, a sandboxed helper, and a shell all find the same path.
- Linux: `$XDG_RUNTIME_DIR/scout/<instance>/`.

Socket names stay short (`broker.sock`, `app.sock`, `probes.sock`). Before it
binds, the runtime checks the full path length in bytes and fails with an error
that names the path and the limit.

macOS removes files in the user temp dir that have gone unused for a few days,
and a socket that is listening counts as unused. So the runtime checks its
socket paths on its health tick, and when one has gone it binds it again.
Clients that cannot connect to a missing socket fall back to the runtime's
HTTP port, as they do today.

### Variables

One primary variable moves the entire home, with two optional overrides for
callers that need to place state or cache on another volume:

- `OPENSCOUT_HOME`: the single root on the host. Default `~/.openscout`.
  Setting `OPENSCOUT_HOME` moves config, operator folders, `state/`, `cache/`,
  and `.<tool>/` together.
- `OPENSCOUT_STATE_DIR`: optional override for Scout-owned state. Default
  `$OPENSCOUT_HOME/state`.
- `OPENSCOUT_CACHE_DIR`: optional override for rebuildable cache. Default
  `$OPENSCOUT_HOME/cache`.

Legacy variables stay as deprecated aliases for one release, each logging one
warning that names its replacement:

| Alias | Maps to | Why |
| --- | --- | --- |
| `SCOUT_HOME`, `OPENSCOUT_SCOUT_HOME` | `OPENSCOUT_HOME` | Consolidates `~/.scout` into the one home. |
| `OPENSCOUT_SUPPORT_DIRECTORY` | `OPENSCOUT_STATE_DIR` | Redirects legacy support-directory overrides into `state/`. |

The test-isolation guard `ensureOpenScoutCleanSlateSync` checks the effective
isolated paths after variables and aliases resolve, not the presence of
`OPENSCOUT_SUPPORT_DIRECTORY`. A test that sets only `OPENSCOUT_HOME` passes
the guard. A non-prod instance's own root still wins over any inherited
variable.

### Readers first

Every reader moves to the resolver functions before any file moves. Today some
readers bypass fallbacks:

- `instance.ts` reads `config.json` for ports directly from
  `layout.openscoutHome`.
- `support-paths.ts` resolves `OPENSCOUT_HOME` and `Application Support` on its
  own.
- `scoutHomeReadPath` assumes `~/.scout` is the target and only falls back to
  `~/.openscout` when no variable is set.

Step 2 of the order switches every reader to resolve the target path under
`~/.openscout` first, then fall back to the legacy path (`~/.scout`,
`~/Library/Application Support/OpenScout`, `~/.scout-desk`), and adds a test
for each reader with the file only in the new location, then only in the old
one.

### Migration

Migration is an explicit command, `scout home migrate`, not a step of runtime
startup. launchd starts the runtime and restarts it when it exits, and the
runtime cannot stop Scout.app, so a runtime that tried to stop every writer
from its own startup would race the processes it needs stopped. Setup and the
upgrade path run the command; the operator can run it by hand.

The command first gets exclusive ownership:

1. Stop the runtime through its service manager (launchd or systemd), and ask
   Scout.app and scoutd to quit. Take an exclusive lock file in
   `~/.openscout/state/` that the runtime, scoutd, the web server, the app's
   helpers, and the CLI each check at start; while it is held they wait or
   refuse with an error that names the command. If a writer is still running,
   report it and move nothing.
2. Checkpoint each SQLite database (`PRAGMA wal_checkpoint(TRUNCATE)`) and
   close it, so no committed data stays only in the `-wal` file.
3. Write a journal of planned moves to `~/.openscout/state/home-migrate.journal.json`.
4. Move each item with a same-volume rename. Where a database's whole
   directory moves, rename the directory in one step. If source and target are
   on different volumes (`EXDEV`), stop: never copy and delete.
5. If a target exists, keep both: rename the legacy item with a `.legacy-<date>`
   suffix and record it in the journal. Never merge two databases.
6. Mark each journal entry done after its rename and an `fsync` of both parent
   directories. After a crash, `scout home migrate` reads the journal, checks
   each entry's source and target on disk, and finishes or skips it. It never
   deletes a source whose target it has not confirmed.
7. Release the lock and start the runtime again. After all entries are done,
   leave `MOVED.md` in each retired legacy folder (`~/.scout/MOVED.md`,
   `~/Library/Application Support/OpenScout/MOVED.md`) naming `~/.openscout`,
   and remove empty legacy folders after one release.

Until the command has run, the runtime starts on the legacy locations through
the reader fallback and logs once that `scout home migrate` is pending. It
never moves files itself.

Readers keep the legacy fallback until the journal reports done.

Scout Desk migrates itself at launch: it renames `~/.scout-desk` to
`~/.openscout/.desk` when the target is absent, and otherwise keeps reading the
old path and logs the conflict.

### Order

1. This document, aligned with `NOMENCLATURE.md`.
2. Unify path resolvers on `OPENSCOUT_HOME` (`~/.openscout`) with
   `OPENSCOUT_STATE_DIR` / `OPENSCOUT_CACHE_DIR` and legacy read fallbacks,
   update the test-isolation guard, and add dual-location reader tests.
3. Move sockets to the short runtime directory, with the 104-byte path check
   and health-tick rebind.
4. Scout Desk: migrate `~/.scout-desk` to `~/.openscout/.desk`.
5. Align operator catalogs (`skills/`, `artifacts/`, `reports/`, `reviews/`)
   under `~/.openscout/` with `~/.scout/` read fallback.
6. Implement `scout home migrate` to move `control-plane/`, `instances/` (with
   registry, repair scan, and guard), `~/Library/Application Support/OpenScout`
   runtime state, and `~/.scout/pairing/` into `~/.openscout/state/`, and
   rebuildable evidence into `~/.openscout/cache/`.

## Out of scope

- Changing what any file contains.
- Windows paths.
- `~/.fab`, which belongs to Fab, the project Scout Desk was forked from. Scout
  never reads it. The operator decides whether to keep it.

## Decisions from review

Reviewed by Codex on 26 November 2026 (two rounds). All technical safety
requirements from both rounds are preserved:

1. **No stranded SQLite `-wal` data:** `scout home migrate` is an explicit
   command (never a runtime startup step) that stops every writer, takes an
   exclusive lock, checkpoints each database, journals moves with `fsync`, and
   aborts on `EXDEV`.
2. **`instances/` integrity:** the instance registry, legacy repair scan, and
   prod-overlap guard move in the same change as `instances/`.
3. **Short sockets:** sockets live in `confstr(_CS_DARWIN_USER_TEMP_DIR)` /
   `$XDG_RUNTIME_DIR`, checked against the 104-byte limit and rebound on the
   health tick if macOS cleans them away.
4. **Readers first:** every reader switches to resolvers with dual-location
   tests before any file moves.
5. **Private keys isolated from agent catalogs:** `pairing/` lives in
   `~/.openscout/state/pairing/` (mode `0700`), never alongside operator
   catalogs (`skills/`, `artifacts/`, `reports/`).
6. **Live Git worktrees untouched:** `~/.scout/work/` stays put until moved
   explicitly with `git worktree move`.

Revised on 27 November 2026 by the operator to **one home (`~/.openscout`)**:

- Rather than splitting Scout across `~/.scout`, `Application Support`, and
  `Caches`, every class lives inside one predictable folder (`~/.openscout`)
  separated by subfolder (`state/`, `cache/`, `.<tool>/`, and top-level
  operator files).
- Aligns directly with `NOMENCLATURE.md` ("one Scout folder on the host:
  `~/.openscout`, with sibling tools in dot-folders like `.studio` and `.desk`")
  and gives every test, dev instance, and operator one env var
  (`OPENSCOUT_HOME`).
