# Runtime Sessions Agent Notes

Source: `docs/runtime-sessions.md`, `packages/runtime/**`, `@openscout/agent-sessions`.

Status: harness lifecycle semantics. Broker routing uses these nouns.

Verified: 2026-09-02

## Role

Runtime starts, attaches, wakes, inspects, and health-checks **harness sessions**. Broker routes work to **endpoints** that reference those sessions. Runtime does not replace broker record ownership.

## Model

| Noun | Meaning |
|---|---|
| `agent` | durable domain identity, e.g. `hudson.main.air-local` |
| `session` | opaque `sess.*` handle resolving to one harness context |
| `endpoint` | broker row: agent + harness + transport + session + node + state |
| `card` | identity + return address; not implicitly live |
| `harness` | execution backend: `codex`, `claude`, `cursor`, … |
| `transport` | wire to harness: `app-server`, `stream-json`, tmux, ACP, … |
| `adapter` | runtime module mapping harness events → observed events |

Public noun is always **session**. Map provider `threadId` into session metadata.

## Relations

```plaintext
agent 1—* session mappings (over lifetime)
agent 1—* endpoints (per harness/worktree/node)
endpoint *—1 session (when attached)
card → agent identity metadata (may have zero live sessions)
scout up / session start → runtime creates or attaches context → broker mints session handle + registers endpoint
```

## Lifecycle Commands

| Intent | CLI | Notes |
|---|---|---|
| prewarm / start | `scout up <agent>` | alias for session start path |
| explicit start | `scout session start --agent X --harness Y` | creates compatible session |
| intake existing | `scout session intake --harness Y --session <id> --backend tmux\|zellij` | materializes a disposable local terminal surface |
| attach existing | `scout session attach --agent X --harness Y --session <id>` | |
| inspect | `scout session inspect --agent X --harness Y` | |
| stop | `scout down <agent>` | detach/stop local session |

## Routing Interaction

| Target form | Session behavior |
|---|---|
| `--to <label>` / `--to <agentId>` | fresh session for new ask work |
| `--to target:<handle>` | resolve a saved situated Scout target for convenient follow-up |
| `--to session:sess.<token>` | canonical continuation of one exact harness context |
| `--to session:<harness>:<native-id>` | legacy compatibility lookup; resolve to a `sess.*` handle before receipt |
| agent-target route alias | dereference once, then retain fresh agent/card semantics |
| session-target route alias | dereference once and continue only the pinned exact session; expire at terminal/GC |
| `--project <path> --harness <rt>` | broker/runtime pick or create concrete worker+session for project/capability |
| `scout card create` | mint identity; does not start session unless commanded |

Mismatch example: Codex-targeted ask + only Claude endpoint attached → `harness_mismatch` diagnostic, not silent routing.

Fresh capability work should be project-routed first. The runtime returns durable
follow-up handles (`ref`, flight, conversation, work, session) and may return a
situated target handle. Humans type saved situated targets as `target:<handle>`;
agents and compact UI may render the same target as `⌖handle`. Exact session
routing is only for exact continuity; card/name promotion happens after the worker
is known good.

Session handles never encode agent, profile, project, harness, model, branch, or
node. Native harness ids are aliases in the resolver. Creating or observing a
session must not create an agent/actor/directory entry.

Fresh runtime-created Claude project sessions use `tmux` by default so operators
can inspect and attach to the live terminal. `claude_stream_json` remains a
supported explicit transport for configured agents and recovery paths; it is
not the default for a new cardless Claude task. Set
`OPENSCOUT_CLAUDE_CARDLESS_TRANSPORT=claude_stream_json` to intentionally use
the backup transport for newly spawned cardless Claude sessions. The
declarative source of truth is the selected harness catalog entry's
`sessionDefaults` (`defaultHarness`, `defaultTransport`, and
`fallbackTransports`); broker spawning consumes that metadata rather than
maintaining its own harness switch.

## Endpoint States

| State | Meaning |
|---|---|
| `registered` | metadata only |
| `attaching` | binding to existing session |
| `waking` | start/resume in progress |
| `idle` | reachable, ready |
| `working` | active flight/work claimed |
| `unreachable` | known but not contactable |
| `failed` | wake/attach failed (reason recorded) |
| `superseded` | replaced row; diagnostics only |
| `stopped` | intentional detach |

Happy path: `registered → waking → idle ↔ working → idle`.

## Session Persistence

