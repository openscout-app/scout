# Migrate callers to the runtime facades

PR 1 adds domain facades without changing caller imports. It removes eight
unused subpaths, adds seven, and expands three existing ones: 99 → 98
subpaths, not counting the package root. The audit checked package specifiers
in Scout core and Scout apps, including tests, scripts, and config files.
It also checked computed specifiers and build inputs. The build still emits
internal modules such as `instance-bootstrap` for direct file loads by the
runtime launcher.

## Use these import targets in PR 2

All paths below are relative to `@openscout/runtime`. Move each named import
to the target in its row. Keep type-only imports type-only. PR 3 can remove a
legacy subpath after both repositories and their build configs stop using it.

| Target | Legacy subpaths |
| --- | --- |
| `./client` | `./broker-api`, `./delivery-client`, `./web-full-client`, `./broker-trpc-router`, `./mcp-events`, `./mcp-event-webhook`, `./remote-tail` |
| `./daemon` | `./broker-process-manager`, `./local-edge`, `./host-attention`, `./pairing-supervisor`, `./pairing-local-socket`, `./inherited-descriptors`, `./broker-core-service`, `./repo-watch` |
| `./config` | `./support-paths`, `./scout-home`, `./local-config`, `./user-config`, `./user-config-fields`, `./instance`, `./path-trust` |
| `./setup` | `./setup` (same path), `./onboarding`, `./diagnostic-report`, `./core-report`, `./system-probes` |
| `./harnesses` | `./harness-catalog`, `./harness-topology`, `./harness-model-preferences`, `./local-agents`, `./local-agent-harnesses`, `./control-plane-agents`, `./agent-workspace`, `./agent-workspace-retirement`, `./live-terminal-session`, `./terminal-environment`, `./in-place`, `./tail`, `./pi-rpc`, `./claude-stream-json`, `./claude-statusline`, `./tool-resolution`, `./broker-runtime-profiles`, `./runtime-list-preferences` |
| `./mesh` | `./mesh-dial-order`, `./mesh-peer-client`, `./mesh-node-state`, `./mesh-peer-filter`, `./mesh-join`, `./mesh-bridge-config`, `./mesh/tailscale`, `./mesh/iroh-bridge`, `./mesh/node-identity`, `./mesh/access`, `./mesh/peer-auth`, `./mesh/local-auth`, `./mesh/pinned-https-client`, `./mesh/client-wire`, `./open-scout-network`, `./relay-transport` |
| `./pairing-security` | `./pairing-security/noise` (host callers only; see below), `./pairing-security/identity`, `./pairing-security/transport`, `./pairing-security/trust-owner` |
| `./routing` | `./registry`, `./routing` (same path), `./provisional-agent-names`, `./scout-bridge-command`, `./dist-access`, `./conversations`, `./conversations/legacy-ids` |
| `./storage` | `./schema`, `./sqlite-adapter`, `./drizzle`, `./attachments` |
| `./extensions` | `./scout-extensions`, `./extension-channel-host`, `./shared-mcp` |

- **Storage:** `briefingsTable` keeps the schema type. For an import from
  `./drizzle`, use `drizzleBriefingsTable` to retain the narrowed bridge type.
  Both names refer to the same table at runtime.
- **Node:** `./client`, `./harnesses`, and `./storage` load Bun-specific
  modules through `./broker-trpc-router`, `./tail`, and `./drizzle`,
  respectively. Keep Node value imports on their portable legacy paths until
  the facade has a portable entrypoint. Type-only imports can move.
- **Browser:** Keep `./pairing-security/noise` and its Vite alias for browser
  value imports until there is a browser-safe replacement. The host pairing
  facade also loads filesystem-backed trust code.
- **Bootstrap:** Keep `./instance-checkout-bootstrap` as the first import in
  checkout entrypoints that use it. It sets the process environment on import.
  The config facade exports the explicit instance configuration functions,
  not the side effect.
- **Root and metadata:** Leave `@openscout/runtime` and `./package.json`
  available. The web loader uses `./package.json` to resolve dependencies
  relative to the runtime.

## Keep optional features on their own paths

These legacy paths stay available in PR 1. Evaluate Ring 2 package
extractions before moving their callers. The migration does not create new
packages.

| Legacy subpaths | Candidate boundary |
| --- | --- |
| `./otlp`, `./jetstream`, `./slack-identities` | OTLP ingestion, NATS transport, and Slack integration, respectively |
| `./knowledge`, `./hub` | Knowledge indexing and hub integration |
| `./agent-notification-builders`, `./mobile-push` | Notification construction and mobile push delivery |
| `./scout-ascii-mark` | CLI and app presentation |
| `./supervision-handoff` | Native supervision cutover tooling; keep it separate from everyday daemon imports |
