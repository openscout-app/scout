# Adapter specs

This directory holds the formal OpenScout adapter contract.

The intent is to keep a machine-readable canonical spec for each adapter while
still allowing adapter-specific references and upstream evidence to live next to
the implementation.

## Files

- Current schema:
  [adapter-spec.v2.schema.json](./adapter-spec.v2.schema.json)
- Retained v1 schema:
  [adapter-spec.v1.schema.json](./adapter-spec.v1.schema.json)
- Validator:
  [tools/validate-adapter-specs.mjs](./tools/validate-adapter-specs.mjs)

Each current adapter ships an `adapter.spec.json` in its support directory:

| Adapter | Spec | Conformance status | Normalizer |
| --- | --- | --- | --- |
| ACP | [../acp/adapter.spec.json](../acp/adapter.spec.json) | `grandfathered` | `acp` |
| Google Antigravity ACP | [../antigravity-acp/adapter.spec.json](../antigravity-acp/adapter.spec.json) | `grandfathered` (shared ACP normalizer) | `acp` |
| Claude Code | [../claude-code/adapter.spec.json](../claude-code/adapter.spec.json) | `required` | `claude-code` |
| Codex | [../codex/adapter.spec.json](../codex/adapter.spec.json) | `required` | `codex` |
| Cursor ACP | [../cursor-acp/adapter.spec.json](../cursor-acp/adapter.spec.json) | `grandfathered` | `acp` |
| Grok ACP | [../grok-acp/adapter.spec.json](../grok-acp/adapter.spec.json) | `grandfathered` | `acp` |
| Kimi Code ACP | [../kimi-acp/adapter.spec.json](../kimi-acp/adapter.spec.json) | `grandfathered` | `acp` |
| OpenCode V2 Server | [../opencode-v2/adapter.spec.json](../opencode-v2/adapter.spec.json) | `required` | `opencode-v2` |

The conformance runner discovers this inventory from the checked-in specs. A
`required` adapter must have a passing recorded fixture. A `grandfathered`
adapter reports an explicit warning until recorded evidence lands.

## How To Use It

The formal spec is the canonical adapter contract for:

- capability comparison across adapters
- drift checks against implementation
- generated adapter inventory
- replay conformance

The human references and extractor output are inputs to the spec, not the spec itself.

## Validate

```bash
npm --prefix packages/agent-sessions run adapter:validate-specs
bun run --cwd packages/agent-sessions adapter:conformance
```
