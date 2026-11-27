# Scout skills

A skill is a folder you can open in any editor. Its `SKILL.md` starts with
standard `name` and `description` frontmatter. The body gives the agent its
instructions; scripts and other resources stay beside it. Scout keeps no skill
library in its database. It does not need a project repository or extra fields.

## Set up and personalize

```sh
scout skills new handoff-note
scout skills edit handoff-note
scout skills path handoff-note
scout skills
scout run handoff-note "Summarize the changed files without modifying them."
```

`new` writes a minimal `~/.agents/skills/<name>/SKILL.md` and prints the
path. `edit` opens the selected file in `$EDITOR`; `path` prints that file's
absolute path. The folder name is the reference. Changing the description or
steps does not change it.

`scout skills add <path>` links a local folder into `~/.agents/skills`.
Edits through a link affect the source. `scout skills add <git-url>` clones
one repository with a root `SKILL.md`; its folder name is the repository name
without `.git`. It does not run install scripts or fetch submodules.
`scout skills fork <name>` copies a skill and its resources into the personal
root. It detaches a linked folder without changing the source. A folder that
is already personal needs no second copy. Forks omit Git history and refuse
external resource links rather than leave an edit pointing outside the copy.

On **new, add and fork**, Scout links the personal folder into Claude's
`~/.claude/skills`, Codex's `~/.codex/skills`, and Cursor's `~/.cursor/skills`.
It reports each link. An existing link to the same folder is fine. A different
file stays untouched: Scout reports the conflict so you can reconcile it if
you also want that harness's own picker to use the personal copy.

## Find and run

`scout skills` lists the folder name, one-line description, status and path.
Links to the same folder appear once. A personal copy is **active**; other files
of that name remain visible as **shadowed**. Without a personal copy, distinct
files of the same name are **ambiguous**. Choose a listed path or narrow the
list with `--harness`. With a harness selected, Scout reads the personal root
and that harness's root, if any. `--on <host>` reads that host's catalog,
never the caller's as a substitute.

A run is an ordinary ask. The agent receives the plain brief and a reference
to the skill **on its machine**, not a copy of the instructions. Use
`scout ask --to <agent> --skill handoff-note "Summarize the changes."` to
name one in an agent ask. A local run defaults to the current project.
For a remote run, give `--on <host> --project <path-on-that-host>`. Quote a
listed `~/…` path when selecting it so the shell does not expand it.
`--dry-run` previews a run without sending it. The receipt means accepted,
not completed; follow the link for the result. Retry an uncertain acceptance
with the same `--request-id`.

[Untrack a folder](../../examples/skills/untrack-folder/SKILL.md) is an
example, not an installed skill. To try it: `scout skills add ./examples/skills/untrack-folder`,
then `scout run untrack-folder "Untrack assets/renders." --dry-run`.

## Surfaces

CLI and MCP (`skills_list`, `skills_run`) use `GET /v1/skills`
(`harness`, `host`; returns `{skills: [{name, description, status, path}]}`)
and `POST /v1/skills/run` (`name`, `brief`, optional target, current directory
and request ID; returns HTTP 202 with `{receipt, followUrl}`). An ordinary
delivery takes `task.skill`; the MCP `ask` tool takes `skill`.

**Next, not built:** search and pick a skill by name and description in Desk's
drop pop-up or ask box, enter one brief, then see the receipt and result in a
notification. Turning a finished ask into a skill in Desk is also future work.
No schedules, automatic edits, distribution service or UI in this version.
