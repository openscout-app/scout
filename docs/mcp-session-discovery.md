# Runtime session discovery in MCP

`sessions_inventory` reads the local runtime's cached observed-harness inventory
with `GET /v1/observed-sessions?limit=200`. It does not query the web API,
bootstrap a web cookie, scan sources, read transcripts or start a service.
The optional native-app reachability read still uses the existing public
runtime library. It does not establish transcript validity or task completion.

## Exact identities and coverage

Each runtime-observed result includes `identity` with `nodeId`, `harness` and
`nativeSessionId`. These are opaque values from the runtime, not a web session,
agent, conversation or terminal id. Use that exact tuple with
`scout session touched` or `scout diff session` after those consumers switch to
the runtime. Do not turn a title, folder or pane label into a session selector.

The tools return candidates, not a resolved target. `identityStatus` is
`observed`, `conflict`, `ambiguous` or `unavailable`; the latter two can occur on
history/overlay results without one matching observation. A conflicted identity
is not usable proof. The runtime's read operation still verifies the tuple and
source when the consumer asks for materials.

`runtimeInventory` preserves the runtime schema, node, scan time, availability,
per-harness source/process availability, cached-window scope, truncation and
link-domain coverage. `runtimeError` preserves a refused request's HTTP status
and safe error code. Network and malformed-response failures remain explicit
unavailability, not an available empty collection. Top-level `available` means
at least one source is available; consult `inventoryStatus`, `sources` and the
runtime metadata before drawing a conclusion. `partial` can mean that a host
source is unsupported even while the runtime observation read succeeded.

The source is one node's cached window. Neither a successful empty response nor
a truncated response proves that no session exists elsewhere or outside that
window. Queries remain literal substring filters, with at most 20 returned
candidates. Runtime coverage replaces the old 80-web-session truncation guess.

## Output changes from the web-backed inventory

- `source` now identifies runtime observations and optional host overlays.
- Runtime rows add `identity`, `nodeId`, `nativeSessionId`, `identityStatus`,
  `observedAt`, `availability`, `identityConflict` and `links`.
- Existing `sessionId` and `harness` mirror the native tuple for display.
  `cwd` and `title` preserve nullable runtime facts.
- Runtime rows have `terminalId: null`, `state: "unknown"`, `actions: []` and
  `panels: []`. Observed transcripts do not provide terminal surfaces or canonical
  web links. No Open/Attach URL is constructed from a native session id.
- Default terminal and Herdr sources are unavailable, not available empty.
  Dependency-injected host overlays retain their existing correlation behavior;
  the public dependency factory no longer fetches them from the web.
- Native-app-only results can retain `reachable`, `location`, `deliveryModes`
  and `submissionRequires`. Without a matching observed row their `identity`
  and node/native identity fields are null. Reachability is separate evidence.

The runtime currently reports conversation and terminal link domains as
`unsupported`. A by-ref lookup cannot establish uniqueness. The client does not
use `/resolve` to guess between identity kinds.

## Indexed history is still indexed history

`sessions_search` keeps its existing read-only lexical index, query limits,
source coordinates, title/snippet bounds, warm coverage, staleness, explicit
warm-up suggestions and narrowed-to-warmed-window behavior. It does not use
`/v1/observed-sessions/materials` as a substitute for lexical search and never
warms the index implicitly.

An indexed hit receives an exact runtime tuple only when one observation matches
its harness and native session id. Missing or ambiguous matches leave the node
identity unresolved. Runtime unavailability does not erase indexed hits: it
appears in inventory status/error metadata. Index text remains untrusted source
material, never instructions. The cached observation is not independent proof
that the indexed snippet belongs to a verified readable transcript.

## Herdr is a separate decision

`herdr_workspaces` is unchanged in this port and still uses its web adapter.
The runtime already exports Herdr session/topology probes through
`@openscout/runtime/setup`, and protocol owns the digest model. It has
no existing broker HTTP route for the full digest or reconciled terminal
surfaces. Machine host/count evidence is not a pane topology replacement.

A bounded read-only runtime route backed by those public probes is a viable
follow-up, subject to API/authority/cache review. App-specific reconciliation
and app links can instead remain in a private extension. Removing the public
Herdr tool requires a migration for existing agent instructions and tool grants.
This port does not choose or implement that change, move probe ownership into
MCP, or claim whole-MCP web independence.

The older web-inventory description in `docs/session-search.md` must be reconciled
when the concurrent attachment documentation change lands. This companion
contract describes the new default session-discovery behavior.
