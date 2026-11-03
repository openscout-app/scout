# Scout

Scout is the local runtime that coordinates coding agents on a host. It connects
Claude Code, Codex, and other harnesses through one model for identity, routing,
requests, replies, and durable work. Mesh connects runtimes across trusted hosts.

Keep using your existing agent tools and provider accounts. Scout supplies the
runtime, harness adapters, session observation and extraction, CLI, TUI, and
host side of phone pairing. The terminal is the core's interface.

The Mac, iOS, Android, and web apps are separate clients built on this core.
Their source is not in this repository, and the npm package includes no web app.
Hosted services are also separate. You can build your own interface without
adopting any of those clients or services.

[What lives where](#what-lives-where) · [Install](#install-and-first-run) ·
[Terminal workflows](#terminal-workflows) · [Build an interface](#build-your-own-interface)

## What lives where

<!-- diagram:layers:start -->

<!-- Generated from .github/diagrams/layers.txt. -->

```text
 Your coding agents: Claude Code · Codex · Grok · OpenCode · Kimi · Pi · more
                                       ▲
                                       │ harness adapters
┌─ Scout core ── openscout-app/scout ── public, Apache 2.0 ──────────────────┐
│                                                                            │
│  scout CLI, TUI and MCP server                @openscout/scout             │
│  Runtime: routing, records, lifecycle, mesh   @openscout/runtime           │
│  Protocol: identities, messages, flights      @openscout/protocol          │
│  Harness adapters, session extraction         @openscout/agent-sessions    │
│  Host side of phone pairing                   bundled in the CLI           │
│  scoutd, repository service, Rust TUI         crates/                      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
               released packages · runtime API · CLI JSON · MCP
                ▲                            ▲                             ▲
┌─ Scout apps ──┴────────┐  ┌─ Your client ──┴─────┐  ┌─ Hosted services ──┴─┐
│  Mac, iOS, Android     │  │  Same APIs as        │  │  Accounts, relay     │
│  and web               │  │  the apps            │  │  and push            │
└────────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

<!-- diagram:layers:end -->

This repository is the core box. Everything in it runs on each host.
`npm install -g @openscout/scout` installs the CLI with the runtime it runs, and
`scout tui` fetches the Rust TUI on first use. The Scout apps and hosted
services are separate. They reach the core through the released packages,
runtime API, CLI JSON and MCP server, the same interfaces your own client uses.
The [source boundary](./docs/public-source-boundary.md) states the ownership
rules in full.

## Install and first run

Local coordination requires [Bun 1.4.4 or newer](https://bun.sh), Apple-silicon
macOS or Linux, and an installed, authenticated coding-agent harness for routed
work. Install the package with npm; Bun runs the local runtime.

```bash
npm install -g @openscout/scout
scout --version
scout setup
scout doctor
```

Installing the package does not silently start services. On macOS, `setup`
configures and starts the local runtime. On Linux, `setup` saves configuration;
start the foreground runtime in a separate terminal or under your process
manager:

```bash
openscout-runtime broker
```

Then run `scout doctor` again. If readiness fails, follow the first blocking
diagnostic. See [Install Scout](./install.md) for Linux service configuration
and recovery steps.

From a project directory, inspect your identity and available harnesses:

```bash
scout whoami
scout who
scout runtimes
```

`who` lists known agents, not proof of live work. A runtime catalog entry needs
an installed harness, authentication, and provider access before it can run.

## Terminal workflows

### Ask another agent to review a change

Pause edits while the reviewer reads the diff. This example requires Claude
Code on the destination host:

```bash
scout ask --project . --harness claude \
  "Review the uncommitted diff for correctness. Return findings with file and line references, or say no findings. Do not edit files or run tests."
```

Scout resolves or starts a worker and returns a receipt on acceptance, not
completion. Replace `ref:RETURNED` with the handle from the receipt:

```bash
scout wait ref:RETURNED --timeout 600
scout ask --continue ref:RETURNED \
  "Explain the most important finding and the input that triggers it. Do not edit files."
```

`wait` also accepts a flight or invocation id. A timeout does not cancel the
work; wait on the same handle again. To use Codex instead, set
`--harness codex` in the first request. Other execution routes include
`grok-acp`, `opencode`, `kimi`, and `pi`; inspect `scout runtimes` for readiness.

### Choose the right route

| Intent | Command |
| --- | --- |
| Request work and a reply | `scout ask --to <target> "<request>"` |
| Send an update without requesting work | `scout ask --to <target> --fyi "<update>"` |
| Start work in a project | `scout ask --project . --harness codex "<request>"` |
| Answer a task | `scout reply --ref <task> "<answer>"` |
| Add context to unfinished work | `scout ask --ref <task> "<context>"` |
| Continue an exact session | `scout ask --to session:<id> "<request>"` |
| Post to a named group | `scout ask --channel <name> --fyi "<update>"` |

One target is a direct message. Group coordination requires an explicit channel;
broadcast is opt-in. Sessions do not share context. Include the goal, checkout,
revision, constraints, and expected result, or pass a brief with `--prompt-file`.

### Inspect work from the terminal

```bash
scout status
scout tui
scout mesh status
scout pair
```

The TUI is a core terminal interface. `scout tui` resolves a local binary or
downloads the version-matched release binary when needed. `scout pair` starts
phone pairing on the host; the phone app is a separate client.

Mesh extends reachability, not filesystem synchronization, transcript
replication, global consensus, or exactly-once delivery. A remote task still
needs the intended checkout and an authenticated harness on its destination.
Scout assumes trusted local users and agents; it is not a hardened untrusted
multi-tenant or compliance boundary. Model inference remains with your provider.

## Build your own interface

Use the same runtime as the CLI. Your client can present agents, sessions,
messages, flights, and work without depending on an existing Scout app.

### Start with JSON or MCP

Use structured CLI output instead of parsing terminal prose. `doctor --json`
retains its NDJSON diagnostic stream:

```bash
scout doctor --json
scout who --json
scout runtimes --json
scout status --json
```

For an agent-facing integration, run `scout mcp` as a stdio MCP server. A client
that accepts command-based MCP configuration can use the installed CLI:

```json
{
  "mcpServers": {
    "scout": {
      "command": "scout",
      "args": ["mcp"]
    }
  }
}
```

The client's PATH must include `scout` and Bun. Initialize the runtime before
using coordination tools. Use MCP `tools/list` to inspect tool names and input
schemas. Tools include `ask` for tasks, `ask` with `fyi: true` for news, `reply` for answers, and
`invocations_get` and `invocations_wait` to follow results. See the
[MCP API guide](./docs/mcp-api-posture.md) and
[integration contract](./docs/agent-integration-contract.md).

### Use the public packages

| Package | Use it for |
| --- | --- |
| [`@openscout/protocol`](./packages/protocol) | Identity grammar, messages, requests, flights, and shared wire contracts |
| [`@openscout/runtime`](./packages/runtime) | Host-side routing, storage, lifecycle, discovery, mesh, and client APIs |
| [`@openscout/agent-sessions`](./packages/agent-sessions) | Harness adapters, observed events, snapshots, approvals, and session extraction |
| [`@openscout/scout`](./packages/cli) | Installed CLI, bundled runtime, JSON output, and MCP server |

Read each package's export map before importing a subpath. For example,
`@openscout/runtime/broker-api` provides the runtime's HTTP client helpers;
`@openscout/runtime/host-attention` provides host attention reads. The runtime
is host-side code, not a browser library. Put it behind your own host service
when building a browser interface. Start with the runtime guide's
[in-memory example](./packages/runtime/README.md#quickstart-embed-the-in-memory-runtime)
and the agent-sessions guide's [adapter example](./packages/agent-sessions/README.md#quickstart).

<!-- arc:control-plane:start -->

<!-- Generated from .github/diagrams/control-plane.arc.json by @arach/arc. -->

```text
                                                    ╔══════════════════════╗
                     ╔══════════════════════╗       ║ ◆ Local runtime      ║
                     ║ ◆ Scout surfaces     ║       ║ canonical writer     ║
┌────────────────┐   ║ CLI + TUI + MCP      ║   ┌──▶║ route + run          ║
│ ◆ Operator     │ ┌▶║ one control plane    ║───┘   ║                      ║
│ or agent       │─┘ ║                      ║       ╚══════════════════════╝
└────────────────┘   ╚══════════════════════╝                   │
                                                                │
                                                                │
                                              ┌─────────────────┴─────────┐
                                              │                           │
                                              ▼                           │
                                  ╔═══════════════════════╗               ▼
                                  ║ ◆ Harnesses + mesh    ║      ┌────────────────┐
                                  ║ Codex · Claude · ACP  ║      │ ◆ Records      │
                                  ║ reachable peers       ║      │ durable        │
                                  ║                       ║      │                │
                                  ╚═══════════════════════╝      └────────────────┘
```

<!-- arc:control-plane:end -->

The runtime is the canonical writer of Scout-owned coordination records. Clients
submit commands through its APIs; they do not write its database or maintain a
competing registry. Harness transcripts remain observed source material, not
imported Scout conversation history.

The host side of phone pairing lives in `packages/pairing` as
`@openscout/pairing`. Its closed exports are `.`, `/runtime`, `/controller`,
`/terminal`, `/host`, `/http`, `/pair-requests`, `/lan-beacon`, `/web-handoff`
and `/artifacts`. Bun resolves source; ESM and types resolve the package's
compiled `dist`. Use `scout pair` as the terminal entry point.

The package is internal to the core workspace and bundled into
`@openscout/scout`; it is not a separately published npm package. A standalone
controller build starts from `packages/pairing/src/pairing-runtime-controller.ts`,
which applies instance isolation before launching the controller. Importing
`/controller` supplies its function, not an automatically started process.

### Add a CLI extension

An extension adds a verb through an explicitly installed local artifact with
an `extension.json` manifest and an executable. Built-in verbs take precedence;
the CLI does not discover extensions by searching PATH. Extensions use the same
public runtime APIs as other clients.

See [Extensions](./docs/extensions.md) for an artifact example, installation,
completion, and help. CLI extensions do not require a web app or a UI composition
framework. `scout server` and `scout web` use a web client only when the separate
apps layer supplies one; neither command makes a web app part of the core.

## Work on Scout

```bash
git clone https://github.com/openscout-app/scout.git
cd scout
bun install
bun run --cwd packages/cli build
./packages/cli/bin/scout --version
```

The source tree includes the packages above and native services in
[`crates`](./crates), including `scoutd`, the repository service, and the Rust
TUI. No private checkout is required to build or test the core.

Run package-local checks for the area you change. Run `bun run sync-exec:fence`
before submitting shell-execution changes. See [Contributing](./CONTRIBUTING.md)
and the [release guide](./docs/releases.md).

## Go deeper

- [Quickstart](./docs/quickstart.md)
- [CLI guide](./packages/cli/README.md)
- [Architecture](./docs/architecture.md) and [concepts](./docs/concepts.md)
- [Session search](./docs/session-search.md)
- [Coding-agent collaboration](./docs/coding-agent-collaboration-2026.md)
- [Public-source boundary](./docs/public-source-boundary.md)
- [Linux desktop integrations](./docs/linux-desktop.md) and [Omarchy launcher](./integrations/omarchy/README.md)
- [Integration repositories](https://github.com/openscout-app)

## License

Apache 2.0. See [LICENSE](./LICENSE).
