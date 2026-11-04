# scoutd

Native first slice for SCO-062.

This binary is the native daemon for the existing Bun-backed Scout base service. The supervisor path stays small and easy to reason about; the probe/repo child
uses serde for the local socket protocol.

```bash
cargo run --manifest-path crates/scoutd/Cargo.toml -- status --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- install --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- doctor --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- --version
cargo run --manifest-path crates/scoutd/Cargo.toml -- start --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- stop --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- uninstall --json
cargo run --manifest-path crates/scoutd/Cargo.toml -- supervise
```

The TypeScript service manager shells out to `scoutd` for local service control.

`supervise` is the long-running daemon mode intended for launchd. It starts the
existing Bun base service as a child, restarts it with bounded backoff, handles
shutdown by terminating the child, and writes `scoutd-state.json` under the
runtime directory for `status` and `doctor`.

`status --json` includes `scoutdVersion` and `scoutdBuild`. Local builds always
report the Cargo package version; packaged builds can set `SCOUTD_GIT_SHA` at
compile time to populate the optional git SHA without making local development
depend on git metadata.

Before each child spawn, `scoutd` bounds the child `stdout.log` and `stderr.log`
files: if either expected scoutd-owned log is above 512 KiB, it writes a tail
snapshot to `.1` and truncates the active file before opening it for append.

## Probe/repo socket

`scoutd probes serve` listens on `$OPENSCOUT_HOME/run/scoutd-probes.sock` (or
`OPENSCOUT_PROBES_SOCKET`). Probe/repo requests receive one JSON response per
connection. Native read subscriptions keep the same mode-`0600` Unix socket
open and exchange newline-delimited JSON frames. The capabilities response
advertises probe families plus job capabilities: `repo.scan` and `repo.diff`.

The native agent read path uses `openscout.native.read.request/v1`. Rust tails
the broker journal asynchronously and serves a bounded persisted projection;
it never proxies the runtime or web server. Snapshot mode returns one
`openscout.native.read.snapshot/v1` frame. Subscribe mode sends the initial
snapshot plus material updates and `openscout.native.read.event/v1` heartbeats.

Repo jobs use request schemas `openscout.repo.scan/v1` and
`openscout.repo.diff/v1`; the remaining request fields are the same JSON
contract accepted by the one-shot `openscout-repo-service` wrapper. Responses
are wrapped as `openscout.repo.response/v1` with `{ operation, value, error,
daemonVersion }`. Repo jobs are executed per request with no daemon-side TTL or
snapshot cache; the TypeScript repo-watch/repo-diff job/cache layers remain the
freshness owners.

## Health sweep

The supervisor samples startup health, filesystem availability, web expectation,
and pairing intent every 30 seconds. It checks version skew and Scout-owned
stale files at startup and every 10 minutes. Projection recovery uses bounded
owned-child restarts. Relay, web, and version conditions are report-only.

`status --json` exposes `healthSweep`, also persisted as `scoutd-health.json`
beside daemon state. Active conditions include `condition`, `cause`, `action`,
`since`, `notifiedAt`, and `notifyAfter`. Consumers must check `checkedAt` for
staleness. A confirmed recovery removes the condition; it sends no notification.

The sweep bounds fixed Scout-owned child logs while their append descriptors
remain open. It does not walk user directories on the periodic path. Disk
threshold transitions trigger a bounded inventory of Scout-owned directories.

See [health sweep contract](../../docs/scoutd-health-sweep.md) for thresholds,
notification durability, cleanup guards, and the isolated recovery smoke test.
