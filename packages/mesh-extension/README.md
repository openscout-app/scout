# Open mesh extension: HTTP MCP core

This package owns the open HTTP adapter for the 24 default `mcp:core` tools.
The executable/relay runner is a separate delivery step. No built-in verb is
removed or overridden here.

The adapter receives a selected broker HTTP origin and a relay-authenticated
full principal. Tool arguments cannot replace that principal, mailbox owner or
sender. Unknown tool selections fail at startup with the unsupported names.
Requests have time/size bounds, refuse redirects and never return upstream error
bodies. Protected local ingress supports an explicitly supplied administration
proof callback. It discovers no key file, socket, support directory or active
in-process broker. The administration key is an explicit user credential, not
the runtime's machine/node key.

Custody decides origin. Runtime-owned operations use HTTP. The only runtime
library dependency outside HTTP is its public, store-free webhook transport:
it sends public HTTPS callbacks signed with user-owned subscription secrets,
with existing DNS pinning, private-address refusal and response bounds. It never
loads a node key. Modern MCP Events still use runtime claim/prepare/settle leases;
revocation is checked before sending. Mailbox notifications remain hints over
`/v1/events/stream`, not a replacement for the durable mailbox.

With `OPENSCOUT_MCP_EVENTS=1` on the runtime and bridge, `server/discover`
advertises `io.modelcontextprotocol/events` on MCP 2026-07-28. Use `events/list`
to discover the filters for `flight.completed`, `work.waiting`, and `message.created`.
They deliver signed HTTPS webhooks. Unsubscribe with the original event name,
arguments, and callback URL. The original discovery key remains available to
earlier webhook clients. [MCP Events beta specification](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx)

Feedback always uses bridge-specific collection/upload routes, with principal
from constructor state. Remote diagnostics default to note-only unless the
runtime finds explicit matching consent. Failure never switches to the local
operator route. Collect and upload remain separate HTTP requests. An upload
failure retains the saved receipt; a later fresh collection uses current consent.

Tool input wire types are checked against the existing public core catalog.
Unexpected object fields are rejected rather than silently discarded; explicit
arbitrary metadata records remain supported.
Results use JSON text plus structured broker records/projections, not desktop
terminal formatting or private-app links. Agent search reads known runtime
inventory; it does not silently execute desktop host/project discovery.

## Tail filters

`tail_events` uses `GET /v1/tail/recent`, never tRPC. `sources` and `kinds` are
repeated URL query keys; session ID is exact; project/cwd/query use the same
case-insensitive matching predicate as tRPC. Transcript inclusion and limits
remain explicit. Cache identity includes every filter. Named-session reads apply
the other filters too. Arrays are bounded to 64 values of 512 characters; other
filter strings to 2,048 characters. Oversized filters are refused, not truncated.

Run `bun run check` and `bun test src` from this directory. Tests include an
isolated protected runtime, all default tool handlers, discovery/schema parity,
principal pinning, feedback provenance, modern events and mailbox parsing.

## Build and install the mesh artifact

Run `bun run --cwd packages/mesh-extension build`. This creates
`packages/mesh-extension/dist/mesh`, with one executable and `extension.json`.
Install that directory with `scout extensions install mesh <directory>` after
installing a Scout version with extension installation support. Use `update`
for later builds. No install step runs automatically. The built-in `mesh` verb
is still registered and still takes precedence. This change does not flip it.

The executable can run outside this checkout with Bun on PATH. It uses no
source-relative files, node_modules, desktop modules, broker stores, native
probes, support-directory lookup, or runtime machine keys. Shared wire,
cryptography, pinned HTTPS, explicit user-key and SSH helpers are client code,
not an alternate runtime. Custody decides origin: machine/node-key operations
use the runtime HTTP API; public or user-key operations can run in this client.
SSH retains the user's SSH policy.

Set `OPENSCOUT_BROKER_URL` for foreground commands, or pass `--config` with an
explicit JSON file. The CLI supports mesh status, diagnostics, discovery,
presence, ping, approvals, guests, trust/SAS/SSH enrollment, and scoped access.
JSON is the portable output format; plain trust/access output remains readable.
The portable join command does not open a Tailscale GUI. A successful bind stays
successful if subsequent discovery is unavailable. Ping always uses the bounded
runtime route, including raw URLs. A raw-URL ping lets a local caller learn
whether an address answers; it does not request a machine-key signature.

## Run the bridge

Use `scout-mesh bridge --config <file>`. Configuration and credential files must
be owner-only regular files, not symlinks. The bridge never falls back to an
environment token or a guessed runtime directory. Relative paths resolve from
the configuration directory. For example, a user-provisioned file can contain:

```json
{
  "brokerUrl": "http://127.0.0.1:4800",
  "relayUrl": "https://relay.example.invalid",
  "tokenFile": "relay-token",
  "tools": "core"
}
```

Optional fields are `dir`, `localAdmin: {keyFile, destinationKeyId}`,
`tokenKeychainService`, `eventsEnabled`, and `supervisor: {parentPid}`. The
local-admin key is a separately provisioned user-owned credential, not the
machine identity. The keychain is read only for an explicitly named service on
macOS. Credential values are never included in logs or errors. Exit 78 means
configuration is refused, including unsupported tools. Unsupported `--tools`
are reported by name before any connection. Help reads no configuration.

Every request, including the legacy MCP protocol, must carry the relay's full
authenticated principal. Agent-only envelopes are refused with 403 rather than
inventing consent identity. Each principal has its own MCP server. Cancellation
reaches the SDK and HTTP request. Reconnects, mailbox hints and MCP Events use
the same portable HTTP adapter. `eventsEnabled` must be explicit and requires
runtime support. Remote diagnostic collection remains subject to runtime
per-identity consent; the default is a note without diagnostics. A consented
stranded report is collected again according to the runtime report contract.

`bridge status`, `configure <owner-only-json-file>`, `enable`, `disable` and
`request-restart` call the runtime management routes. They never spawn a bridge
or write runtime configuration directly. The original built-in OAuth connect
and legacy LaunchAgent migration commands remain available in the core CLI;
they are not portable extension commands. Provision a relay credential through
the runtime configuration API or an explicit bridge file for now. Supervisor
selection is a separate change, and the final built-in-verb flip remains later.
