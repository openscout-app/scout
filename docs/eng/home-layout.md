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
| `~/.openscout/run/` sockets | `~/.scout/run/` |
| `~/.openscout/control-plane/`, `relay/`, `instances/`, `work-archives/`, `backups/` | support directory |
| `~/.openscout/.studio/`, `release-evidence/`, `evidence/` | cache directory |
| `~/.scout/pairing/`, `plays/`, `artifacts/`, `reports/` | unchanged |
| `~/.scout/local-edge/`, `work/`, `world-team*/` | support directory |
| `~/.scout-desk/` | `~/.scout/desk/` |
| support directory contents | unchanged, minus stray `.bak` and `.tmp` files |

A non-prod instance keeps one root, now under
`<support directory>/instances/<name>`, with the same three classes inside it.

### Variables

One variable per class. Each overrides only its own class:

- `SCOUT_HOME`: the operator's home. Default `~/.scout`.
- `SCOUT_SUPPORT_DIR`: Scout's state. Default per platform, as above.
- `SCOUT_CACHE_DIR`: derived files. Default per platform, as above.

`OPENSCOUT_HOME`, `OPENSCOUT_SCOUT_HOME` and `OPENSCOUT_SUPPORT_DIRECTORY` stay
as deprecated aliases for one release. Each maps to exactly one class, and none
maps to two. Setting an alias logs a single warning that names the new variable.

### Migration

The runtime owns migration. It runs at startup, before the broker accepts work,
under the exclusive admission lease that `moveLegacyScoutHomeOffline` already
requires.

1. Write a journal of planned moves to the support directory.
2. Move each item with a same-volume rename. SQLite files move together with
   their `-wal` and `-shm` files.
3. If a target exists, keep both: rename the legacy item with a `.legacy-<date>`
   suffix and record it in the journal. Never merge two databases.
4. Mark each journal entry done after its rename. A restart resumes from the
   journal.
5. After all entries are done, leave `~/.openscout/MOVED.md` naming the new
   places, and remove the folder after one release.

Readers keep the legacy fallback until the journal reports done.

Scout Desk migrates itself at launch: it renames `~/.scout-desk` to
`~/.scout/desk` when the target is absent, and otherwise keeps reading the old
path and logs the conflict.

### Order

1. This document, reviewed.
2. Fix the `OPENSCOUT_HOME` conflict and add the three new variables, with tests.
3. Scout Desk: `~/.scout-desk` to `~/.scout/desk`.
4. Config files and sockets to `~/.scout`.
5. Heavy state to the support directory, and derived files to the cache
   directory, through the journal.

## Out of scope

- Changing what any file contains.
- Windows paths.
- `~/.fab`, which belongs to Fab, the project Scout Desk was forked from. Scout
  never reads it. The operator decides whether to keep it.

## Open questions

1. Should `artifacts/` and `reports/` stay in `~/.scout`? They are large, but
   operators open them and hand them to agents.
2. Should sockets go to `~/.scout/run` or to the per-user temporary directory?
   macOS limits socket paths to 104 bytes.
3. Should `work/` (agent worktrees) go to the support directory or stay in
   `~/.scout`, where operators find them?
