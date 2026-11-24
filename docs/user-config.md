# User Configuration

Scout stores per-user configuration in `~/.openscout/user.json`. The CLI and any separate Scout app read this file.

## Your Operator Name And Handle

Scout keeps a human/operator name and optional handle in
`~/.openscout/user.json`. The name is the fallback sender identity Scout uses
when it needs a person-level sender rather than a project- or agent-scoped
sender. The handle is the human-facing alias, without requiring the leading
`@` in config.

### Set via CLI

```bash
scout config set name Alice
scout config set handle @alice
```

### Set in a Scout app

In a separate Scout app with a settings screen, open Settings → Identity, type your name, and save.

### View current config

```bash
scout config
# name: Alice
# handle: @alice

scout config get name
# Alice

scout config get handle
# alice
```

### Reset to default

```bash
scout config set name
# Name reset to default: <your $USER>
```

## Tail Thinking Beats

Claude returns thinking blocks with an **empty** `thinking` field whenever the
caller leaves the API's `display` option at its default of `"omitted"` — which
every current model does. The block is real (it carries a signature, and the
tokens are billed), but there is no text in it, so the tail has a beat it can
name and nothing it can quote.

`tail-thinking` decides what the tail does with those beats:

| Value | Behavior |
| --- | --- |
| `hide` (default) | Drop the beat. A row reading `[thinking]` with nothing behind it promises reasoning Scout cannot show. |
| `tag` | Keep a bare `[thinking]` marker, for operators who want to see that the agent stopped to think. |

```bash
scout config set tail-thinking tag
scout config get tail-thinking
scout config set tail-thinking        # back to the default
```

Resolution order: `~/.openscout/user.json` → `tailThinking`, then
`OPENSCOUT_TAIL_THINKING`, then `hide`. The value is re-read about once a
second during tail ingest, so a change takes effect without restarting the
broker.

**This setting is Claude-specific.** Runtimes that actually return thinking
text — Kimi, via `part.think` — always render it, whatever this is set to.
Setting it never hides reasoning Scout has; it only decides whether to mark
reasoning Scout does not have.

## Agent Worktree Retirement

A session asked to run in a new worktree gets a git worktree at
`<project>/.scout-worktrees/<agent>` on branch `scout/<agent>`. The runtime
retires such a worktree when all of these hold:

| Check | Meaning |
| --- | --- |
| Scout made it | A registered worktree directly under `.scout-worktrees/`, with `scout/<folder name>` checked out. Any other worktree or branch is never touched. |
| Idle | No endpoint whose working directory is the worktree is alive, owes a flight or an open work item, or belongs to a registered agent that can be woken there. Nothing happened there (session records, commits, reflog, index) for the idle threshold. |
| Clean | `git status --porcelain --untracked-files=all` is empty. Ignored files such as `node_modules` do not count and are removed with the worktree. |
| Merged | The branch tip is part of `main` (or `master`), local or on `origin`. A squash merge is not detected, so that worktree is kept. |

Retiring stops the dead cardless session endpoints that ran there, then runs
`git worktree remove` (never `--force`) and `git branch -d` (never `-D`). It
runs `git worktree prune` only when that would prune nothing else.

| Setting | Default | Values |
| --- | --- | --- |
| `worktree-retire` | `on` | `on` runs the sweep every hour; `off` stops it. A sweep run by hand still works. |
| `worktree-retire-idle-hours` | `24` | Hours of idleness before a worktree may go. The minimum is 1. |

```bash
scout worktrees                          # the setting and the last sweep
scout worktrees retire --dry-run         # what a sweep would retire, and why the rest stay
scout worktrees retire --project ~/dev/app
scout config set worktree-retire off
```

The reclaimed size is `du -sk` before removal, so it is approximate: APFS
clones and shared blocks make `du` read high.

### Inspect or clean up one project

Use the singular `scout worktree` command for a local Git inspection or
immediate cleanup. It does not use the runtime's idle threshold.

```bash
scout worktree list --project ./app
scout worktree gc --project ./app --dry-run
scout worktree gc --project ./app
```

The project defaults to the current directory. Both commands accept `--json`
and `--base <ref>`. Without `--base`, Scout checks against `origin/main`,
then `main`, then `HEAD`. GC only considers Git worktrees directly under the
project's `.scout-worktrees/` directory. It keeps worktrees with a lock,
tracked changes, untracked files, or commits not in the base. Ignored files
do not count as changes and can be deleted with a worktree.

Scout uses the local runtime's endpoint inventory to keep worktrees in use.
If the runtime is unavailable, confirm that no sessions are using the worktrees
before you run GC. Git can refuse a removal or branch deletion, and Scout never
forces either. GC only deletes branches under `scout/` and keeps the base branch.

## Operator Name Resolution Order

Scout resolves your operator name in this order:

1. `~/.openscout/user.json` → `name` field
2. `OPENSCOUT_OPERATOR_NAME` environment variable
3. `~/Library/Application Support/OpenScout/settings.json` → `profile.operatorName`
4. `$USER` environment variable
5. `"operator"` (hardcoded fallback)

The first non-empty value wins.

## Operator Handle Resolution Order

Scout resolves your operator handle in this order:

1. `~/.openscout/user.json` → `handle` field, with leading `@` removed
2. `OPENSCOUT_OPERATOR_HANDLE` environment variable
3. `~/.openscout/user.json` → `name` field
4. `OPENSCOUT_OPERATOR_NAME` environment variable
5. `$USER` environment variable
6. `"operator"` (hardcoded fallback)

The handle is used for human-facing aliases and compatibility with direct DM
ids during the structural conversation-id transition.

## Operator Augment Agent

Scout can create a long-lived AI counterpart for the human operator. Start an
agent named after your operator handle plus `-ai`:

```bash
scout up "$HOME" --name "$(scout config get handle)-ai" --harness codex --model gpt-5.5
```

For a handle of `@alice`, this creates `@alice-ai`. The generated system prompt
keeps the stock Scout routing contract and adds the human-in-the-loop rules:
the augment keeps longer-running conversations in the same venue, maintains
continuity, and invokes the human operator only for concrete decisions,
approvals, or unblock questions.
Use a project root instead of `$HOME` when the augment should be scoped to one
codebase.

## Default Collaboration Sender

Scout collaboration commands share one default sender model:

```bash
scout whoami
```

By default, `scout ask`, `scout reply`, and `scout ask --channel shared --fyi`
resolve the sender in this order:

1. `--as <agent>` for that command
2. `OPENSCOUT_AGENT` when the current session is already bound to an agent
3. the current project-scoped sender inferred from the working directory
4. your operator name from the resolution order above

That means your operator name is still important, but it is not always the
sender Scout uses inside a project. If you are unsure, check `scout whoami`
first.

`scout watch` is different: it watches a conversation or channel and does not
resolve a sender identity.

## CLI `--as` Flag

The `--as` flag on `scout ask`, `scout reply`, and `scout ask --channel shared --fyi` overrides
the sender identity for that command only. It does not
change your stored config.

```bash
# Send as the default sender for this directory/context
scout ask --to arc "hello"

# Send as a specific agent identity
scout ask --fyi --as reviewer --to arc "deploy complete"
```

## Config File Format

```json
{
  "name": "Alice",
  "handle": "@alice"
}
```

Located at `~/.openscout/user.json`. Created automatically on first `scout config set`.
