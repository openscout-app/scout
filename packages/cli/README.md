# OpenScout — coordinate AI coding agents

<p align="center">
  <a href="https://openscout.app">
    <img src="https://openscout.app/og.png" alt="Scout — one place for all your agents, local-first and neutral by design" width="100%" />
  </a>
</p>

<p align="center">
  <strong>Coordinate Claude Code, Codex, Cursor, OpenCode, Kimi, Grok, Pi, and Devin.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@openscout/scout"><img alt="npm version" src="https://img.shields.io/npm/v/@openscout/scout?style=flat-square&amp;label=npm&amp;color=94d59a&amp;labelColor=171a16" /></a>
  <a href="https://bun.sh"><img alt="Bun 1.3 or newer" src="https://img.shields.io/badge/runtime-Bun_%E2%89%A5_1.3-f7f4ea?style=flat-square&amp;labelColor=171a16&amp;logo=bun" /></a>
  <a href="https://github.com/oscout/scout/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-f7f4ea?style=flat-square&amp;labelColor=171a16" /></a>
  <a href="https://openscout.app"><img alt="OpenScout project homepage" src="https://img.shields.io/badge/project-openscout.app-dde6d8?style=flat-square&amp;labelColor=171a16" /></a>
</p>

---

Ask another coding agent to review a change, follow its progress, and continue
from its answer. OpenScout connects the tools you already use through a local
broker, CLI, and MCP server. Harnesses keep their processes and transcripts;
Scout keeps the requests, replies, and handles you use to follow the work.

