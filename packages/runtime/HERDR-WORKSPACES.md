# Local Herdr workspace observations

`GET /v1/terminal-hosts/herdr/workspaces[?session=<exact-name>]` returns
`scout.herdr-workspaces/v1`. It is a **local-tier** route: Unix socket or
loopback ingress, never remote peer, guest or scoped grants. Origin-bearing
and forwarded-node requests refuse before forwarding or probes. The broker's
listener guard applies through the same local route matrix as other local
reads. There is no private web dependency, lifecycle operation or terminal-output
read. Herdr owns its workspaces and reported panel identities; a reported
`agentSession` is not a verified Scout observed-session binding.

## Response

- `schema`, `nodeId`, `scannedAt`: schema ID, serving node, and cached enumeration
  observation/failed-attempt timestamp; null before a completed observation.
- `availability`: `not_scanned`, `available`, `partial`, or `unavailable`.
- `reason`: `not_scanned`, `session_list_unavailable`, or null. Raw command
  errors, stderr, environment keys, sockets and session-state directory paths
  are not returned.
- `requestedSession`, `count`, `digests`, `truncated`, `coverage`.
- Each digest preserves the protocol model's `session`, `live`, `observedAt`,
  `savedAt`, `unavailable`, totals/status counts, attention/working lists,
  directory groups, shapes, notes and truncation, and adds `availability`.
  Saved panes have unknown status and no live target.
- A live digest also carries `clients` (herdr clients attached to the session,
  counted from this host's process table) and `apps` (the macOS apps they run
  in) when the process table was readable, and each pane carries `gitBranch`
  when the host read it: null outside a git checkout or on a detached HEAD.
  All three are optional. A saved digest never carries `clients` or `apps`. These are host observations,
  not selectors into Scout agents or conversations.

Enumeration failure, malformed output and a missing executable are
`unavailable`, never successfully observed empty. A successful empty enumeration
is `available` with zero digests. Cold/uncompleted injected cache state is
`not_scanned`; an attempted missing-executable read is not cold. Mandatory
live-topology failure without saved state is an unavailable digest; readable
saved state is partial and explicitly last-known. Optional agent/geometry loss
or dropped/unjoined topology rows is partial. Mixed success/failure is partial;
all unavailable digests make the response unavailable. Truncation is separate
from source health. A stale enumeration is partial. Observation availability
never proves process completion, global session absence or input authority.

A session selector is exact and case-sensitive, at most 128 characters, with
no path separators/control characters or `.`/`..`. Only names in the bounded
cached enumeration are probed. An unlisted name returns 404; an incomplete
enumeration returns 503 rather than claiming the name is absent. Unknown,
duplicate or malformed query parameters return 400 before probes. There is no
HTTP force-refresh, environment, binary or socket parameter.

## Limits and probe cost

`coverage.kind` is `ttl_cached_probes`, scope `this_host_only`, with the listed
session count and these declared limits:

- Inspect at most 256 enumeration entries; read at most 8 selected sessions.
- Two concurrent session topology reads per request.
- Per session: at most 16 workspaces, 64 tabs/shapes and 256 input panes; bounded
  layout geometry. Input caps label totals/counts as a bounded prefix.
- The protocol digest emits at most 40 group panes and 12 per lead list.
- Any enumeration/input/presentation cap omission is explicitly truncated.

The route uses the existing 5-second environment-keyed enumeration probe and
2-second `(environment, session)` topology cache, never `maxAgeMs: 0`.
Environment keys derive from the server-owned binary/PATH/HOME/XDG config home.
Concurrent topology misses coalesce, and failed enumeration is cached too.
The topology cache admits at most 64 cached/in-flight keys and refuses capacity
rather than evicting a fresh key and spawning it again inside its TTL.

A refresh is **not one Herdr process total**: enumeration runs one
`herdr session list --json`; a successful topology refresh runs three mandatory
list commands, then two optional agent/snapshot commands. Two requests within
the TTL share one six-command cycle for one session, not twelve commands.
Eight successful sessions can cost one enumeration plus forty topology commands.
Each command is timeout/byte bounded. Saved-state reads are capped at 512 KiB,
use a nonblocking descriptor and reject non-regular files. No background scan,
indexing or service is started by this route. The same CLI behavior applies on
Linux: an installed executable can answer; an absent one reports unavailable.

The older array-only `readHerdrSessions()` remains tolerant. HTTP reads use the
checked snapshot instead, retaining errors that must not become available-empty.
CLI consumers should use this route, not invoke a second probe owner or the
legacy web route. This change does not move any caller or grant.
