# Agent roster

Each agent has a short code, such as `OS-003`. The code has two parts:

- A **project code** of two or three capitals (`OS`). Each project holds one
  code, and no two projects hold the same code.
- A **roster number** of three digits (`003`). One roster covers all
  projects, so the number alone names one agent.

The apps show the code as `OS 003`. You address the agent as `OS-003`.
`os003`, `OS 003` and `003` name the same agent.

The runtime is the only writer of the roster. The apps and the CLI read it
and change it through the runtime API.

## The same agent

The roster keys a number by the agent's Scout agent id
(`<definition>.<workspace>.<node>`). It never keys a number by a handle,
display name or session:

- Agents that share a handle, such as `claude`, hold one number each.
- Sessions do not create agent ids. All sessions of one agent share its
  number.
- A number stays with its agent id across runtime restarts.

## Numbers

- **Assignment.** The runtime gives an agent the lowest free number the first
  time it sees the agent active. Active means the runtime lists the agent
  (registered and not retired) and the agent or one of its endpoints was
  active in the last seven days. When two agents are new at the same time,
  the agent the runtime registered first gets the lower number.
- **Freeing.** A number frees when the runtime has not listed its agent for
  ten minutes, because the agent was deleted or retired. If the agent comes
  back inside the ten minutes, it keeps its number. A mesh agent whose peer is
  offline is still listed, so it keeps its number.
- **Reuse.** A freed number goes to the next new agent only when every lower
  number is held.
- **Capacity.** The roster holds 999 numbers. When all of them are held, a
  new agent gets no number and the runtime logs that the roster is full.

## Project codes

The project is the `project` field on the agent record, the same field the
apps show. The project's key is its name, trimmed and in lower case.

- **Default.** The default code comes from the project name by the apps'
  ident rule (`openscout` → `OS`, `peal-bach` → `PB`), so the codes that the
  apps show today do not change. If another project already holds the
  default, the runtime takes the next candidate spelled from the name: the
  other letter pairs, then three-letter codes.
- **Operator code.** The operator can set a code of two or three letters or
  digits, with at least one letter. The runtime refuses a code that another
  project holds and names that project:

  ```text
  $ scout roster project openscout-labs OS
  OS is held by project "openscout"
  ```

- **Reset.** `scout roster project <name> --reset` gives the project its
  default code again.

## Addresses

Wherever an agent target is accepted, a roster code resolves to the agent
that holds it. This includes `scout ask --to`, the MCP `ask` tool's `to`
argument, and broker route resolution.

```sh
scout ask --to OS-003 "status?"
scout ask --to 003 "status?"
```

A roster code resolves before any agent name. If no agent holds the code,
an agent whose name looks like a code (for example `box100`) still resolves
by name. Otherwise the target fails with a diagnostic. The runtime never
guesses another agent:

| Diagnostic | Meaning |
| --- | --- |
| `unknown_project_code` | No project holds the code (`XQ-003`). |
| `unknown_roster_number` | No agent holds the number (`004`). |
| `roster_code_mismatch` | The number belongs to an agent in another project (`PB-003` when 003 is `OS-003`). |
| `roster_agent_gone` | The agent was deleted or retired, and its number frees soon. |

## Import from the apps

Before the runtime held the roster, the apps numbered agents in browser
storage. A one-time import moves those numbers into the runtime.

The import file is JSON. It is a list of entries, or an object with an
`entries` list:

```json
[
  { "agentId": "claude.openscout.node-a", "number": "003", "projectCode": "OS" },
  { "agentId": "codex.peal-bach.node-a", "number": 7, "projectCode": "PB" }
]
```

`number` is 3 or `"003"`. `projectCode` is optional.

```sh
scout roster import roster.json --dry-run
scout roster import roster.json
```

The import keeps every number that does not conflict:

- An imported number replaces a number that the runtime assigned by itself.
  The runtime moves that agent to the lowest free number and reports it under
  `renumbered`.
- An entry gives its project code to its project, unless the operator or an
  earlier import already set a different code, or another project holds the
  code. The number is still imported in those cases.
- Each entry that the import cannot keep is reported under `conflicts`, with
  a reason: `invalid_entry`, `duplicate_agent`, `duplicate_number`,
  `unknown_agent`, `agent_not_listed`, `number_held`,
  `agent_already_imported`, `invalid_project_code`, `no_project`,
  `project_code_held` or `project_code_differs`.

You can run the import again. When you do, the entries that it already
imported do not change.

## Interfaces

| Surface | Shape |
| --- | --- |
| `GET /v1/roster` | `{ agents: AgentRosterEntry[], projects: RosterProjectRecord[], capacity: { max, held } }` |
| `POST /v1/roster/projects/code` | `{ project, code \| null }` → `{ project }`; `409 project_code_held` names the holder in `heldBy` |
| `POST /v1/roster/import` | `{ entries, dryRun? }` → `{ dryRun, imported, renumbered, projectCodes, conflicts }` |
| `POST /v1/roster/resolve` | `{ address }` → `{ address, resolved, entry?, diagnostic? }` |
| `scout roster` | `list`, `project <name> <code>\|--reset`, `import <file\|-> [--dry-run]`, `resolve <code>`; `--json` for the broker's JSON |
| `scout who --json` | Each agent that holds a number has `roster: { number, numberText, projectCode, code, label }` |
| MCP `agents_search` | Candidates carry the same `roster` tag. A roster-code query returns the agent that holds the code. |

The roster routes are local-tier: mesh peers cannot reach them. The types are
in `@openscout/protocol` (`agent-roster.ts`).
