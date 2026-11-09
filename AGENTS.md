# Scout core

This repository is the Scout core. It holds the runtime, the protocol, the
harness adapters, the `scout` CLI and MCP server, the TUI, `scoutd`, and the
host side of phone pairing. The Mac, iOS, Android, and web apps and the hosted
services live in a separate repository. Do not add app or UI source here.
[docs/public-source-boundary.md](docs/public-source-boundary.md) draws the
boundary.

## Layout

| Path | Holds |
| --- | --- |
| `packages/protocol` | `@openscout/protocol`: contracts, identities, routing metadata, record types |
| `packages/runtime` | `@openscout/runtime`: the runtime, persistence, service custody, mesh, delivery |
| `packages/cli` | `@openscout/scout`: the CLI and MCP server, published with the runtime and pairing bundled |
| `packages/pairing` | Host side of phone pairing: encrypted bridge, controller, phone RPC |
| `packages/agent-sessions` | Harness adapters and session extraction |
| `packages/session-trace` | Headless live-session trace model |
| `packages/mesh-extension` | HTTP adapter for the default MCP core tools |
| `packages/scout-tailscale` | Python client for owner-approved guest access over Tailscale |
| `crates/scoutd` | Native daemon for the base service: supervisor, probes, repo scan and diff |
| `crates/scout-tui` | Terminal UI |
| `crates/openscout-repo-service` | Compatibility wrapper over the `scoutd` repo service |
| `docs/agent/` | Dense specs for agents. Start at `docs/agent/README.agent.md` |

Core code must not import app source. Behavior that a client needs moves down
into a package here first.

## Rules

- The runtime is the only writer of Scout records. Clients and adapters send
  commands through its API.
- Harness transcripts are observed source material. Do not import them as
  Scout messages.
- One target is a DM. A group needs an explicit channel. Broadcast is opt-in.
- Route from target metadata. A message body is payload, not routing.
- Mesh means reachability and coordination. It does not mean exactly-once
  delivery, consensus, or transcript replication.
- A harness or session mismatch must fail with an actionable diagnostic. It
  must not hang.
- Scout assumes trusted local users and agents. Do not claim enterprise,
  compliance, or multi-tenant readiness.
- Use Bun 1.4.4 or newer.

## Test against your own instance

A checkout runs as its own Scout instance, with its own state, ports, and
service label. Test there. The installed runtime on port 43110 belongs to the
person whose machine it is.

- `bun run runtime:broker` starts the `dev` instance: runtime 24400, web 24410,
  pairing 24420–24422. A linked worktree gets `dev-<folder>` and its own ports.
- `scout --instance dev <command>` talks to that instance. Plain `scout` talks
  to the installed runtime.
- `scout instance list` shows the claimed instances and their ports.
- You must not stop, restart, or repoint the installed runtime
  (`app.openscout`) unless you are asked to.

[docs/dev-instances.md](docs/dev-instances.md) has the details.

## Checks

- Run the check for each package you change:
  `bun run --cwd packages/<name> check`. Protocol, runtime, pairing, cli,
  agent-sessions, session-trace, and mesh-extension have one.
- Run the narrowest affected tests while you work.
- New or changed process spawning or shell execution: `bun run sync-exec:fence`.
- Before you hand off a cross-package change: `bun run check` and
  `bun run test:unit`.
- CI also runs `bun run check:core` (no app imports) and
  `bun run check:presentation` (public repository presentation).
- Rust: `bun run scoutd:check`, `bun run scoutd:test`,
  `bun run scout:tui:check`, `bun run repo-service:check`.
- `bun run docs:generate` regenerates `llms.txt` and `docs.json` from `docs/`.
  This file is written by hand. Dewey does not generate it.

## Commits and pull requests

- Do not create or comment on GitHub issues unless the operator explicitly
  asks. Report internal failures in the handoff or through private Scout
  feedback when authorized. Public issues are not an agent work queue.
- Follow the [branching policy](CONTRIBUTING.md#branch-from-canonical-main).
  Local `main` tracks canonical `upstream/main`; fork `origin/main` is a
  fast-forward mirror. Make changes in topic worktrees and target canonical
  `main`. Historical integration branches are not new PR or release bases.
- Commit subjects use gitmoji: `🐛 Fix session route resolution`,
  `📝 Clarify runtime ownership`.
- Do not add AI co-author trailers or "Generated with" lines.
- Push a topic branch to your fork and open the pull request against
  `openscout-app/scout`. [CONTRIBUTING.md](CONTRIBUTING.md) lists what the
  description must contain.
- This repository is public. Do not commit local paths, host names,
  credentials, or private source.
- Do not run the `release`, `ship`, `publish`, or `bump` scripts unless a
  maintainer asks you to.

## Read next

- [docs/agent/README.agent.md](docs/agent/README.agent.md): records, the
  first-run ladder, and the rules for routing and runtimes.
- [docs/architecture.md](docs/architecture.md): the data model and identity.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup and pull requests.

<!-- scout:begin -->
## Scout

- Work for another agent, or on another machine, goes through Scout: `scout ask` (MCP `ask`).
- Another machine: `scout ask --on <host> --project <path on that host> --harness <claude|codex>`; `scout hosts` lists machines and their projects. Don't ssh in to launch agents.
- Syntax: `scout ask --help`, `scout help --detail`. Added by `scout setup agents-md`; `scout setup agents-md --remove` takes it out.
<!-- scout:end -->
