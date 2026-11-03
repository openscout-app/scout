# Scout Agent Context

Verified: 2026-07-21

Purpose: dense context for coding agents working in this repo.

## Repository routing

This is the public Scout workspace. Public changes and pull requests belong in
`openscout-app/scout`; private Scout product work stays in the private workspace.
Read [CONTRIBUTING.md](../../CONTRIBUTING.md#repository-routing) for checkout,
fork, and working-directory checks before making changes.

## Identity

| Field | Value |
|---|---|
| Product | Scout |
| Current status | v0.x active product codebase |
| Trust posture | high-trust local developer environments |
| Not ready for | enterprise, compliance, untrusted multi-tenant runtime |
| CLI | `scout` |
| Runtime | Bun |
| Primary state owner | local runtime |
| Protocol package | `@openscout/protocol` |

The core has no web app. The Mac, iOS, Android, and web apps are separate
clients. Host-side pairing is `@openscout/pairing` in `packages/pairing`. It is
an internal workspace package bundled into the CLI, not a separate npm install.

## Main Paths

| Area | Path |
|---|---|
| Broker/runtime | `packages/runtime` |
| Shared protocol | `packages/protocol` |
| Public CLI package | `packages/cli` |
| Docs | `docs` |

## Semantic Specs (dense)

Start at [`INDEX.agent.md`](./INDEX.agent.md) for subsystem specs written for agents/programs.

| Subsystem | Spec |
|---|---|
| Index / read order | `docs/agent/INDEX.agent.md` |
| Broker records + routing | `docs/agent/broker.agent.md` |
| Comms workflows | `docs/agent/scout-comms.agent.md` |
| Harness sessions | `docs/agent/runtime-sessions.agent.md` |
| Pairing / mobile bridge | `docs/agent/pairing-runtime.agent.md` |
| scoutd / local services | `docs/agent/scoutd.agent.md` |
| Instances (dev vs prod isolation) | `docs/agent/instances.agent.md` |

## Must-Read Docs

| Need | Doc |
|---|---|
| GitHub first scan | `README.md`, `docs/README.md` |
| install/bootstrap | `install.md` |
| first run | `docs/quickstart.md` |
| architecture | `docs/architecture.md` |
| license | `LICENSE`, `NOTICE` |
| runtime/session semantics (prose) | `docs/runtime-sessions.md` |
| data boundary | `docs/architecture.md#the-data-model` |
| agent integration | `docs/agent-integration-contract.md` |
| host integrations | `docs/integrations.md` |
| external client comms (prose) | `docs/scout-comms.md` |
| identity grammar | `docs/architecture.md#agent-identity-and-addressing` |
| collaboration model | `docs/agents-and-collaboration.md` |
| operator attention | `docs/operator-attention-and-unblock.md` |
| glossary | `docs/concepts.md` |

## Core Records

| Record | Meaning |
|---|---|
| `message` | durable conversation record |
| `session` | opaque broker `sess.*` handle resolving to a harness context and endpoint |
| `invocation` | explicit request for work |
| `flight` | execution lifecycle for an invocation |
| `delivery` | planned transport-specific fan-out |
| `usage` | lightweight token/cost metadata linked to Scout records |
| `binding` | external thread/channel mapping |
| `question` | lightweight information-seeking collaboration record |
| `work_item` | durable owned execution record |
| `role_assignment` | explicit duty granted to an agent at mission, agent, or project scope |
| `mission_log_entry` | cheap structured mission situation entry; not chat or a transcript |

For routing and surface nouns not listed above—situated target, capability
request, runtime profile, terminal backend, pairing versus mesh, operator
attention, and scoutd—see [`docs/concepts.md`](../concepts.md).

## First-Run Ladder

| Step | Command | Not Ready Means |
|---|---|---|
| CLI installed | `scout --help` | install published CLI or build/link `packages/cli` |
| machine bootstrap | `scout setup` | fix printed prerequisite or local permission issue |
| broker health | `scout doctor` | broker/service is not ready for routing |
| sender identity | `scout whoami` | wrong cwd or project metadata; rerun setup from target project |
| target discovery | `scout who` | use only when you need a specific existing target |
| **past harness session text** | **`scout search`** (explicit `index` then `query`) | prefer over grepping `~/.codex` / `~/.claude` / `~/.kimi-code`; see `docs/session-search.md` |
| runtime discovery | `scout runtimes --json` | inspect legal harness/model/effort tuples before requiring exact execution |
| first project ask | `scout ask --project /path/to/repo --runtime codex/gpt-5.6-sol/xhigh "review this"` | broker should create an isolated exact-runtime worker and return handles plus execution resolution |
| first specific ask | `scout ask --to <agent-from-scout-who> "Review the changes and report back."` | use a fuller selector if the short name is ambiguous |

Do not use placeholder names like `agent` or generic guesses like `claude.main`
as literal targets. For fresh capability work, pass `projectPath` / `--project`
and optional `harness` / `--harness`; for continuity, use the returned `ref`,
flight, conversation, work, session handle, or a saved situated target such as
`target:mw-talkie`. Agent prompts and compact UI may render that same target as
`⌖mw-talkie`. Copy a selector from `scout who` only when you mean one specific
known target.

## Non-Negotiable Rules

- Clients and adapters submit commands to the runtime; they do not write Scout-owned coordination records directly.
- Do not make external harness transcripts canonical Scout messages.
- Assigned roles are explicit duties, never `agentClass`, harness, or identity.
  The first built-in role is orchestrator. No applicable active role assignment
  with `mission_log.append` means no mission-log entry.
- A role assignment survives process death because it belongs to the durable
  agent/scope; sessions are disposable. Prefer a fresh session plus re-steer to
  the durable agent/mission; use `session:<id>` only for exact harness-context
  continuation.
- Use explicit target metadata; message body is payload, not routing.
- One target means DM; group coordination means explicit channel; shared
  broadcast is opt-in.
- Harness/session mismatches must fail with actionable diagnostics, not silent hangs.
- Exact runtime grammar is `<harness>[/<model>[/<effort>]]`; sparse tuples use
  `--harness`, `--model`, and `--effort`. Profiles are base presets and legal
  explicit values override them.
- Exact runtime asks create isolated sessions. Exact `session:<id>` asks fail
  unless observed harness/model/effort match every requested dimension.
- Verify `executionResolution` on the invocation: requested and resolved show
  launch intent and provenance; observed and drift show harness-owned truth.
- Runtime/profile/route/effort grammar words are reserved agent names. Stored
  historical offenders fail targeted setup or broker startup with
  `reserved_name_existing`; fleet discovery quarantines invalid siblings so
  healthy projects remain available. Rename the project or registry identity
  explicitly before retrying.
- If blocked, record who or what owns the next move.
- Mesh means reachability, not distributed consistency guarantees.
- Do not claim enterprise readiness.
- Session/card targeting (fresh vs `session:<id>` continue), `ask`/`reply`
  semantics, project-routed asks, and reply-path rules: see
  `runtime-sessions.agent.md` and `scout-comms.agent.md`.
- Usage/cost tracking, broker-side coaching, reply modes, and stuck host
  permission prompts: see `scout-comms.agent.md`, `broker.agent.md`, and
  `integration-contract.agent.md`.
- Capability-first routing: project + harness first, returned handle for
  follow-up, broker-suggested/pinned name only after the worker is known good.
- Spec-backed handoffs should reference the durable spec or prompt file instead
  of pasting its full text into the Scout message. Keep the file as the source
  of truth for traceability; see `docs/agent/scout-comms.agent.md`.
- Assigned roles and mission logs: read the **Assigned Roles And The Mission
  Log** section in `docs/agents-and-collaboration.md`. The runtime terminal-flight
  lifecycle can emit `post_ask_summary` for an assigned requester or target when
  a work/mission id is available; MCP role/log tools and soft prompt-injection
  wiring are not landed yet.

## Dev Instances

A checkout is not the installed Scout. Running from source (`bun run dev`,
`bun packages/runtime/src/broker-daemon.ts`, the pairing controller) defaults
to `OPENSCOUT_INSTANCE=dev` (main checkout) or `dev-<folder>` (linked
worktree): own root `~/.openscout/instances/<name>`, own port block (dev:
broker 24400, web 24410, pairing 24420–24422), own node identity, mesh off.
Talk to it with `scout --instance dev …`; plain `scout` talks to prod. Never
hard-code `~/.openscout`, `~/.scout` or 431xx in new code: use the resolvers
in `packages/runtime/src/support-paths.ts`. See `instances.agent.md`.

## Common Checks

```bash
bun run --cwd packages/protocol check
bun run --cwd packages/runtime check
bun run --cwd packages/cli check
```

Use narrower tests/checks when the root check is blocked by unrelated workspace tooling.
