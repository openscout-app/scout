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
  path: { label: Folder to untrack }
  destination: { label: Copy to, default: "~/Documents/OpenScout/<repo>-<folder>" }
delivery: Report the draft PR link and the location of the verified copy.
---

Copy {{path}} outside the repository to {{destination}}. For the default
destination, substitute the repo and folder names. Verify the copy before
using git rm. Ignore the folder in its parent's .gitignore. Open a draft
PR with plain-sentence text and no trailers. Do not run hosted CI.
```

The [complete example](../../examples/plays/untrack-folder.md) includes the
checks before removal. Copy it into the playbook to use it. Input names start
with a lowercase letter and can include lowercase letters, digits, hyphens and
underscores. A label defaults to the input name in plain words. An input with
no default is required unless marked `required: false`; an omitted optional
input with no default fills as empty text. A string default makes an input
optional. The short forms `path:` and `format: Markdown` still work. The
optional `target` mapping accepts `project`, `harness` and `host`. Routing
comes from these fields, never from the procedure.

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
paths and URLs into inputs and prints the path for the operator to edit. Neither writer
overwrites a play.

`run` fills the declared inputs and substitutes `{{name}}` in the procedure
and delivery as text, not shell code. It names missing required inputs and
rejects unknown inputs before sending anything. `--project`, `--harness` and
`--on` override the corresponding defaults. With no project, a local run
uses the current directory; a run on another host requires its project path.
`--dry-run` prints the target and filled brief without sending an ask.

### Runtime contract

The CLI and local MCP tools (`plays_list` and `plays_run`, `work` profile)
call the same local broker operations available to native clients:

- `GET /v1/plays` → `{plays: [{name, description, inputs}]}`. Inputs are
  ordered fields with `name`, `label`, `required` and `default` (string or null).
- `POST /v1/plays/run` accepts `{"name":"untrack-folder","inputs":{"path":"assets/renders"},"target":{"project":"/repo"}}`.
  Supply a project in the target, the file, or the caller's absolute
  `currentDirectory`. The broker never guesses from its own working directory.
  A caller can supply a stable `requestId` for retries.

The runtime reads its playbook, validates the inputs and submits one ordinary
ask. Acceptance returns HTTP 202 with its `receipt` and `followUrl`; it is not
completion. Missing inputs are reported before dispatch. Local Markdown
authoring and offline CLI previews do not need a running broker. There is no
separate play-run record or execution engine.

## Surfaces

**Next, not built:** Scout Desk's menu bar pop-up can list the playbook and
run a play in a click or two, asking only for missing required inputs. A Desk
notification can show the receipt first and the result when the ask finishes.
A finished ask in Desk can offer **Make that a play** to draft a file for the
operator to edit.

Desk UI and notifications, schedules, agent-proposed edits, sharing, project
playbooks and folders are out of scope for v1.
