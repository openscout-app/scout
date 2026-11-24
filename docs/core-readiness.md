# Core setup and readiness

`scout setup` prepares the public runtime and coding-agent integrations.
`scout doctor` observes the selected core. Neither command installs an app,
checks an app bundle, installs a local-edge CA, or requires the private Web-PTY
relay. App diagnostics own those checks.

Core readiness uses the report API in `@openscout/runtime/setup`.
`buildCoreServiceReport` projects a selected `/health` observation.
`assessCoreSetupCompletion` assesses that report. The CLI does not derive core
readiness from service installation, process presence, or coding-agent login.

## Selected core evidence

The CLI reads the selected broker's `/health` with a four-second request
budget. It uses the public broker client and selected control socket or broker
URL, not a web cookie or app service. Refusals retain their HTTP status and body.
Timeout, cancellation, unavailable transport and invalid responses remain
inconclusive. They do not prove that the runtime stopped.

The core report retains separate health, startup, projection, journal-write and
cached-storage checks. A healthy liveness response cannot hide failed journal
writes or incomplete recovery. Optional app, local-edge, PTY and native
supervision observations default to `not_checked`. They cannot repair or impair
core assessment. `custody: "not_assessed"` is explicit.

An independently configured `OPENSCOUT_NODE_ID`, when present, supplies the
expected node. The CLI never copies an observed node into that expectation.
Without an expected identity, even an otherwise healthy report cannot complete
setup. A mismatched identity remains unverified. Use only the selected
instance's trusted configuration for this expectation.

## Setup

```sh
scout setup --source-root /path/to/projects --default-harness codex
scout setup --source-root /path/to/projects --json
```

Setup retains settings, project inventory, broker service acquisition, public
skill installation, and the Claude statusline integration. This change does not
replace that acquisition path or change service custody.

Catalog inspection uses local evidence and does not run provider authentication
checks or read a credential vault. The core report projects executable presence
only. Coding-agent authentication and execution readiness remain `not_checked`.
An absent coding agent does not prevent a verified core from completing setup.

JSON output uses `schema: "scout.setup.v2"` and `scope: "core"`. It includes
`coreReport` (`scout.core-report/v1`) and `coreCompletion`
(`scout.core-setup-completion/v1`). Core completion is `complete`, `pending`, or
`failed`. The outer CLI outcomes remain `ready`, `running`, `handoff`, and
`failed`: ready means core completion, not authenticated agent execution.

A missing headless foreground broker produces outer `handoff` and inner
`pending`, with `openscout-runtime broker` as the next command. It is not a
running runtime. Required public integration failures and broker setup warnings
still fail setup. Plain output uses the same assessment.

The report has no `localEdge` or `terminalPty` field. `appReadiness.status` is
`not_checked`, not a successful app health check. `webUrl` and `browserGuidance`
are null. Guidance is terminal-only, not app installation, browser launch, or
phone pairing.

## Doctor

```sh
scout doctor
scout doctor --detail
scout doctor --json
scout doctor --fix --yes
```

The Bun CLI's default diagnostic view runs four bounded checks: `broker`,
`native`, `runtimes`, and `probes`. Each owned worker has a six-second deadline.
The runtime check uses the shared core assessor. Runtime inspection reports
executable presence, not authenticated readiness. Native and probe diagnostics
are separate observations, not prerequisites in the core report.

Detailed plain output retains project inventory, broker service status, public
runtime capabilities, system probes, and native daemon diagnostics. It also
renders the core report's individual checks. Private app dependency checks are
absent.

Bun JSON output uses a new `scout.doctor.core/v1` NDJSON stream with `start` and
`complete` phases. `complete.report` is the existing `scout.core-report/v1` DTO,
not a fabricated service-ownership object. Plain JSON observation does not run
native diagnostics or project inventory. An explicit JSON `--fix` additionally
returns the native repair result outside the core report.

Node keeps its single headless JSON object, not the Bun stream. Its schema is
`scout.doctor.core.node/v1`, with `scope: "core"`, `coreReport`, the existing
headless service/onboarding observations, and `appReadiness`. Node does not run
native repairs.

`--fix` retains the existing explicit native core repair path. It does not
install private app artifacts, Caddy, a CA, Node, or the Web-PTY relay. Explicit
server trust commands retain their separate behavior. Native update and service
custody are separate interfaces and are unchanged here.

## API migration

Setup consumers must recognize v2, accept null browser fields, stop requiring
`localEdge` or `terminalPty`, and use `coreCompletion` for verified core state.
Bun doctor consumers must opt into `scout.doctor.core/v1` and its two phases
instead of the previous `scout.doctor.v1` full-report event layout. Node doctor
consumers must recognize its named headless schema. Do not interpret removed
app checks as successful checks.

The existing runtime completion API and its legacy app/browser presentation
remain unchanged for other callers. Core CLI presentation never calls that
legacy helper. No broker HTTP endpoint or protocol message changes.
