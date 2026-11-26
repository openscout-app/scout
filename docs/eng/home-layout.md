# Home layout

Status: proposed, 26 November 2026. For review before any code changes.

## Outcome

Scout keeps its files in three places, each with one owner and one rule:

| Place | Owner | Rule | Holds |
| --- | --- | --- | --- |
| `~/.scout` | the operator | You open it, edit it, or hand it to an agent. | config, plays, artifacts, reports, reviews, pairing identity, Scout Desk |
| support directory | Scout | Scout writes it. You never edit it. | runtime, control plane, logs, instances, mesh identity, integrations |
| cache directory | Scout | Scout can delete and rebuild it at any time. | Studio cache, build and release evidence, other derived files |

On macOS the support directory is `~/Library/Application Support/OpenScout` and
the cache directory is `~/Library/Caches/OpenScout`. On Linux they are
`${XDG_DATA_HOME:-~/.local/share}/openscout` and
`${XDG_CACHE_HOME:-~/.cache}/openscout`.

`~/.openscout` goes away. `~/.scout-desk` becomes `~/.scout/desk`.

## Current layout

Measured on one operator's Mac (arts-mini), 26 November 2026:

| Folder | Size | Written by | Contents |
| --- | --- | --- | --- |
| `~/.openscout` | 4.8 GB | runtime, CLI, web server, macOS app | `config.json`, `user.json`, `project.json`, `continuation-policy.json`, `run/` sockets, `control-plane/` (3.5 GB), `instances/` (645 MB), `.studio/` (389 MB), `work-archives/`, `backups/`, `release-evidence/`, `relay/` |
| `~/.scout` | 411 MB | runtime, CLI, pairing | `pairing/`, `local-edge/`, `artifacts/` (220 MB), `reports/`, `work/`, `world-team*/`, `plays/` |
| `~/Library/Application Support/OpenScout` | 2.9 GB | runtime, macOS app, scoutd | `runtime/` (2.4 GB), `logs/`, `deployments/`, `settings.json`, node and TLS identity, mesh files, Slack and Discord state, stray `.bak` and `.tmp` files |
| `~/.scout-desk` | 736 MB | Scout Desk | `grabs/` (538 MB), `dictation-recovery/`, `history.db`, settings |

The code already names the problem. `deriveOpenScoutInstanceLayout` in
`packages/runtime/src/instance.ts` gives every non-prod instance one root
(`~/.openscout/instances/<name>`) and describes prod as a "scattered legacy
layout" with `root: null`.

## Problems

1. **Three homes for one product.** `OPENSCOUT_HOME` (`~/.openscout`),
   `OPENSCOUT_SCOUT_HOME` (`~/.scout`) and `OPENSCOUT_SUPPORT_DIRECTORY` each
   hold a mix of operator files and Scout's own state. No rule tells a person
   or an agent where a new file goes.
2. **Conflicting variable.** `resolveScoutHome` in
   `packages/runtime/src/scout-home.ts` returns
   `SCOUT_HOME || OPENSCOUT_HOME || ~/.scout`. `resolveOpenScoutHome` in
   `support-paths.ts` uses `OPENSCOUT_HOME` for `~/.openscout`. When a test or a
   second instance sets `OPENSCOUT_HOME`, both classes of state move to one
   directory.
3. **Half-finished move.** `scout-home.ts` treats `~/.scout` as the new home
   and `~/.openscout` as a read fallback. `moveLegacyScoutHomeOffline` refuses
   to run when both exist, and the journalled merge it requires does not exist.
4. **No cache class.** Large derived files (`.studio`, release evidence) sit
   beside durable state, so cleanup has to guess what is safe to delete.

## Proposal

### Placement

| Today | Target |
| --- | --- |
| `~/.openscout/config.json`, `user.json`, `project.json`, `continuation-policy.json` | `~/.scout/` |
| `~/.openscout/run/` sockets | a short runtime directory (see Sockets) |
| `~/.openscout/control-plane/`, `relay/`, `instances/`, `work-archives/`, `backups/` | support directory |
| `~/.openscout/.studio/`, `release-evidence/`, `evidence/` | cache directory |
| `~/.scout/pairing/`, `plays/`, `artifacts/`, `reports/`, `work/` | unchanged |
| `~/.scout/local-edge/`, `world-team*/` | support directory |
| `~/.scout-desk/` | `~/.scout/desk/` |
| support directory contents | unchanged, minus stray `.bak` and `.tmp` files |

A non-prod instance keeps one root, now under
`<support directory>/instances/<name>`, with the same three classes inside it.
The instance registry, the repair scan of legacy instance roots, and the
prod-overlap guard in `packages/runtime/src/instance.ts` all move in the same
change as `instances/`. Otherwise repair misses moved instances and the guard
rejects their new roots.

`work/` stays in `~/.scout`. It holds live Git worktrees, and a directory
rename breaks their links to the main repository. Moving them later needs
`git worktree move`, not this migration.

### Sockets

