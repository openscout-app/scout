# Scout skills

A skill is a directory with a `SKILL.md` file and, optionally, scripts or
other resources. Scout helps the operator find a skill and ask an agent to use
it. The agent opens the file on the machine where it runs. Scout does not copy
the instructions, install the skill, or execute its scripts.

## Find a skill

`scout skills` lists the name and description from standard YAML frontmatter
and the path to each file. It reads the operator's existing
`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and
`~/.cursor/skills` directories. With `--harness codex`, for example, Scout
reads the shared `~/.agents/skills` root and the Codex root, not the Claude or
Cursor roots. Other harnesses without a dedicated root here use the shared
root. Scout does not create a skills directory.

Two links to the same file count once. Two different files with the same
name both appear. Running that name fails with both paths: use a path from
the listing instead. With `--on <host>`, the list comes from that broker;
paths beginning with `~/` refer to that host's home. Quote such a path on
the command line to keep the shell from expanding it on the wrong machine.

## Run a skill

```sh
scout skills --harness codex
scout run untrack-folder "Untrack assets/renders and tell me where you copied it."
scout run untrack-folder "Untrack assets/renders." --project /repo --on workstation
```

The second argument is one plain brief, not a set of named inputs. The
runtime resolves the skill on the target host, then sends an ordinary ask
with the brief and the selected file's path. The project, harness and host
are routing metadata, not part of the brief. A local run defaults to the
caller's current directory. A remote run needs a project on that host;
if its catalog cannot be read, Scout does not substitute a local skill.
`--dry-run` previews the ask without dispatching it.

The receipt means the ask was accepted, not completed. Follow its work link
or wait reference for the result. Retry an uncertain submission with the same
`--request-id`. There is no separate skill-run record.

## Surfaces

The CLI and local MCP work tools (`skills_list`, `skills_run`) use the same
broker operations as a native client:

- `GET /v1/skills` → `{skills: [{name, description, path}]}`. Optional query
  parameters: `harness` and `host`.
- `POST /v1/skills/run` takes `name` (or a listed path), `brief`, and optional
  `target` (`project`, `harness`, `host`), `currentDirectory`, and `requestId`.
  Acceptance returns HTTP 202 with `{receipt, followUrl}`.

**Next, not built:** Desk can offer the same list and one brief field, then
show the receipt and the result. No Scout-specific frontmatter, form schema,
authoring commands, schedules, or UI are part of this version. The
[untrack-folder example](../../examples/skills/untrack-folder/SKILL.md) is an ordinary skill.
