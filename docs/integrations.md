# Host Integrations

OpenScout's core broker, runtime, protocol, CLI, desktop app, and mobile app live
in this repository. Host-specific integrations can live beside this repo when
they are independently installable packages for another host's install surface.

This keeps the OpenScout root focused on the product control plane while still
making the integration surface discoverable.

## Current Integrations

| Host | Repository | Page | Purpose |
| --- | --- | --- | --- |
| T3 Orchestrator | Adapter in `packages/runtime/src/t3` | [T3 setup and contract](./t3-orchestrator.md) | Alpha adapter for T3 projects, boards, card workflows, and exact thread continuation through Scout. |
| Grok Bot (hosted) | [Grok Scout](https://github.com/arach/grok-scout) | [Grok Bot setup](https://openscout.app/grokbot) | Hosted MCP and OAuth through an online provisioned bridge. Marketplace submission pending review. |
| Muse (hosted) | Remote client in this repository | [Muse setup](https://openscout.app/muse) | Python CLI calls the hosted MCP gateway using an operator-approved OAuth grant. Requires an online Scout bridge; no Muse execution harness. |
| Grok | [Grok Scout](https://github.com/arach/grok-scout) | [Grok guide](https://openscout.app/grok) · [Full connection map](./scout-for-grok.md) | Scout launches the xAI Grok CLI over ACP (`grok-acp`; `grok` is an alias), and the Grok CLI can call `scout mcp` locally. Grok Bot, the hosted connector, is a separate row; see /grokbot. |
| Slack | `packages/slack` (private source; not in the public `oscout/scout` mirror) | [Scout for Slack](https://openscout.app/slack) | Socket Mode bridge from mentions, DMs, threads, and files into durable Scout coding work. Private preview until the package is published. |
| pi | [`arach/pi-scout`](https://github.com/arach/pi-scout) | [`arach.github.io/pi-scout`](https://arach.github.io/pi-scout/) | pi extension for Scout `send`, `ask`, `who`, and broker-backed coordination from pi sessions. |
| Claude Code | [`oscout/claude-scout`](https://github.com/oscout/claude-scout) | [`oscout.github.io/claude-scout`](https://oscout.github.io/claude-scout/) | Claude Code plugin with `/scout:*` commands and Scout channel integration. |
| Codex | [`oscout/codex-scout`](https://github.com/oscout/codex-scout) | [`oscout.github.io/codex-scout`](https://oscout.github.io/codex-scout/) | Codex plugin with Scout MCP tools and coordination guidance. |
| Cursor | [`oscout/cursor-scout`](https://github.com/oscout/cursor-scout) | [`oscout.github.io/cursor-scout`](https://oscout.github.io/cursor-scout/) | Cursor MCP configuration and installer that points Cursor at `scout mcp`. |
| Hermes Agent | [`arach/hermes-scout`](https://github.com/arach/hermes-scout) | [`github.com/arach/hermes-scout`](https://github.com/arach/hermes-scout) | Hermes plugin that bridges Scout MCP tools into Hermes sessions. |
| Herdr | [`ogulcancelik/herdr`](https://github.com/ogulcancelik/herdr) | [`herdr.dev/docs`](https://herdr.dev/docs/) | Terminal host and agent-state surface for observing and controlling supported agent panes around Scout-compatible sessions. |

## Compatibility Model

OpenClaw has an initial [local session adapter](./scout-for-openclaw.md) in
`@openscout/agent-sessions`. It is not yet a broker-selectable harness or an
OpenClaw plugin that exposes Scout tools.

Scout uses **host integration** as the umbrella term for first-class
compatibility with another agent tool, terminal host, or IDE. A host integration
can contribute one or more roles:

- execution harness: Scout can route work into a session backed by that runtime
- agent host: the tool can host a Scout-aware agent surface or plugin
- MCP host: the tool can connect to `scout mcp`
- terminal host: the tool can expose or control terminal panes that contain
  Scout-compatible sessions
- agent-state surface: the tool can report lifecycle, focus, approval, or
  session state around agents Scout cares about
- orchestrator: the tool owns a project workflow that Scout can inspect and
  address through its source projects, cards, and threads

`harness` remains the narrower runtime field. Claude Code, Codex, Cursor, Grok, and
pi can be harness-backed execution targets. Hermes and Herdr are first-class
host integrations, but they are not Scout harnesses: Hermes is an agent/MCP
host, and Herdr is a terminal host plus agent-state surface. Do not add
`hermes` or `herdr` to `--harness` or `execution.harness` unless an explicit
execution adapter is implemented.

T3 Orchestrator is an orchestrator host. Its configured thread provider
identifies the execution backend. The [T3 adapter](./t3-orchestrator.md) keeps
source board state, workflow stages, and human acceptance as separate work
context without adding a T3 harness value.

## Shared Routing Guidance For Integrations

Every host integration should teach the same low-churn workflow:

1. **Capability request:** pass project directory plus optional harness/capability
   (`projectPath` + `harness`, or `scout ask --project <path> --harness <rt>`).
2. **Broker dispatch:** let Scout choose/wake/create a compatible worker instead
   of asking the user or agent to guess names such as `claude.main`.
3. **Durable handle:** display the returned `ref`, `flightId`, `conversationId`,
   `workId`, session id, and any broker-suggested situated target handle.
4. **Follow-up:** continue by that handle. Humans type saved situated targets as
   `target:<name>`; agents and compact UI may render the same handle as
   `⌖name`.
5. **Promotion:** name or pin a long-lived sibling only after the routed worker is
   known good, preferably using the broker-suggested mnemonic.

Integrations should expose `projectPath` and `harness` in their ask surfaces
where the host allows it. `who`/resolve/search remain useful for inspecting or
disambiguating a specific target, but they are not a required preflight for
project-routed work.

## Hosted Assistants Using The Remote Client

The single-file client at `landing/openscout.app/public/remote/scout` is for
assistants with a Python 3.8+ shell in a cloud VM. Install it using the
[remote installer](https://openscout.app/remote/install.sh). A host with native
remote MCP OAuth support can use the gateway directly; a host with a secret
broker can use the separate static-token path. Verify the host's actual
transport before choosing a guide.

The CLI uses the existing MCP authorization server: `scout login --as muse`
registers the client and prints an approval link. The operator chooses the
Scout agent identity on the consent page and returns its one-time `code#state`
value. `scout login --code <code>` checks state and exchanges the code with the
PKCE verifier retained in the VM. `--as` names the client; the consent page is
authoritative for the identity. Access credentials renew through the saved
refresh token. Keep credentials and the verifier out of chat and logs.

Verify `scout whoami` against the chosen identity before `scout who` and a
small authorized ask. Keep the receipt's flight id for `scout wait` or
`scout status`. Follow-up work must use the exact returned session through
the advertised `ask` schema (`scout call ask` supports JSON arguments); do not
assume a fresh ask to the same agent retains the previous conversation.
For an exact-session continuation, omit `projectPath` and `to`; use
`targetSessionId` alone as the target. `currentDirectory` is optional caller
context, not a second routing target.

`SCOUT_TOKEN` overrides saved credentials. Unset it before starting another
login, otherwise subsequent commands would keep using the environment's
identity. A successful `login --with-token` replaces the locally saved OAuth
sign-in and pending login; a rejected token preserves them. Local `logout`
removes saved credentials, but does not revoke a server grant or unset
`SCOUT_TOKEN`. Static-token administration and OAuth grant revocation are
different mechanisms; do not present `mesh bridge token revoke` as OAuth
grant revocation.

Connection failures are not evidence that a machine is offline. The client
retries only MCP initialization, at most three attempts, with fresh session
headers. A dropped or truncated tool response is ambiguous: the tool may
already have executed. Inspect any existing receipt before taking another
action. A `node_unreachable` response specifically indicates that the gateway
cannot reach the Scout bridge; inspect that bridge on the Scout machine.

An accepted ask, completed reply, and automatic incoming delivery are separate
acceptance gates. A CLI response proves no ability to wake an idle hosted
assistant. Do not install prompt-managed mailbox loops as onboarding. The
host must support delivery into its conversation before automatic incoming
messages can be promised.

Client regression checks: `python3 -m unittest discover -s scripts -p
test_remote_scout.py`. These use synthetic credentials and local transport
fixtures; they do not establish live Muse connectivity.

## Relationship To This Repo

Use links and install docs rather than git submodules by default.

Submodules are useful when this repo must build, test, or vendor another
repository at an exact commit. The current Scout host integrations do not need
that coupling: they shell out to the installed `scout` CLI or talk to the local
broker, and their compatibility boundary is the published Scout protocol and CLI
behavior.

Keep integration source in a separate repository when:

- the host has its own plugin marketplace or install flow
- the integration can be installed without cloning OpenScout
- the package should have its own release cadence
- the integration depends on Scout's public CLI/protocol surface rather than
  private app internals

Keep integration source in this repository when:

- it depends on unreleased internal code
- it is still shaping the core protocol or broker API
- local product development needs cross-package changes in one commit

## Local Development

Recommended sibling checkout layout:

```plaintext
~/dev/
├── openscout/
├── pi-scout/
├── claude-scout/
├── codex-scout/
├── cursor-scout/
├── hermes-scout/
└── herdr/
```

That layout keeps the product repo clean while making related host integrations
easy to work on side by side.

## Personal connection addresses

For owner-directed hosted-assistant onboarding, use a published
`https://oscout.net/{user}` profile. The assistant requests access, displays a
matching code, and privately completes login after the owner approves the same
code in their inbox. See [Personal Scout profiles](scout-profiles.md) for visibility
controls, the remote client command, notification limits, and rollout requirements.
