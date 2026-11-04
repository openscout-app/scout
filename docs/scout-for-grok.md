# Scout for Grok Bot

Bring your local coding agents into a Grok Bot conversation — and let Scout launch Grok as a harness when the work belongs there.

Scout connects to Grok in **three complementary ways**. This page is the map. For concise setup and machine-readable instructions, use [Grok](https://openscout.app/grok) or [Grok Bot](https://openscout.app/grokbot).

| Path | What it is | When to use it |
| --- | --- | --- |
| **Hosted MCP connector** | Grok Bot → `https://mcp.oscout.net` → your online bridge → local runtime | Talking to Scout **from** Grok Bot over the internet |
| **Local host package** ([grok-scout](https://github.com/arach/grok-scout)) | Installer that writes `scout` into `~/.cursor/mcp.json` so the host runs `scout mcp` locally | Cursor using a Grok model on the Scout machine |
| **Execution harness** (`--harness grok-acp`) | Scout starts a Grok CLI / ACP session as a worker | Handing work **to** Grok from Scout, Claude, Codex, etc. |

They share one broker contract: messages, asks, flights, and durable handles. They are not substitutes for each other.

Canonical URL on the site: [openscout.app/docs/scout-for-grok](https://openscout.app/docs/scout-for-grok).

---

For a complete worked handoff, read [Claude Code and Grok collaboration](https://openscout.app/blog/claude-code-grok-collaboration). For the shared client, broker, worker, and result model, read [Use coding agents through an MCP client](https://openscout.app/blog/use-coding-agents-from-mcp-clients).

## 1. Hosted connector (Grok Bot ↔ your mesh)

**Connector URL:** `https://mcp.oscout.net`

This is the path when Grok Bot should reach agents on your Scout machine from anywhere Cursor/Grok Bot runs.

Custom MCP setup works today. The Grok Bot / Cursor marketplace application was submitted on September 21, 2026. Approval is pending; there is no approved listing URL yet.

### Prerequisites

- Scout installed and healthy (`scout doctor`)
- A **provisioned, online** MCP bridge for your account (operator-assisted for local developer environments today)
- The GitHub account that owns that bridge

Adding the connector alone does **not** install Scout or create a bridge.

### Connect

1. Open Grok Bot → **Plugins** → add a custom MCP server.
2. Name it **Scout**.
3. URL: `https://mcp.oscout.net`. Leave custom headers empty.
4. Complete browser sign-in with GitHub (the account tied to your Scout bridge).
5. Choose the agent identity that will appear in Scout, review scopes, approve.
6. Ask Grok Bot to call Scout's `whoami` and confirm the expected identity before handing off real work.

OAuth only — do not paste an API key into Grok Bot.

### First handoff

Give Grok Bot the **project directory on the Scout machine** and the work:

> Use Scout to ask a Claude agent in my project at `/path/on/scout-machine` to review the latest changes. Keep the returned work handle so we can follow up.

Scout routes to a compatible worker. Continue with the returned flight, conversation, work, or session handle.

Useful follow-ups from Grok Bot:

- Read inbox messages and replies
- `ask` with `fyi: true` for fire-and-forget updates
- `ask` for owned work that needs a reply
- Inspect a flight when something needs attention

### How the hosted path connects

```text
Grok Bot → Scout hosted MCP gateway (mcp.oscout.net)
        → your online bridge
        → local Scout broker
        → coding agents / harnesses
```

The gateway supplies authenticated identity. Your local runtime owns the records. The bridge exposes Scout's core MCP tier (`mcp:core`): identity, messaging, asks, work updates, flight inspection.

If a call returns `node_unreachable`:

```bash
scout mesh bridge status
```

Reconnect loops in Grok Bot will not provision a missing bridge — finish operator setup first.

Host plugin help: [Grok Bot connect plugins](https://cursor.com/help/grok-bot/connect-plugins). See the [MCP setup guide](https://openscout.app/mcp) for transport and verification details.

---

## 2. Local host package (grok-scout)

When Cursor hosting Grok agents runs on the **same machine** as Scout, you can point Cursor at the local stdio MCP server — the same pattern as [Cursor Scout](https://github.com/openscout-app/cursor-scout).

| | |
| --- | --- |
| Repository | [github.com/arach/grok-scout](https://github.com/arach/grok-scout) |
| Package page | [arach.github.io/grok-scout](https://arach.github.io/grok-scout/) |
| What it installs | A `scout` entry in `~/.cursor/mcp.json` (or project `.cursor/mcp.json`) that launches `scout mcp` |

```bash
git clone https://github.com/arach/grok-scout
cd grok-scout
bun run install:global   # or: bun run install:project
scout doctor
```

Then confirm Scout MCP tools appear in Cursor (`whoami`, `ask`, `reply`, …).

This package does **not** reimplement the runtime. It is thin host packaging so Grok is discoverable in the ecosystem the same way Claude, Codex, Cursor, pi, and Hermes are.

---

## 3. Grok as an execution harness

Scout can also **launch** Grok as a worker:

```bash
scout runtimes --json
scout ask --project /path/to/repo --harness grok-acp "Review the auth change"
```

The current catalog lists `grok-acp` for Grok CLI over ACP. This requires a ready Grok runtime. Use `scout runtimes --json` to discover supported harness/model/effort combinations and follow the selected runtime's authentication instructions. Check the returned invocation's execution resolution before claiming a particular model ran.

Use this when another agent (or you) wants Grok to **do** the work inside Scout's flight model. Use the hosted connector or grok-scout when Grok Bot should **call** Scout.

---

## Tasks and FYIs (same as every Scout host)

- **Ask** — owned work that expects a reply: MCP `ask` / `scout ask …`
- **FYI** — one-way updates only: `ask` with `fyi: true` / `scout ask --fyi --to …`

Prefer project-path + optional harness over guessing names like `claude.main`. Follow up with the durable handle Scout returns.

---

## Access, trust, and marketplace

- Hosted connector scope: core `mcp:core` (read/send messages, create asks, follow work).
- Grok Bot connections can be shared across bots on the same Cursor account — review with that in mind.
- Scout remains high-trust local developer environments; hosted bridge provisioning is operator-assisted.
- The hosted connector marketplace submission is pending review. Until then, use custom MCP with `https://mcp.oscout.net`.

---

## Related

- [Connect Claude Code and Grok for research and code review](https://openscout.app/blog/claude-code-grok-collaboration) — a complete brief, implementation handoff, and review workflow
- [Host integrations directory](./integrations.md) — full companion map
- [Quickstart](./quickstart.md) — healthy local Scout
- [Agent integration contract](./agent-integration-contract.md) — plugging runtimes into Scout
- [grok-scout](https://github.com/arach/grok-scout) · [cursor-scout](https://github.com/openscout-app/cursor-scout) — local MCP packaging twins
