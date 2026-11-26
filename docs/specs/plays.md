# Plays

A **play** is a named procedure the operator gives an agent to run. It says what
varies, what steps to follow, and what to deliver. The agent uses judgment and
asks when it is unsure. A skill is knowledge an agent chooses to load. A play
can tell the agent to use a skill.

## The playbook

The operator's **playbook** is `~/.scout/plays/`. Store one Markdown file per
play. The filename is its name plus `.md`. Use lowercase letters, digits and
hyphens. Like a `SKILL.md`, a play has YAML frontmatter with a name and
description, then instructions in the body.

```markdown
---
name: untrack-folder
description: Keep a local copy of a folder and remove it from Git.
inputs:
  path:
  destination: "~/Documents/OpenScout/<repo>-<folder>"
delivery: Report the draft PR link and the location of the verified copy.
---

Copy {{path}} outside the repository to {{destination}}. For the default
destination, substitute the repo and folder names. Verify the copy before
using git rm. Ignore the folder in its parent's .gitignore. Open a draft
PR with plain-sentence text and no trailers. Do not run hosted CI.
```

The [complete example](../../examples/plays/untrack-folder.md) includes the
checks before removal. Copy it into the playbook to use it. An input without
a default is required. Defaults are strings. The optional `target` mapping
accepts `project`, `harness` and `host`. Target fields are routing metadata,
not instructions in the body.

## Run a play

```sh
scout plays
scout play show untrack-folder
scout run untrack-folder path=assets/renders --project . --harness codex
```

`plays` lists names, descriptions and inputs. `play new <name>` writes a
template and prints its path. `play show <name>` prints the Markdown without
changing the file. `play save <name> --from <invocation-or-flight-id>` drafts
a file from the original ask, not the reply or transcript. It turns recognizable
paths into inputs and prints the path for the operator to edit. Neither writer
overwrites a play.

`run` fills the declared inputs and substitutes `{{name}}` in the procedure
and delivery as text, not shell code. It names missing required inputs and
rejects unknown inputs before sending anything. `--project`, `--harness` and
`--on` override the corresponding defaults. With no project, a local run
uses the current directory; a run on another host requires its project path.
`--dry-run` prints the target and filled brief without sending an ask.

A run sends one ordinary ask. Its receipt and follow link come from the ask
path; acceptance does not mean the agent finished the procedure. The local
MCP server exposes `plays_list` and `plays_run` in the `work` profile. There
is no separate play-run record or execution engine.

Schedules, agent-proposed edits, sharing, project playbooks, folders and UI
are out of scope.
