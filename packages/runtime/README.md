# OpenScout Runtime

`@openscout/runtime` is the local runtime foundation for OpenScout: the broker,
SQLite store, service lifecycle, local discovery, system probes, and host-side
adapters that make the protocol durable on a developer machine.

Use [`@openscout/protocol`](../protocol) when you only need the data contract.
Use this package when you are building a local OpenScout surface, service, CLI,
or integration that needs to talk to or embed the broker/runtime layer.

> Current posture: OpenScout is for high-trust local developer pilots. This
> package is not a hardened multi-tenant runtime or a compliance boundary.

## Install

```bash
npm install @openscout/runtime @openscout/protocol @openscout/agent-sessions
```

The runtime is TypeScript-first and publishes built ESM plus declarations. In a
Bun monorepo checkout, the package export map keeps the `bun` condition pointed
at `src/` so local development can type-check without building `dist` first.
Published Node/ESM consumers resolve `dist/`.

## Quickstart: embed the in-memory runtime

For tests, tools, and small local integrations, start with the in-memory runtime
and the shared protocol types:

```ts
import { InMemoryControlRuntime } from "@openscout/runtime";
import type { MessageRecord } from "@openscout/protocol";

const runtime = new InMemoryControlRuntime();

const message: MessageRecord = {
  id: "msg-demo",
  conversationId: "conv-demo",
  actorId: "operator",
  originNodeId: "local-demo",
  class: "agent",
  body: "Hello from a local OpenScout integration.",
  visibility: "workspace",
  policy: "best_effort",
  createdAt: Date.now(),
  metadata: {},
};

await runtime.postMessage(message, { localOnly: true });

console.log(runtime.snapshot().messages[message.id]?.body);
```

For a machine service, use the `openscout-runtime` bin or the public CLI package
that wraps it:

```bash
openscout-runtime service status --json
openscout-runtime broker
```

## What this package owns

The runtime is the operational layer beneath OpenScout surfaces:

- canonical local SQLite schema and stores
- broker daemon, HTTP, SSE, and routing services
- message, invocation, flight, delivery, question, and work-item persistence
- local agent and harness endpoint discovery
- service install/status/start/stop helpers
- repo watch and repo diff snapshots
- system probes for host state used by the broker and web UI
- optional mesh helpers through Tailscale and Iroh bridge processes
- mobile push relay records for local broker notifications