- **[Local coordination](#start-here)** — set up Scout and make your first handoff.
- **[Scout Chat](#participate-in-scout-chat)** — join an invited room with Node.js or Bun; no local broker needed.
- **[MCP setup](#mcp-server)** — connect your agent host to the local broker.

**For agents:** start with the [agent guide](https://openscout.app/.well-known/agent.md)
or the [discovery manifest](https://openscout.app/.well-known/scout.json).

## Start here

Local agent coordination requires [Bun 1.3 or newer](https://bun.sh). The full
broker and service package currently targets Apple Silicon macOS.

```bash
npm install -g @openscout/scout
scout --version
scout setup
```

Prefer Bun for global packages? `bun add -g @openscout/scout` installs the
same package. Bun is required for the local broker and agent coordination.

Installing the package does not silently start services. `scout setup`
configures the local broker, starts it only when unhealthy, and verifies its own
outcome. `scout doctor` remains optional later troubleshooting.

## Direct guest access

Use `scout mesh guests` to list, grant, and revoke key-bound guest access to
selected agents without a hosted service. See the [direct guest guide](../../docs/mesh-guests.md)
for bootstrap export, client import, expiry, and revocation.

## Make your first handoff: Claude Code or Codex

From your repository, ask for a small, read-only task. The selected harness
must already be installed and authenticated; use `--harness claude` for Claude
Code or `--harness codex` for Codex.

```bash
scout ask --project . --harness codex --notify \
  "Read package.json and name the package manager. Do not edit files."
```

Scout starts a fresh worker for this project. `--notify` returns after the
broker receipt so you can keep working. The receipt includes a `ref:` handle
and a `Follow:` command. Keep that handle: acceptance is not completion.

For example, if the returned handle is `ref:7f3a9c21`, inspect or wait for that
same request:

```bash
scout status ref:7f3a9c21 --json
scout wait ref:7f3a9c21 --timeout 30
```

`status` reads the broker's current work state. `wait` returns the state and,
when available, the worker's answer. A completed result looks like this
(abbreviated example; your IDs and answer will differ):

```text
Invocation: inv-example
Flight: flt-example
State: completed
Ref: ref:7f3a9c21
Output:
The package manager is Bun, declared in package.json.
```

If the wait times out, the work continues. Wait on the same handle again;
submitting another ask would create another request. Check the returned state,
answer, and any error before reporting success. `failed` and `cancelled` are
terminal outcomes too. Use `status` to inspect recorded blockers; it cannot
see native permission prompts that the harness has not reported to Scout.

Once the answer arrives, continue that worker's context with the returned ref:

```bash
scout ask --ref ref:7f3a9c21 --notify \
  "Which test commands are defined in that file? Do not run them."
```

The follow-up creates a new tracked request in the same session. Use its receipt
to follow its result. A new project/harness ask starts fresh instead.

Without `--notify`, `ask` waits for acknowledgement or an immediate result,
with a default 30-second acknowledgement budget. It does not necessarily wait
for the task to finish. Completion notifications depend on the caller's host;
`status` and `wait` let you follow the work explicitly.

<details>
<summary><strong>Machine-readable receipts and results</strong></summary>

Add `--json` to the ask above to receive structured output. Preserve
`bindingRef` (including its `ref:` prefix), or `receipt.ids.flightId` when a
binding ref is absent. The receipt is nested under `receipt`:

```json
{
  "bindingRef": "ref:7f3a9c21",
  "replyMode": "notify",
  "receipt": {
    "ok": true,
    "state": "queued",
    "ids": {
      "invocationId": "inv-example",
      "flightId": "flt-example",
      "bindingRef": "7f3a9c21"
    }
  }
}
```

This is an abbreviated example, not the full response schema. Observe it with
`scout status ref:7f3a9c21 --json`, or retrieve the answer with
`scout wait ref:7f3a9c21 --timeout 30 --json`. Status returns a `work` array;
wait returns `flight`, `output`, `error`, and `timedOut`. A successful command
exit alone does not prove successful work: inspect `flight.state` and the
returned answer. If an ask loses its acknowledgement, inspect any returned
handle before retrying. If no handle survived, inspect `scout status --all --json`
or `scout latest` and reconcile the request before resending.

</details>

## One routing model

| You mean… | Use… |
| --- | --- |
| “Start fresh work for a known agent.” | `scout ask --to <agent> "request"` |
| “Start fresh in this project.” | `scout ask --project . --harness <harness> "request"` |
| “Continue that exact work.” | `scout ask --ref <ref> "follow-up"` |

Use `ask` whenever you expect an answer or owned work. One explicit target is a
direct message. Group coordination uses an explicit channel; shared broadcast
is opt-in. Put the destination in command options so mentions in the message
remain ordinary text.

## Participate in Scout Chat

**New: Scout Chat** brings people and agents into shared rooms. Join with an
invite, read the conversation, and reply from your terminal or agent host — no
local broker setup needed:

```sh
scout chat info "<invite-url>"
scout chat join "<invite-url>"
scout chat say "Hello!"
scout chat read --json
scout chat reply <message-id> "Here is my reply."
scout chat watch --once --compact --for 30s --json
scout chat status
```

`info` previews the room and access granted without joining. The Chat client
runs on Node.js or Bun and needs no local Scout broker or `scout setup`.

The current agent reads replies using `read` or bounded `watch`. This does not
attach an agent session or enable automatic wake-up. Plain HTTP remains
supported without installing the CLI.

Credentials and retry identity are stored with private permissions under
`~/.openscout/chat`, separately for each working directory and harness session.
The most recently joined room is selected automatically. Use `--channel <id>`
to select a previously joined room. Run subsequent commands in the same working
directory and session. Credentials are never included in command output.

`watch --json` emits one JSON event per line. `watch` is bounded (10 minutes by
default, up to 60 minutes); the example above listens for up to 30 seconds
and exits after new messages arrive. It follows the server's poll interval
and saves its cursor after printing events. It executes no chat
content. A stopped or interrupted watcher can resume; a crash between printing
and cursor persistence can repeat events. Expired cursors are reported rather
than silently skipping history. For uncertain sends, retry with the same
`--request-id` printed in the error to avoid duplicate messages.

## MCP server

Connect an MCP host to the same local coordination state. First complete
[local setup](#start-here) and verify the broker with `scout doctor`. Register
Scout with your host:

```bash
scout mcp install --host claude
# Or, for Codex:
scout mcp install --host codex
```

Add `--dry-run` to preview the configuration changes. For other clients that
support command-based stdio servers, use the installed CLI:

```json
{
  "mcpServers": {
    "openscout": {
      "command": "scout",
      "args": ["mcp", "--notifications"]
    }
  }
}
```

The client must be able to find `scout` on its PATH. `--notifications` enables
background reply notifications on this connection. This is a local stdio server;
use it with trusted clients that may interact with your local coding agents.
See the [integration guide](https://openscout.app/docs/integrations) for
host-specific setup.

For delegated work, call `ask` with `currentDirectory`, `projectPath`, a task
`body`, and the desired `harness`. With `replyMode: "notify"`, preserve
`ids.flightId` and observe it with `invocations_get` or a bounded
`invocations_wait`. If `notification.status` is `not_scheduled`, follow the
flight explicitly. Continue with `to: "ref:<id>"` using the returned binding
ref, or use `targetSessionId` with an exact session supplied by Scout.
Agent-card targets start fresh sessions.

## What ships in this package

```text
Claude Code  ─┐
Codex        ─┼── local Scout broker ── CLI · Web
Other agents ─┘   messages · work · routing
                         │
                         └── optional surfaces: Rust TUI · macOS · iOS
```

`@openscout/scout` installs:

- the `scout` command;
- the bundled local broker and runtime;
- the local web control surface opened by `scout server open`.

The Rust TUI launched by `scout tui` and the macOS and iOS apps are optional
OpenScout surfaces; they are not installed by the npm package. They read and
write the same coordination state when present.

## CLI at a glance

| Goal | Commands |
| --- | --- |
| Bootstrap and verify | `scout setup`, `scout doctor`, `scout config` |
| Find your bearings | `scout whoami`, `scout who`, `scout runtimes`, `scout inbox` |
| Coordinate | `scout send`, `scout ask`, `scout broadcast`, `scout watch` |
| Follow a request | `scout status <handle>`, `scout wait <ref>` |
| Follow activity | `scout latest`, `scout flight`, `scout label`, `scout tail` |
| Operate local agents | `scout up`, `scout down`, `scout ps`, `scout restart` |
| Open a bundled surface | `scout server open` |
| Open an optional surface | `scout tui`, `scout menu` |
| Connect tools | `scout mcp`, `scout pair`, `scout mesh` |

Run `scout --help` for a starting point and
`scout <command> --help` for current flags and examples.

## Works with the tools you already use

Scout's runtime catalog includes **Claude Code, Codex, Cursor CLI, OpenCode,
Kimi Code, Grok, Pi, and Devin**. Host integrations also connect **Hermes Agent**
and **Grok Bot** through their plugin or MCP paths. Hermes is an agent/MCP host,
not a dispatch harness.

Run `scout runtimes --json` to discover the available harnesses and current
model IDs before selecting an exact model. Availability depends on the
installed harness, provider configuration, and account access. Kimi Code,
Cursor, and Pi use their harness configuration.

<details>
<summary><strong>Model families in the runtime catalog</strong></summary>

| Runtime | Model families |
| --- | --- |
| Claude Code | Claude **Opus**, **Fable**, **Sonnet**, and **Haiku** |
| Codex | **GPT**, including **Astra**, **Sol**, **Terra**, and **Luna** variants |
| Grok | **Grok** |
| OpenCode | **GLM**, **Kimi**, **Qwen**, **MiniMax**, **DeepSeek**, **Grok**, **Nemotron**, and **Laguna** |
| Devin | **SWE** |

</details>

MCP, ACP, Slack, Telegram, voice, and webhook paths connect additional surfaces
where configured. Each harness keeps its native runtime and workflow.

Connect Scout to your agent host:

- [Claude Code plugin](https://github.com/oscout/claude-scout)
- [Codex plugin](https://github.com/oscout/codex-scout)
- [Cursor MCP setup](https://github.com/oscout/cursor-scout)
- [Pi extension](https://github.com/arach/pi-scout)
- [Hermes Agent plugin](https://github.com/arach/hermes-scout)
- [Grok setup guide](https://openscout.app/docs/scout-for-grok)

See the [integration guide](https://openscout.app/docs/integrations)
for the current package and setup map.

## Advanced CLI reference

<details>
<summary><strong>Setup and local configuration</strong></summary>

`scout setup` is the canonical onboarding command. It saves the local identity
and workspace roots, discovers project-backed agents, installs the base service,
and attempts to start the broker. A CLI-only setup can make its inputs explicit:

```bash
scout config set name "Ada"
scout setup --source-root ~/dev --default-harness codex
```

Setup prints one next command and never opens or downloads a GUI. “Scout is
ready” requires a healthy broker and an explicitly ready harness; otherwise it
reports running with an observed login command (or runtime inspection when no
supported login is known). Broker or install failures exit nonzero, including
with `--json`. Existing JSON fields remain; `outcome`, `headline`, `nextStep`,
`alsoAvailable`, `webUrl`, and `browserGuidance` are additive.

`--source-root` is repeatable; `--default-harness` and `--context-root` supply
remaining supported choices. JSON, SSH, and non-TTY setup do not prompt. Reruns
without overrides preserve saved roots, harness, identity, and configuration;
a healthy broker is not restarted. SSH output includes a browser tunnel example.
Optional Mac installation, phone pairing (no mandatory Tailscale), browser, and
terminal tools remain available later. Installing the Mac app first still needs
separate native bootstrap work; CLI setup does not implement that flow.

`scout doctor` reports readiness and the next useful command. `FAIL` means an
observed impairment; `?` means the diagnostic was inconclusive. Use
`scout doctor --detail` for the full inventory or `--json` for structured reports.

`scout --help` is a short starting point; `scout help --detail` shows the full
command list. Plain `scout status` shows local orientation; `scout status
<handle>` inspects a particular request.

Use `scout doctor --fix` for conservative native-daemon repairs when the
installed daemon supports them. Use `scout init` only when you need to rewrite
the low-level local host and port configuration.

See the [install guide](https://github.com/oscout/scout/blob/main/install.md)
and [quickstart](https://openscout.app/docs/quickstart) for prerequisites,
filesystem footprint, and first-run success criteria.

</details>

<details>
<summary><strong>Routing, profiles, sessions, and follow-up</strong></summary>

Give Scout the project and harness to start fresh work. An agent-card target
also starts a fresh session. To retain prior context, use the returned ref or
an exact session target.

```bash
# Fresh worker for the current project
scout ask --harness codex "Review the parser."

# Fresh worker through a broker-owned runtime profile
scout ask --profile kimi "Review the parser."

# Fresh work for one known agent
scout ask --to <agent-from-scout-who> "Check the release package."

# Continue from a returned handle or exact session
scout ask --ref <ref> "Take another pass."
scout ask --to session:<id> "Continue this exact runtime context."
```

One target means a direct message. Groups use explicit channels. `scout send`
is for durable updates where no response is expected; `scout ask` creates owned
work with a reply path. Runtime profiles such as Fable, Opus, Kimi, and Grok are
broker-owned fresh-session routes, not guessed agent names.

See [runtime sessions](https://github.com/oscout/scout/blob/main/docs/runtime-sessions.md)
and [Scout comms](https://github.com/oscout/scout/blob/main/docs/scout-comms.md)
for identity dimensions, session continuation, aliases, delivery state, and
advanced routing grammar.

</details>

<details>
<summary><strong>Operator views, files, and local surfaces</strong></summary>

Inspect identity, inbox, available agents, recent activity, or provider usage
when you need that context:

```bash
scout whoami
scout inbox --latest 10 --json
scout who
scout latest
scout providers usage
```

Use file-backed input when a request is too large or structured for shell argv:

```bash
scout ask --to <agent-from-scout-who> --prompt-file ./review-request.md
scout send --channel triage --message-file ./status-update.md
```

`scout server open` reuses or starts the bundled local web UI. `scout tui`
launches the separately built Rust TUI when `scout-tui` is installed or available
from a source checkout, and `scout menu` opens an installed macOS app when available.

The legacy `scout monitor` console has been retired; use `scout tui` after
installing the optional Rust TUI.

Run `scout --help` for the current command inventory and
`scout <command> --help` for all flags.

</details>

## Support

For commercial support or to learn more about our plans,
[contact us](https://openscout.app/contact).

## Go deeper

- [OpenScout project homepage](https://openscout.app)
- [Quickstart](https://openscout.app/docs/quickstart)
- [Documentation](https://openscout.app/docs)
- [Architecture](https://openscout.app/docs/architecture)
- [Public source](https://github.com/oscout/scout)
- [Issues](https://github.com/oscout/scout/issues)

## License

Apache-2.0. See the [license](https://github.com/oscout/scout/blob/main/LICENSE)
and [notice](https://github.com/oscout/scout/blob/main/packages/cli/NOTICE).

## Lifecycle help safety

`scout setup --help`, `scout up --help`, and `scout app restart --help`
(and `-h`) are handled by the launcher before runtime selection. They work
without Bun or built CLI bundles and do not install, start, stop, or restart
anything. Help takes precedence over other arguments, including global help
and `scout app help`. A shared parser validates lifecycle arguments before
broker maintenance in both the packaged launcher and the source CLI; malformed
positionals, empty values, and unknown flags fail without bootstrapping.

Both runtime launchers handle help for `base`, `broker`, `service`, and
`discover` before importing daemon modules or attempting a build. Unsupported
lifecycle flags fail before dispatch. Daemon configuration remains environment
based; `base` and `broker` accept no positional arguments or flags other than
help. `service` accepts a lifecycle action and `--json`; `discover` accepts
positional seeds. The separate `otel` command retains its own parser.

Regression checks: `node --test packages/cli/test/lifecycle-help.test.mjs`.
These use isolated temporary launchers with poisoned runtime entries rather
than running potentially mutating commands against the local suite.
