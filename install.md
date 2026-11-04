# Install Scout

This guide installs the published Scout CLI and verifies that its machine-local
runtime is ready to route work.

## Requirements

- Apple-silicon macOS, or Linux with a process manager for the foreground
  runtime;
- [Bun](https://bun.sh) 1.4.4 or newer;
- a supported coding-agent harness such as Codex or Claude Code for routed
  work.

## Install the published package

```bash
bun add -g @openscout/scout
scout --version
```

On Apple-silicon macOS, initialize Scout explicitly, then run its readiness
check:

```bash
scout setup
scout doctor
```

Setup and doctor assess the public core, not private app health. See the
[core readiness contract](docs/core-readiness.md) for JSON schemas and limits.

### Linux and headless servers

The packaged `scoutd` supervisor is macOS-only and is never executed on Linux.
Linux uses the foreground runtime by default:

```bash
bun add -g @openscout/scout
scout setup --source-root ~/dev
openscout-runtime broker
```

On a fresh host, setup saves configuration and exits successfully with a
foreground-runtime handoff. This does not mean the runtime is running or ready;
actual setup failures still exit
nonzero. Keep `openscout-runtime broker` running in that shell (or under your
process manager, as your user with Bun on PATH), then rerun
`scout setup --source-root ~/dev` and `scout doctor --json` from another
shell to verify runtime health and agent readiness.

#### Optional: run the runtime as a systemd user unit

On a machine with a systemd user manager you can have Scout install and run
the runtime as a user unit instead (the `linux-systemd-user` adapter). It is
opt-in, and only through the adapter env; without it every command keeps the
foreground lifecycle.

```bash
export OPENSCOUT_SERVICE_ADAPTER=systemd-user
scout setup --source-root ~/dev          # installs, enables and starts the unit
openscout-runtime service status         # or: systemctl --user status scout.service
```

Keep `OPENSCOUT_SERVICE_ADAPTER=systemd-user` in the environment you run
`scout setup`, `scout doctor` and `openscout-runtime service …` from so they
manage and report the unit.

The unit is `~/.config/systemd/user/scout.service` (`scout-<instance>.service`
for a non-prod `OPENSCOUT_INSTANCE`). It runs the installed package's
`openscout-runtime broker` with Bun's global bin on `PATH`
(`$BUN_INSTALL/bin`, else `bun pm bin -g`: `~/.cache/.bun/bin` when Bun comes
from mise, `~/.bun/bin` otherwise) and `Restart=on-failure`:

```ini
[Unit]
Description=Scout broker (installed @openscout/scout)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=%h/.cache/.bun/bin:%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin
ExecStart=%h/.cache/.bun/bin/openscout-runtime broker
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

A unit that runs Scout from a source checkout also carries
`Environment=OPENSCOUT_INSTANCE=<name>` (including `prod`), so the runtime
never takes the checkout's dev default. An existing unit with this shape is
adopted as-is, including any `Environment=` lines you added (for example
`OPENSCOUT_ADVERTISE_SCOPE=mesh`, or quoted values). Scout does not repoint,
stop or uninstall a unit that runs a different Scout runtime (another install
or a checkout) unless you rerun with `OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT=1`.
`start` fails, with a `journalctl --user -u <unit>` hint, when the runtime does
not become healthy, and status warns when lingering is off; to keep the runtime
running after you log out, enable lingering once:
`loginctl enable-linger "$USER"`.

Doctor reports runtime reachability and marks the native supervisor as not
applicable on Linux. Native app installation, launchd, and the macOS menu
helper commands do not apply to Linux.

To run a development checkout beside this install, see [Dev instances](docs/dev-instances.md): a checkout runs as `OPENSCOUT_INSTANCE=dev` with its own
directories, ports (broker 24400) and `scout-dev.service`, and never touches
`scout.service`.


## Verify identity and routing

Run these commands from the project where you want to work:

```bash
scout whoami
scout who
scout runtimes
```

Then route one fresh task by capability:

```bash
scout ask --project . --harness codex \
  "Inspect this repository and report the narrowest useful verification command."
```

Use the durable handle Scout returns for follow-up. Use `scout tell` only for a
tell or status update where no reply is expected; use `scout ask` when another
agent should act, investigate, judge, or report back.

## Work from source

```bash
git clone https://github.com/openscout-app/scout.git
cd scout
bun install --frozen-lockfile

bun run --cwd packages/cli build
./packages/cli/bin/scout --version
```

The public repository must be sufficient to build and test the public Scout
core without the private Scout workspace. See the
[public-source boundary](./docs/public-source-boundary.md) for the layering and
release invariants.

## If setup is not healthy

1. Run `scout doctor` again and follow the first blocking diagnostic.
2. Run `scout doctor --fix` only when Scout offers a conservative repair.
3. Capture the Scout version, operating system, failing command, expected
   result, and sanitized output.
4. Follow [SUPPORT.md](./SUPPORT.md) for public issues or
   [SECURITY.md](./SECURITY.md) for private vulnerability reports.
