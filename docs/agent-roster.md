# Agent roster

Each agent has a short code, such as `OS-003`. The code has two parts:

- A **project code** (`OS`). By default it is two or three letters spelled
  from the project's name. The operator can set any code instead, such as
  `HAWK`. Each project holds one code, and no two projects hold the same code.
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
- **Freeing when gone.** A number frees when the runtime has not listed its
  agent for ten minutes, because the agent was deleted or retired. If the
  agent comes back inside the ten minutes, it keeps its number. A mesh agent
  whose peer is offline is still listed, so it keeps its number.
- **Freeing when idle.** A number also frees after 30 days with no activity
  (`ROSTER_IDLE_FREE_MS`). The 30 days count from the agent's latest
  activity, or from when it took its number if that is later, so an imported
  number is kept for 30 days. An agent that is active again after that takes
  a new number, as a new agent does.
- **Activity is kept.** The roster stores the latest activity it has seen
  for each agent, so an agent does not look idle when its endpoint is
  removed. The stored time moves forward only, never past the present. The
  runtime writes it when it has moved by an hour or more, and at once when
  the registry stops showing it. An activity time more than five minutes
  ahead of the runtime's clock is ignored, so a bad timestamp cannot keep an
  agent active.
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
  other letter pairs, then three-letter codes. These candidates are letters
  only.
- **Operator code.** The operator chooses the code: two letters, a longer
  name such as `HAWK` or `NIGHTOWL`, or a mix of letters and digits such as
  `R2D2`. The runtime stores it in capitals. It refuses only a code that
  breaks addressing or is taken:

  - A code is 1 to 12 letters or digits, with at least one letter, so it does
    not read as a roster number.
  - A code has no spaces or dashes, because they separate the code from the
    number (`HAWK-012`).
  - A code that another project holds is refused, and the refusal names that
    project.

  ```text
  $ scout roster project peal-bach HAWK
  $ scout roster project peal-bach 123
  "123" is not a project code: a code needs a letter, so it does not read as an agent's number
  $ scout roster project peal-bach night-owl
  "night-owl" is not a project code: a code has no spaces or dashes, which separate it from the agent's number
  $ scout roster project openscout-labs OS
  OS is held by project "openscout"
  ```

- **Defaults stay short.** A default is spelled from the name by the apps'
  rule and can have a digit when the name gives one (`app-2` → `A2`). When
  another project holds it, the next candidates are letters only. An import
  can set any code that an operator can.

- **Imported default.** An import that gives a project the code it already
  has by default does not change the code, and does not list it under
  `projectCodes`. The import now owns the code, so a later import cannot
  rename the project.

- **Reset.** `scout roster project <name> --reset` gives the project its
  default code again.

## Addresses

Wherever an agent target is accepted, a roster code resolves to the agent
that holds it. This includes `scout ask --to`, the MCP `ask` tool's `to`
argument, and broker route resolution.

```sh
scout ask --to OS-003 "status?"
scout ask --to HAWK-012 "status?"
scout ask --to 003 "status?"
```

A code of any length resolves with a dash or a space before the number
(`HAWK-012`, `hawk 012`). Run together with the number, only a code of two or
three resolves (`os003`), so a name such as `agent007` stays a name.

A roster code resolves before any agent name, a bare alias included. An
explicit `alias:` target still resolves as an alias. A gone agent keeps its
code until its number frees, so in that time the code fails with
`roster_agent_gone` and no alias or name takes it. If no agent holds the
code, an alias or an agent whose name looks like a code (for example
`box100`) still resolves. Otherwise the target fails with a diagnostic. The
runtime never guesses another agent:

| Diagnostic | Meaning |
| --- | --- |
| `unknown_project_code` | No project holds the code (`XQ-003`). |
| `unknown_roster_number` | No agent holds the number (`004`). |
| `roster_code_mismatch` | The number belongs to an agent in another project (`PB-003` when 003 is `OS-003`). |
| `roster_agent_gone` | The agent was deleted or retired, and its number frees soon. A code from another project is a mismatch instead. |

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
imported do not change, and their idle time does not restart.

## Interfaces

| Surface | Shape |
| --- | --- |
| `GET /v1/roster` | `{ agents: AgentRosterEntry[], projects: RosterProjectRecord[], capacity: { max, held } }` |
| `POST /v1/roster/projects/code` | `{ project, code \| null }` → `{ project }`; `409 project_code_held` names the holder in `heldBy` |
| `POST /v1/roster/import` | `{ entries, dryRun? }` → `{ dryRun, imported, renumbered, projectCodes, conflicts }` |
| `POST /v1/roster/resolve` | `{ address }` → `{ address, resolved, entry?, diagnostic? }` |
| `scout roster` | `list`, `project <name> <code>\|--reset`, `import <file\|-> [--dry-run]`, `resolve <code>`; `--json` for the broker's JSON |
| `GET /v1/snapshot` | Each agent record whose agent holds a number has `roster`: the same tag. `/v1/mesh/snapshot` leaves it out. |
| Pairing `WebAgent` | `roster`: the same tag, or `null` while the agent holds no number |
| `scout who --json` | Each agent that holds a number has `roster: { number, numberText, projectCode, code, label }` |
| MCP `agents_search` | Candidates carry the same `roster` tag. A roster-code query returns the agent that holds the code. |

The tag is:

```json
{ "number": 3, "numberText": "003", "projectCode": "OS", "code": "OS-003", "label": "OS 003" }
```

`projectCode` is `null` for an agent with no project. Its `code` and `label`
are then the number alone (`003`). The runtime adds the tag to the snapshot
response and never stores it on the agent record. A record that carries a
stale `roster` field loses it in the response. A deleted or retired agent
whose number has not freed yet has no tag.

The roster routes are local-tier: mesh peers cannot reach them. The routes
also refuse remote and guest callers themselves, so an ingress gate that
only warns does not open them. A roster number names an agent only on its
own runtime, so the mesh snapshot carries no tags, and it drops a stale
`roster` field as the local snapshot does. The types are in `@openscout/protocol` (`agent-roster.ts`:
`AgentRosterTag`, `AgentRecordWithRoster`).
