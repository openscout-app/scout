# Session names

A harness gives each session a title early and rarely changes it. A Claude
session called `kernel-panic-last-boot` keeps that title long after the work
has moved on. Scout lets the operator name a session for what it does now,
and it can name a session after the work it is doing.

## The order

Every Scout session read resolves a session's name in one order:

1. **Operator name.** A name the operator set with `scout session rename`,
   the `sessions_rename` MCP tool, or the web app.
2. **Work title.** The title of the work item the session is doing now.
3. **Harness title.** The harness's own title.

The first part that has a value is the name. A read also keeps the
harness's own title, so a surface can show "renamed from …".

## Where the name shows

| Read | Name | Source | Harness title |
| --- | --- | --- | --- |
| `GET /v1/tail/discover` | `title` (and `sessionName` when it is not the harness's) | `sessionNameSource`: `operator`, `work` or null | `harnessTitle` |
| `GET /v1/observed-sessions`, `/resolve` | `title` | `titleSource`: `operator`, `work`, `harness` or null | `harnessTitle` |
| MCP `sessions_inventory`, `sessions_search` | `title` | `titleSource` | `harnessTitle` |
| Mesh node state and MCP `route_context` | session `title` | — | — |

`sessions_inventory` matches a query against the name and the harness
title, so the old title still finds a renamed session.

A tail transcript keeps the harness's `customTitle`, `agentName` and
`aiTitle` fields unchanged. A client that builds its own label from those
fields must read `sessionName` first.

## Set and clear a name

```bash
scout session rename <selector> <name...> [--harness <name>]
scout session rename <selector> --clear
scout session rename --self <name...>
scout session names
```

A selector is one of:

- A native session id: `0d5a…`.
- `<harness>:<id>`: `claude:0d5a…`.
- An agent or session actor id, or a session handle.
- A session address: `sess.<token>@<host>`.

When one id names sessions in two harnesses, the command fails and lists
both. Add `--harness` to choose one. With `--harness`, a native id can name
a session that Scout has not observed yet.

`--self` names the session the command runs in. It reads
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`.

An empty name, a null name, or `--clear` removes the operator name. The
session then shows its work title or its harness title.

A name is at most 120 characters. Scout collapses runs of whitespace and
refuses control characters.

### Runtime API

```http
GET  /v1/session-names
POST /v1/session-names
{ "selector": "claude:0d5a…", "name": "Session names" }
```

`POST` also takes `harness` and `nativeSessionId` in place of `selector`.
The response gives `action` (`set`, `cleared` or `unchanged`), the
`session` it resolved, the stored `record`, and the `resolution` with
every part of the name. An unknown selector returns 404
(`session_not_found`), and an ambiguous selector returns 409
(`ambiguous_session`) with `candidates`.

Both routes are machine-local. Remote, guest and scoped callers receive 403.

## Storage

The runtime stores operator names in the `session_names` table of the
control-plane database. The key is the observed identity on this node:
harness and native session id. A name survives a runtime restart. Clearing
a name deletes its row.

Names are local metadata. Scout never writes a name into the harness's own
session files, and a name does not travel to another machine's runtime.
A peer that reads this node's mesh state sees the name as the session's
title.

## Names that follow the work

When the operator has not set a name, a session takes the title of its
current work item. The runtime chooses that title as follows:

- The work item is a Scout work item whose owner is an agent that points
  at this session. The work is in the `working`, `waiting` or `review`
  state. Open work that has not started does not count, and finished or
  cancelled work does not count.
- When the agent owns several current work items, the most recently
  updated one wins.
- When the agent points at more than one session, no session takes the
  title. The agent cannot say which session does the work.

This rule reads only records the runtime already holds, so it costs no
model call. It names a session only when someone gave the work a title.
Most asks carry no work item, so many sessions keep their harness title.

A name drawn from what the session says or does would follow the work
more closely. That needs a model to summarize recent turns, so it is not
part of this rule. One design: summarize a session's last few turns into a
short title on an idle turn boundary. Store the result as a fourth source,
below the work title, and refresh it only after new turns.