| Flag | Meaning |
|---|---|
| `resumable` | provider says reattach possible |
| `reachability_unknown` | metadata exists; liveness unconfirmed after restart |
| `not_attachable` | reference invalid/incompatible |
| `terminal` | harness reported closed/stopped |

After broker restart: assume `reachability_unknown` until proven.

Runtime-created cardless sessions are disposable. The runtime checks them every
five minutes and stops an `idle` local session after 24 hours without endpoint,
flight, work-item, or question activity. Sessions with a nonterminal flight,
open owned work/question, or a non-idle endpoint state are never TTL candidates.
Set `OPENSCOUT_CARDLESS_SESSION_IDLE_TTL_MS` or
`OPENSCOUT_CARDLESS_SESSION_SWEEP_INTERVAL_MS` to tune the policy; setting the
sweep interval to `0` disables the runtime sweep for debugging.

## Adapter Registry (pairing/runtime)

Built-in Pairing adapter keys include: `claude-code`, `codex`, `acp`,
`antigravity-acp`, `grok-acp`, `kimi-acp`, `pi`, `opencode`, `opencode-v2`, `opencode-acp`, and
`openai`. `opencode` preserves the legacy V1 server contract; `opencode-v2`
uses the breaking product-V2 shared-service API. Runtime-created OpenCode work
continues to default to `opencode_acp`; V2 server use is explicit until its
beta contract and routing policy are promoted separately.

Google Antigravity uses the native `agy acp --stdio` server. Install Google's
CLI, sign in with `agy acp --login`, and run `agy models` to list the IDs your
account can use. To give Antigravity access to Scout tools, run
`scout mcp install --host antigravity`. To send work in the other direction:

```sh
scout ask --project . --runtime antigravity/gemini-4-neon/high "Review this change"
```

MCP `ask` takes the same literal in `runtime`. Bare `antigravity` keeps the
native defaults. Use `--profile antigravity` for a fresh session, or pass
`--harness antigravity --model <family> --effort <level>` for separate
dimensions. `agy` and `antigravity-acp` both select the `antigravity`
harness. Scout passes the project directory as ACP `cwd`, then sets and
checks `model` and `thought_level` before sending the prompt. Available
levels depend on the model and account; a rejected level fails the ask
instead of running with a different effort. [Google's ACP guide](https://antigravity.google/docs/ide/extensions/acp)

Kimi Code is a first-class cardless harness target: `--harness kimi` resolves
through the catalog to the `kimi_acp` transport, which launches `kimi acp` and
reuses the CLI's cached `kimi login` authentication state.

Permission posture: runtime-owned Kimi ACP invocations have no approval
consumer, so their invocation wrapper explicitly selects Kimi's one-shot allow
option for tool permission requests. The generic ACP adapter remains
interactive by default; an absent allow option is cancelled rather than
invented.

Kimi's harness-owned session history is observed separately by
`packages/runtime/src/tail/kimi-source.ts`; the ACP adapter does not import those
wire logs into Scout session records.

Managed-process direction (SCO-056): ACP stdio and similar executables map into same session/endpoint model via adapter boundary.

## Observed vs Owned

Runtime tails harness output → **observed events** (SCO-042). Those feed UI/status; they do not become broker `message` rows unless sent through Scout comms APIs.

## Invariants

1. Session is harness-specific; no cross-harness satisfy without explicit adapter.
2. Card create ≠ running session.
3. Broker receipt ≠ harness completion.
4. Endpoint attachment health ≠ flight lifecycle.
5. Wake/register on first deliver for known on-demand targets — do not require manual `scout up` before first message unless broker says so.
6. Failures return layer + remediation command, not silent limbo.

## Forbidden

- Introduce user-facing `thread` noun parallel to `session`.
- Bind Codex ask to Claude session silently.
- Treat pairing bridge session as broker endpoint without registration.
- Require orientation loop (`who`/`whoami`/`latest`) when broker already returned actionable dispatch.

## Code Map

| Concern | Path |
|---|---|
| Broker session routing | `packages/runtime` broker layer |
| Harness adapters | `@openscout/agent-sessions` |
| Pairing bridge sessions | `**/pairing/runtime/bridge/**` |
| CLI session commands | `packages/cli`, `packages/cli/src/cli` |

## Verification

```bash
scout who --json
scout session inspect --agent <id> --harness codex
scout ask --to <agent> "ping"
```

Expect: receipt ids; endpoint state progresses `waking → idle` when harness available.
