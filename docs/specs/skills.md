# Scout skills

A Scout skill is a folder you own, with a standard `SKILL.md` and optional
scripts and assets. Its home is `~/.openscout/skills/<name>/` (with legacy
`~/.scout/skills/<name>/` read as a fallback), outside the
harnesses' skill directories. Creating a skill does not make it available
to every agent session. The agent reads it only when someone asks for it by
name or describes the work it does.

## Set up and personalize

```sh
scout skills new handoff-note
scout skills edit handoff-note
scout skills path handoff-note
scout skills
scout run handoff-note "Summarize the changed files without modifying them."
```

`new` creates a file with `name`, `description`, and steps. `edit` opens
a personal copy in `$EDITOR`; `path` prints the real path to its instructions.
The name Scout uses is the folder or link name, not a new frontmatter field.

`scout skills add <path>` registers an existing folder by making a link **in
the Scout directory**. It copies nothing. Use `--as <name>` to give the link a
different name. A Git URL instead clones a repository with one root skill.
`scout skills fork <name>` replaces a registered link with a personal copy,
including its resources. Fork before editing a link: the original is not
changed. A later add cannot overwrite that copy.

`scout skills` lists only registered names, their one-line descriptions and
real paths on the selected machine. `--all` also shows unregistered skills from
the user’s Agents, Claude, Codex and Cursor directories, read-only. Seeing one
there does not register it. Scout does not link catalog entries into harnesses.
An independently installed native skill remains subject to its harness's own discovery.

## One entry point in the harness

Run `scout skills setup` once per machine. It installs the short
[`scout-skills` entry point](../../packages/cli/skills/scout-skills/SKILL.md)
in `~/.agents/skills` and links that one folder into Claude, Codex and Cursor.
It leaves the communications skill (`scout`) alone. Run setup again to restore
missing links; it reports conflicts instead of overwriting personal files.
To undo it, remove these three links and the `scout-skills` folder, not the catalog.

When someone asks “what skills do I have?”, the entry point runs
`scout skills --json` and lists names and descriptions without opening a skill.
For “share this grab”, it checks the same live catalog, chooses by name or
description, and reads only the matched file. If several match, it asks which;
if none matches, it offers to create one. No reinstall is needed after a new
registration, edit or fork. Work stays in the current session unless another
agent or machine should own it or the user wants a tracked run. Harnesses
choose skills by description, not by a keyword hook. If Claude interprets a
request as a question about its native menu, invoke `/scout-skills` explicitly.

## Load one skill for one ask

`scout run <name> "brief"` and `scout ask --to <agent> --skill <name> "brief"`
use the same native task field. The broker resolves just that registered name
on the **target machine**. It gives the worker the real `SKILL.md` path, the
real skill directory for relative scripts and assets, and the brief. It does
not inline instructions, install files, or preload a catalog in another
session. An ask without a skill gets no reference.

For a remote run use `--on <host> --project <path-on-that-host>`. A missing
registration on that host is an error; Scout does not substitute a local file
or a harness skill. `--dry-run` previews the ask without sending it. A run
returns the ordinary ask receipt and follow link. Acceptance is not completion.

[Untrack a folder](../../examples/skills/untrack-folder/SKILL.md) is an
example, not an installed skill. Register it with
`scout skills add ./examples/skills/untrack-folder`, then try
`scout run untrack-folder "Untrack assets/renders." --dry-run`.

## Surfaces

CLI and MCP (`skills_list`, `skills_run`) use `GET /v1/skills` and
`POST /v1/skills/run`. Listing returns names, descriptions, source types,
instruction paths and resource directories. Running takes a name, brief and
optional target and returns `{receipt, followUrl}`. The ordinary delivery API
takes `task.skill`; the MCP `ask` tool takes `skill`.

**Next, not built:** Desk's drop pop-up and ask box search the registered
names, show descriptions, and take one brief. Desk can show the receipt and
then the result in a notification. Turning a finished ask into a skill in Desk
is also future work. No scheduler, automatic edits, or UI in this version.