The broker remains the canonical writer for Scout-owned coordination records.
External harness transcripts are observed source material; they are not bulk
imported as first-party Scout messages.

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@openscout/runtime` | Root broker/runtime surface: registry, broker services, store, setup, config, probes, projections, repo watch/diff, and protocol path re-exports. |
| `@openscout/runtime/broker-api` | HTTP client helpers for talking to an active local broker. |
| `@openscout/runtime/broker-core-service` | Broker service composition boundary for embedding/testing. |
| `@openscout/runtime/broker-process-manager` | Service config, status, install/start/stop/restart helpers. |
| `@openscout/runtime/broker-trpc-router` | tRPC router surface for broker-adjacent hosts. |
| `@openscout/runtime/registry` | Runtime registry snapshot helpers. |
| `@openscout/runtime/local-agents` | Local agent config, launch, wake, and session helpers. |
| `@openscout/runtime/harness-catalog` | Known harness catalog and readiness reporting. |
| `@openscout/runtime/system-probes` | Cached local system probes and scoutd-backed probe client. |
| `@openscout/runtime/repo-watch` | Repo/worktree status snapshots for Scout surfaces. |
| `@openscout/runtime/knowledge` | Local knowledge/session indexing store. |
| `@openscout/runtime/conversations` | Conversation service facades over the runtime store. |
| `@openscout/runtime/mesh/tailscale` | Tailscale status and host helpers. |
| `@openscout/runtime/mesh/iroh-bridge` | Iroh bridge process helpers. |
| `@openscout/runtime/mobile-push` | Local mobile push registration and audit store. |
| `@openscout/runtime/sqlite-adapter` | Runtime SQLite adapter selection for Bun/Node hosts. |
| `@openscout/runtime/drizzle` | Host-bound control-plane DB bridge for internal server code that queries runtime-owned tables. |
| `@openscout/runtime/tool-resolution` | Portable executable/path resolution helpers. |

Additional exports provide focused slices for setup/onboarding, agent workspace
configuration, provisional names, local config, local edge, session display,
activity, tail, harness topology, Claude stream-json, pi RPC, Codex app server,
and related broker read models.

## Runtime support

This is a host-side package, not a browser package.

| Surface | Browser | Node | Bun | Notes |
| --- | :---: | :---: | :---: | --- |
| Pure helpers such as config/path/protocol facades | — | ✅ | ✅ | May still read environment or files depending on import. |
| Broker/store/service surfaces | — | ✅ | ✅ | SQLite adapter chooses Bun SQLite or Node SQLite. |
| `openscout-runtime` bin | — | — | ✅ | The bin uses a Bun shebang. |
| Local agent, harness, MCP, repo, and system-probe surfaces | — | ✅ | ✅ | These may spawn local tools or talk to `scoutd`. |
| Mesh/Iroh helpers | — | ✅ | ✅ | Require configured native bridge binary. |

Published declarations avoid requiring downstream TypeScript projects to install
`@types/node` just to import the package. Runtime execution still requires the
host capabilities used by the surface you import.

## Native acceleration and fallbacks

Some expensive or OS-sensitive work can be delegated to Rust binaries:

- `scoutd` serves cached system probes and selected imperative operations over a
  local Unix socket.
- `openscout-repo-service` produces native repo scan/diff facts.

The TypeScript runtime uses a conservative fallback model: prefer the scoutd
socket when it advertises the capability, fall back to a bounded native
subprocess when available, and finally use existing TypeScript/local fallback
paths where the feature supports them. Fallback metadata is attached to relevant
responses so operators can diagnose when the daemon is unavailable.

### No daemon required

`scoutd` is an optional accelerator, not a requirement for adopting the package.
The TypeScript/local backend is a first-class, permanent mode: imports, ordinary
unit tests, and supported runtime operations continue to work without a Rust
toolchain or a running daemon. When `scoutd` is present, the runtime verifies the
advertised capability and schema version before using it; when it is absent,
stale, or incompatible, the same typed APIs fall back locally and expose backend
metadata for diagnostics.

The real-daemon conformance harness is intentionally opt-in for contributors:

```bash
OPENSCOUT_CONFORMANCE=1 bun test packages/runtime/src/system-probes.test.ts --test-name-pattern='scoutd conformance diff harness'
```

CI runs that conformance suite, but casual `bun test` does not need Cargo.

## Replies to live harness sessions

Operator clients use the existing `POST /v1/deliver` command with the wire intent
`session_input`,
an exact native Claude or Codex session target, a stable requester-scoped
`requestId`, and `sessionDelivery: "in_place_or_resume"`. Before submitting,
clients must freshly read `/v1/node` and require the
`session-input-receipts/1` capability. Older brokers may ignore unknown request
fields, so clients must fail closed when that capability is absent. The new
wire intent also makes an older broker reject the request if a broker is
replaced between the capability read and submission. The current boundary
normalizes it to consult intent before the existing durable command executes.

The broker durably reserves the request before submitting input. Only an
explicit `not_live` result continues ordinary exact-session acceptance inside
that same request. This fallback relies on live-host probes and the normal
exact-session resolver's live-owner checks. An unobserved or ambiguous Herdr
identity is a refusal, not evidence that the session is no longer live.
A successful live submission returns
`receipt.inputSubmitted` with `state: "submitted"`, the native session, harness,
and transport location. It has no execution flight and does not prove that the
agent completed the work. The canonical message is recorded without scheduling
another transport delivery.

Concurrent retries and retries after a lost response use the same request id
and unchanged payload. A persisted canonical submission witness can recover the
original receipt after restart. If the process fails after input may have been
submitted but before that witness exists, the request remains
`request_outcome_unknown`; it is never automatically submitted or resumed again.
Clients retain the original id and draft while reconciling this outcome.

This option accepts plain text and exact local session continuation. Attachments,
work items, remote targets, project launches, and runtime overrides are rejected
before submission. Ordinary asks retain their existing delivery behavior.

## Explicit completion and joined work

The optional `explicit-completion/1` contract separates progress from the final
answer. Existing untagged asks keep their current behavior. Start an explicit
ask through the normal CLI or MCP `ask` surface with a stable request id:

```bash
scout ask --to id:<local-agent-id> --request-id review-42 --completion explicit "Review this change"
```

This first version supports exact existing local agent or session identities.
Project/profile launches, aliases, remote targets, external endpoints, forks,
and the session-input delivery option are unsupported. Clients and the broker refuse
explicit runtime overrides for this contract. A local agent ask may create its
normal fresh execution session. Clients require the capability on `/v1/node`
and send `intent: "explicit_consult"` to `/v1/deliver`; an older broker rejects
that discriminant before execution. The current broker normalizes it to the
existing consult command.

The receiver calls `current_reply_context` for the current invocation, flight,
and revision. `messages_reply` accepts a stable `requestId` and a `completion`
object containing `kind: "progress" | "final"`, `invocationId`, `flightId`, and
`revision`. The client posts this as `metadata.completionReply` through
`/v1/messages/reply`. That endpoint fails closed on older brokers. Typed
progress never completes an invocation, including a legacy invocation. Untagged
output or normal process exit cannot complete an explicit ask: its flight waits
for the explicit final. A real failure or cancellation remains terminal.

A worker can opt a child ask into its parent with
`relation: { parentFlightId, kind: "joined" }` (CLI `--join-to <flight>`).
A requester or worker can admit an exact same-session continuation with
`kind: "continuation"` (CLI `--continue-for <flight>`). Admission requires a
stable child request id and a current nonterminal explicit parent. The broker
commits the child and the parent's new obligation/revision together; retries
reuse that child and never increment the revision twice. Each parent accepts
at most 64 obligations. Work without a relation stays independent.

Each obligation pins the child invocation and flight accepted in that write.
A completed, failed, or cancelled child settles that obligation; missing or
unknown child state does not. Settling a child does not complete the parent.
An early final fails with `completion_obligations_pending` before becoming a
stored completion candidate. After observing the children, the parent obtains
its current reply context and submits a new final. New admissions invalidate
older revisions, even if the new child finishes immediately. A stale revision
fails with `completion_revision_stale`. A final's durable message and completion
can recover after restart without rerunning execution, and later cancellation
or replacement of the current flight wins over delayed replies.

## Local development

From the repo root:

```bash
npm --prefix packages/runtime run build
npm --prefix packages/runtime run check
npm --prefix packages/runtime run test
bun run sync-exec:fence
```

The sync-exec fence is intentionally separate from the package-local check. Run
it before changing host process, probe, or service-management code.

## Publishing checks

The package is prepared for standalone npm publication with real dependencies on
`@openscout/protocol` and `@openscout/agent-sessions`. The prepack step rewrites
workspace dependency ranges to concrete package versions before packing.

Recommended release checks:

```bash
npm --prefix packages/runtime run build
npm pack --workspace @openscout/runtime
npx publint packages/runtime
npx @arethetypeswrong/cli --pack packages/runtime --profile esm-only
```

Also verify an external ESM scratch project with `skipLibCheck: false` and no
`@types/node`; this catches published declaration leaks that monorepo checks can
miss.

## Live and e2e checks

- `bun run --cwd packages/runtime test:live:codex-app-server` uses
  [README-live-codex-app-server-test.md](./README-live-codex-app-server-test.md)
  for a direct Codex JSON-RPC check against an existing app-server listener.
- `bun run --cwd packages/runtime test:e2e:local-agent-pass` uses
  [README-live-local-agent-pass.md](./README-live-local-agent-pass.md) for a
  full Codex ↔ Claude broker pass on one machine.

These live checks require local harnesses and are not a substitute for the unit,
package, and external-consumer checks above.
