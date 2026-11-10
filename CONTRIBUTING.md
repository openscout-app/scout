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
and runtime work. Outside contributors push a topic branch to their fork and
open its pull request against `openscout-app/scout`. Maintainer work follows
[branches and promotion](#branches-and-promotion). Keep private Scout product work in its
private repository. See [the source boundary](./docs/public-source-boundary.md)
for ownership details; inspect mixed changes before copying them across repos.

Before editing, committing, or pushing, verify `pwd`,
`git rev-parse --show-toplevel`, and `git remote -v`. A chat title or sidebar
project placement does not prove the shell's working directory. Set the command
working directory explicitly when the recorded chat directory is stale.

## Branches and promotion

`openscout-app/scout:main` is the release base. The maintainer fork,
`arach/scout`, is where maintainer work is built and reviewed. Drafts, review
rounds, fix-up commits and rebases happen on the fork. The public repository
receives only finished changes, and it receives them quickly.

| Ref | Purpose |
| --- | --- |
| `origin/main` | Fork `main`, where maintainer pull requests merge |
| `upstream/main` | Release base; receives fork `main` through promotion pull requests |
| Local `main` | Tracks `origin/main` |
| `origin/<topic>` | One topic branch for each pull request into fork `main` |

Fork `main` is ahead of upstream `main` only by fork pull requests that are
merged and not yet promoted. Promote them the same day, so the two stay close.

Configure a fork-based checkout once, after verifying its remotes:

```bash
git config --local branch.main.remote origin
git config --local branch.main.merge refs/heads/main
git config --local remote.pushDefault origin
git config --local push.default simple
git config --local pull.ff only
```

### Work on the fork

1. Start each task in its own worktree from fork `main`, so the main checkout
   can keep running the developer's suite:

   ```bash
   git fetch origin main
   git worktree add -b fix/short-description ../scout-short-description origin/main
   ```

   Use `fix/<description>`, `feat/<description>`, `docs/<description>`, or
   another descriptive name. Existing `develop`, `core-split`, or historical
   branches are not integration or release bases.
2. Push the topic branch and open its pull request against `arach/scout:main`.
   Keep it a draft until it is ready for review.
3. If fork `main` advances, merge it into the topic branch and repeat the
   affected checks on the new head. Keep published history intact unless its
   owner authorizes a rewrite.
4. Merge when local checks pass on the exact head and a review clears it. Use a
   merge commit, so the reviewed head stays in history.

### Promote to the public repository

Promote each merged fork pull request the same day; do not hold changes back
to batch them. One promotion for each fork pull request is normal. When several
fork merges land before a promotion merges, they ride on the same promotion.

1. Open a pull request from `arach:main` into `openscout-app/scout:main`, unless
   one is already open. Give it the fork pull request's title. In the body, link
   each fork pull request it carries and copy their outcome and local check
   results.
2. Merge it with a merge commit when its head is the reviewed fork head. It
   needs no second review.
3. Fast-forward fork `main` to the result:

   ```bash
   git fetch origin main
   git fetch upstream main
   git merge-base --is-ancestor origin/main upstream/main &&
     git push origin upstream/main:refs/heads/main
   git fetch origin main
   git rev-list --left-right --count origin/main...upstream/main
   ```

   The final command must print `0 0`. If the ancestor check or the push fails,
   inspect the divergence and stop. Never force-push either `main`.

### Keep the public repository quiet

- Open maintainer topic pull requests only on the fork. Do not push topic
  branches to `openscout-app/scout`.
- Do not open drafts, review rounds, or fix-up pull requests on the public
  repository.
- Outside contributors open pull requests against `openscout-app/scout` as
  usual. After one merges, sync fork `main` with the commands above.

Update local `main` with `git merge --ff-only origin/main` when that checkout
is on `main` and clean. If it contains work, preserve that work and coordinate
with its owner before updating it. Retire a topic branch and its worktree only
after its merge and ownership are confirmed.

Release tags name reviewed commits on `openscout-app/scout:main`. A source
merge, a promotion, a fork sync, a local build, an installation, and a
publication are separate delivery states. Record each state explicitly. Run
proportional local checks; hosted CI and publication require explicit
maintainer authorization.

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
- Write the commit subject as a plain sentence, for example `Fix session
  route resolution` or `Clarify broker ownership`.
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