Sockets never live under the support directory. A dev instance's broker socket
there is `/Users/art/Library/Application Support/OpenScout/instances/dev-scout-home-layout/support/runtime/broker.sock`,
108 bytes, which is over the macOS limit of 104 bytes, so the broker cannot
bind.

All sockets go in a short private per-user runtime directory:
`$TMPDIR/scout/<instance>/` on macOS and `$XDG_RUNTIME_DIR/scout/<instance>/`
on Linux, with mode 0700. Socket names stay short (`broker.sock`,
`app.sock`, `probes.sock`). Before it binds, the runtime checks the full path
length in bytes and fails with an error that names the path and the limit.

### Variables

One variable per class. Each overrides only its own class:

- `SCOUT_HOME`: the operator's home. Default `~/.scout`.
- `SCOUT_SUPPORT_DIR`: Scout's state. Default per platform, as above.
- `SCOUT_CACHE_DIR`: derived files. Default per platform, as above.

`OPENSCOUT_HOME`, `OPENSCOUT_SCOUT_HOME` and `OPENSCOUT_SUPPORT_DIRECTORY` stay
as deprecated aliases for one release. Each maps to exactly one class, and none
maps to two. Setting an alias logs a single warning that names the new variable.

The test-isolation guard `ensureOpenScoutCleanSlateSync` checks the effective
isolated paths after variables and aliases resolve, not the presence of
`OPENSCOUT_SUPPORT_DIRECTORY`. A test that sets only `SCOUT_SUPPORT_DIR` passes
the guard. A non-prod instance's own paths still win over any inherited
variable.

### Readers first

Every reader moves to the resolver functions before any file moves. Today some
readers bypass the fallback:

- `instance.ts` reads `config.json` for ports directly from
  `layout.openscoutHome`.
- `support-paths.ts` resolves `OPENSCOUT_HOME` on its own.
- `scoutHomeReadPath` falls back to `~/.openscout` only when no variable is set.

Step 2 of the order switches these readers and adds a test for each that
places the file only in the new location, then only in the old one.

### Migration

The runtime owns migration. It runs at startup, before the broker accepts work.
A startup journal alone does not stop other writers, so migration first gets
exclusive ownership:

1. Stop every writer: the broker, scoutd, the web server, the macOS app's
   helpers and any CLI holding a database. Take an exclusive lock file in the
   support directory that each of them checks at start. If a writer is still
   running, stop and report it; move nothing.
2. Checkpoint each SQLite database (`PRAGMA wal_checkpoint(TRUNCATE)`) and
   close it, so no committed data stays only in the `-wal` file.
3. Write a journal of planned moves to the support directory.
4. Move each item with a same-volume rename. Where a database's whole
   directory moves, rename the directory in one step. If source and target are
   on different volumes (`EXDEV`), stop: never copy and delete.
5. If a target exists, keep both: rename the legacy item with a `.legacy-<date>`
   suffix and record it in the journal. Never merge two databases.
6. Mark each journal entry done after its rename and an `fsync` of both parent
   directories. After a crash, the runtime reads the journal, checks each
   entry's source and target on disk, and finishes or skips it. It never
   deletes a source whose target it has not confirmed.
7. Release the lock. After all entries are done, leave `~/.openscout/MOVED.md`
   naming the new places, and remove the folder after one release.

Readers keep the legacy fallback until the journal reports done.

Scout Desk migrates itself at launch: it renames `~/.scout-desk` to
`~/.scout/desk` when the target is absent, and otherwise keeps reading the old
path and logs the conflict.

### Order

1. This document, reviewed.
2. Fix the `OPENSCOUT_HOME` conflict, add the three new variables, update the
   test-isolation guard, and switch every reader to the resolvers, with tests.
3. Sockets to the short runtime directory, with the path-length check.
4. Scout Desk: `~/.scout-desk` to `~/.scout/desk`.
5. Config files to `~/.scout`.
6. Heavy state to the support directory, `instances/` with the registry,
   repair scan and guard, and derived files to the cache directory, through
   the lock and the journal.

## Out of scope

- Changing what any file contains.
- Windows paths.
- `~/.fab`, which belongs to Fab, the project Scout Desk was forked from. Scout
  never reads it. The operator decides whether to keep it.

## Decisions from review

Reviewed by Codex on 26 November 2026 (verdict: adopt with changes). All five
problems it raised are addressed above:

1. Data stranded in a SQLite `-wal` file: Migration now stops every writer and
   checkpoints each database first, and defines crash and cross-volume
   behavior.
2. `instances/` repair and guard: they move together (Placement).
3. Broker socket over 104 bytes: Sockets.
4. Readers that bypass the fallback: Readers first.
5. Test-isolation guard: Variables.

The three open questions are closed:

1. `artifacts/` and `reports/` stay in `~/.scout`. They are operator
   deliverables.
2. Sockets go to a short private runtime directory, with the path checked
   before bind.
3. `work/` stays in `~/.scout`. Moving live worktrees needs Git.
