# Dev instances: running a checkout beside the installed Scout

Web port reservations in this guide apply only when a separate web client is
configured. The core does not ship a web app.

A checkout or worktree runs as its own Scout **instance**, never as the
installed ("prod") one. One knob, `OPENSCOUT_INSTANCE`, derives everything;
`prod` (the default) is the installed layout, unchanged.

| | prod (installed) | `dev` (main checkout) | `dev-<folder>` (linked worktree) |
|---|---|---|---|
| root | `~/.openscout`, `~/.scout`, support dir | `~/.openscout/instances/dev` | `~/.openscout/instances/dev-<folder>` |
| broker / web / pairing ports | 43110 / 43120 / 43130–43132 | 24400 / 24410 / 24420–24422 | first free block in 24450–30399 from a hashed start, reserved in `~/.openscout/instances/.slots` |
| node | `<host>` | `<host>-dev` | `<host>-dev-<folder>` |
| service | `app.openscout` / `scout.service` | `app.openscout.dev` / `scout-dev.service` | `app.openscout.dev-<folder>` / `scout-dev-<folder>.service` |
| mesh | on | off (`OPENSCOUT_INSTANCE_MESH=1` opts in) | off |

- `bun run runtime:broker` and `bun packages/runtime/src/broker-daemon.ts`
  default to `dev`
  (or `dev-<folder>` in a linked worktree). A second clone, or a folder whose
  name truncates like another, gets `<name>-<hash>`; the registry records which
  checkout owns which name. Set `OPENSCOUT_INSTANCE=<name>` to pick one.
- This also works inside Scout-launched agent shells and terminals: they
  start without the launching instance's identity (a non-prod launcher's
  derived env is dropped; a prod launcher's explicit overrides are kept), plus
  `OPENSCOUT_CLIENT_INSTANCE`, which makes their `scout` commands reach the
  broker that launched them. An
  explicit `OPENSCOUT_INSTANCE` always wins, and a non-prod instance ignores
  ambient ports/URLs; customize it with `OPENSCOUT_INSTANCE_ROOT`,
  `OPENSCOUT_INSTANCE_PORT_BASE`, `OPENSCOUT_INSTANCE_MESH` or its own
  `~/.openscout/instances/<name>/config.json` ports.
- `scout instance list` shows claimed instances and port blocks;
  `scout instance release <name> [--purge]` frees one.
- Target an instance from the CLI with `scout --instance dev …` or
  `OPENSCOUT_INSTANCE=dev scout …`. Plain `scout` talks to prod (or, inside a
  Scout-launched terminal or agent, to the runtime that launched it).
  `scout doctor` and `scout status` print the instance they checked.
- Prod keeps honouring individual env vars (`OPENSCOUT_BROKER_PORT`, …). A
  non-prod instance derives them all from its layout, and refuses to start
  when an `OPENSCOUT_INSTANCE_*` knob or a service config lands on a prod
  port, inside a prod directory, on prod's service label/unit or on prod's
  node identity, and lists why.
- A dev instance never claims the Claude statusline in `~/.claude/settings.json`;
  that stays with prod (`OPENSCOUT_STATUSLINE_INSTANCE=<name>` to override).
- Named instances do not start the shared Caddy edge or publish its mDNS names,
  even with `OPENSCOUT_BASE_EDGE_ENABLED=1`. Use the instance's web port (for
  example, `http://localhost:24410` for `dev`). The production edge owns ports
  80/443, its TLS state and the `scout.local` doorways.
- Throw an instance away with `scout instance release <name> --purge` once its
  processes are stopped.
- Processes launched by an existing supervisor or broker keep their selected instance; the checkout default only applies to direct development entrypoints.

See [instance contracts](agent/instances.agent.md) for the environment, registry, and service invariants.

## scoutd projection recovery smoke test

Build the checkout binary, then run the foreground recovery test:

```sh
bun run scoutd:build
bun scripts/scoutd-health-recovery-smoke.ts
```

The script creates a named dev instance and a scratch projection-open fault.
It verifies a supervised restart, mutation readiness, and condition clearance.
It does not control any launchd service. See the
[health sweep contract](scoutd-health-sweep.md) for the assertions and safety limits.
