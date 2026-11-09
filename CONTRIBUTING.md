# Contributing to Scout

Scout is a local-first control plane with a deliberately small coordination
model. Contributions are welcome when they preserve that model and arrive with
evidence proportionate to their risk.

## Before you start

- Search existing issues and pull requests before opening a new lane.
- Explain substantial behavior or protocol changes in the pull request before
  implementation expands. Agents must not create or comment on public issues
  unless the operator explicitly asks. Use the private feedback channel for
  Scout feedback when authorized, and report internal failures in the handoff.
- Do not file security vulnerabilities publicly; follow [SECURITY.md](./SECURITY.md).
- Keep private Scout product code, assets, credentials, and internal release
  material out of this public repository.

## Repository routing

Use the public Scout checkout for public CLI, TUI, protocol, pairing, harness,
and runtime work. Push a topic branch to your fork and open its pull
request against `openscout-app/scout`. Keep private Scout product work in its
private repository. See [the source boundary](./docs/public-source-boundary.md)
for ownership details; inspect mixed changes before copying them across repos.

Before editing, committing, or pushing, verify `pwd`,
`git rev-parse --show-toplevel`, and `git remote -v`. A chat title or sidebar
project placement does not prove the shell's working directory. Set the command
working directory explicitly when the recorded chat directory is stale.

## Branch from canonical main

`openscout-app/scout:main` is the integration branch and source of truth.
In a fork-based checkout, use these remote names:

| Ref | Purpose |
| --- | --- |
| `upstream/main` | Canonical core history from `openscout-app/scout` |
| `origin/main` | Fast-forward mirror in your fork |
| Local `main` | Local copy of canonical main; tracks `upstream/main` |
| `origin/<topic>` | Published work for one pull request into canonical `main` |

Keep feature commits on short-lived topic branches. Use `fix/<description>`,
`feat/<description>`, `docs/<description>`, or another descriptive name.
Create a separate worktree for each task so the main checkout can keep running
the developer's suite. Existing `develop`, `core-split`, or historical branches
are not integration or release bases.

Configure a fork-based checkout once, after verifying its remotes:

```bash
git config --local branch.main.remote upstream
git config --local branch.main.merge refs/heads/main
git config --local remote.pushDefault origin
git config --local push.default simple
git config --local pull.ff only
```

Start a task from fresh canonical history:

```bash
git fetch upstream main
git worktree add -b fix/short-description ../scout-short-description upstream/main
```

Commit and push the topic branch from that worktree. Open its pull request
against `openscout-app/scout:main`, not your fork's `main`.

If canonical main advances, merge it into the topic branch and repeat affected
checks on the resulting head. Keep published branch history intact unless its
owner explicitly authorizes a rewrite. Review and merge the exact checked head.
Prefer a merge commit so that head remains in canonical history. If a maintainer
uses squash, record the reviewed head and resulting canonical commit separately.

After merging, the fork owner synchronizes the fork's `main`:

```bash
git fetch origin main
git fetch upstream main
git merge-base --is-ancestor origin/main upstream/main &&
  git push origin upstream/main:refs/heads/main
git fetch origin main
git rev-list --left-right --count origin/main...upstream/main
```

The final command must print `0 0`. If the ancestor check or push fails, inspect
the divergence and stop. Do not force-push either `main` or discard fork-only work.
Keep `origin/main` free of feature commits and fork-local PR merges.

Update local `main` with `git merge --ff-only upstream/main` when that checkout
is on `main` and clean. If it contains work, preserve that work and coordinate
with its owner before updating it. Retire a topic branch and its worktree only
after its merge and ownership are confirmed.

Release tags name reviewed commits from canonical `main`. A source merge,
fork synchronization, local build, installation, and publication are separate
delivery states. Record each state explicitly. Run proportional local checks;
hosted CI and publication require explicit maintainer authorization.

## Set up the repository

```bash
git clone https://github.com/openscout-app/scout.git
cd scout
bun install
```

Useful verification commands:

```bash
bun run sync-exec:fence
bun run --cwd packages/protocol check
bun run --cwd packages/runtime check
bun run --cwd packages/pairing check
bun run --cwd packages/cli check
```

Run the narrowest relevant tests while iterating. Use `bun run check` and
`bun run test:unit` before handing off a broad cross-package change.

## Architecture guardrails

- The runtime is the canonical writer for Scout-owned records.
- Harness transcripts are observed source material, not canonical Scout
  messages.
- One target is a DM; group coordination requires an explicit channel;
  broadcast is opt-in.
- Use `send` for tells and updates. Use `ask` for work that requires a reply,
  investigation, judgment, or ownership.
- Mesh means reachability and coordination, not exactly-once delivery, global
  consensus, or transcript replication.
- Do not claim enterprise, compliance, or hardened multi-tenant readiness.

## Code and commits

- Prefer TypeScript for new JavaScript-side logic and Bun for tooling.
- Add or update focused tests for behavior changes.
- Run `bun run sync-exec:fence` for any new or changed process execution.
- Use a concise gitmoji commit subject, for example `🐛 Fix session route
  resolution` or `📝 Clarify broker ownership`.
- Do not add AI-generated attribution or co-author footers.

## Pull requests

A good pull request explains:

1. the user-visible or system outcome;
2. why the change belongs in the public Scout core;
3. the relevant architecture boundary;
4. exact verification commands and results;
5. limitations, migration notes, or follow-up work.

Keep generated files, caches, local state, private product material, and
unrelated workspace changes out of the patch.
