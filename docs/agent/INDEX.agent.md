# Semantic Spec Index

Verified: 2026-06-19

Dense agent-oriented subsystem specs. Read the relevant file before extending that area.

Not governance docs. Not proposals. Compressed ontology + invariants.

| Spec | Scope |
|---|---|
| [README.agent.md](./README.agent.md) | repo entry, paths, non-negotiables |
| [broker.agent.md](./broker.agent.md) | canonical writer, records, routing outcomes |
| [otlp.agent.md](./otlp.agent.md) | opt-in OTLP receiver, sanitization, bounded inspection and lifecycle |
| [scout-comms.agent.md](./scout-comms.agent.md) | CLI/MCP workflows, send vs ask |
| [scout-chat.agent.md](./scout-chat.agent.md) | chat invites: what joining does, trust model, `chat info` |
| [runtime-sessions.agent.md](./runtime-sessions.agent.md) | agent/session/endpoint lifecycle |
| [pairing-runtime.agent.md](./pairing-runtime.agent.md) | mobile bridge, QR, relay (not broker) |
| [scoutd.agent.md](./scoutd.agent.md) | launchd, supervise, doctor |
| [instances.agent.md](./instances.agent.md) | `OPENSCOUT_INSTANCE`: dev/worktree isolation from prod, rails, systemd unit |
| [integration-contract.agent.md](./integration-contract.agent.md) | external agent minimum contract |
| [derived-records.agent.md](./derived-records.agent.md) | records made from work items, the read rule, pull and push producers |

## Read order by task

| Task | Read |
|---|---|
| send/ask/route | `scout-comms.agent.md` → `broker.agent.md` |
| joining a pasted Scout Chat invite | `scout-chat.agent.md` |
| start/wake/attach harness | `runtime-sessions.agent.md` → `broker.agent.md` |
| mobile pair / QR | `pairing-runtime.agent.md` |
| local service broken | `scoutd.agent.md` |
| run a checkout beside the installed Scout | `instances.agent.md` |
| new harness adapter | `integration-contract.agent.md` → `runtime-sessions.agent.md` |
| make or read something derived from work (a presentation, a label) | `derived-records.agent.md` |

## Format

The core subsystem specs follow: Role → Model → Relations → (State/Flows) → Invariants → Forbidden → Code map → Verification. `integration-contract.agent.md` is a contract digest without code map/verification.