# API 2 extension invocation context

API 2 adds a bounded selected-instance snapshot to the foreground extension
runner. API 1 keeps its existing filtered environment, inherited stdio, working
directory, signals and exit status. Built-ins still win. This is a draft loader
contract, not a released provider capability floor or permission to flip a verb.

## Manifest negotiation

An API 2 artifact declares its required context explicitly:

```json
{
  "api": 2,
  "version": "1.0.0",
  "summary": "Example provider",
  "command": "bin/run",
  "invocation": {
    "context": "scout.extension-context/v1",
    "requires": ["selection/v1", "web.selection/v1"],
    "credentialInputs": []
  }
}
```

The supported API set is `[1, 2]`. API 1 remains the environment default for
historical objects. API 2 requires the exact context schema, a unique array of
at most seven supported feature IDs, and no unknown invocation keys. Unknown
APIs, schemas, required features or declarations refuse before executing a
candidate. `credentialInputs` can be omitted or empty for context-only operation. The
[declared-input draft](./extension-inputs.md) additionally recognizes one exact
credential declaration and its schemas/destination. Its transport is held; a
recognized nonempty declaration cannot run without a qualified channel.
Currently every API 2 invocation refuses `context_backend_unproven` before
spawn; its independent input gate remains closed as well. Executable
completion also refuses under API 2; static completion and Markdown help remain
read-only. No declaration grants inputs or service authority.

API 2 requires a verified managed publication receipt. Install through the
public installer; an unmanaged folder or an older receipt cannot attest this
context. The identity is the receipt's `treeDigest`, not its legacy two-file
`digest`. The runner revalidates the selected generation, trust, declaration
and full tree immediately before spawn. A change refuses rather than selecting
another artifact, an older generation, another instance or a native fallback.
This observed-change check is not an atomic snapshot against hostile same-user
filesystem edits. See [tree identity](./extension-tree-digest.md).

## Frame names for provider review

The frame is one UTF-8 JSON object, LF, then EOF. Its schema is
`scout.extension-context/v1`, and `api` is `2`.

| Field | Meaning |
| --- | --- |
| `features` | `selection/v1` plus the negotiated required features. |
| `cli.version`, `cli.executable`, `cli.runtimeExecutable`, `cli.output`, `cli.cwd` | Parent CLI version, selected entry, host runtime, plain/JSON mode and original cwd. Provider version does not replace CLI version. |
| `selection.uid`, `selection.home`, `selection.instance`, `selection.instanceRoot`, `selection.meshAllowed` | Already-selected, post-isolation identity and layout. Production has a null instance root. No client-pointer reselection or second instance claim. |
| `paths.scoutHome` | CLI Scout home, preserving `SCOUT_HOME`, then `OPENSCOUT_HOME`, then the home default. |
| `paths.runtimeScoutHome` | Separate runtime Scout home, preserving `OPENSCOUT_SCOUT_HOME` and the instance layout. These two home concepts must not be collapsed. |
| `paths.openScoutHome`, `paths.supportDirectory`, `paths.controlHome`, `paths.controlPlaneDb`, `paths.pairingHome`, `paths.relayHub`, `paths.setupCwd` | Resolved operation paths, including existing explicit overrides and pairing aliases. Relative paths are frozen against the original cwd; projection creates no directories. |
| `extensions.name`, `extensions.selectedRoot`, `extensions.readRoots`, `extensions.artifact`, `extensions.version`, `extensions.treeDigest` | Verb, canonical selected root, ordered logical lookup roots, physical generation, published version and full-tree identity. These fields grant no installer authority. |
| `broker.controlUrl`, `broker.internalUrl`, `broker.socketPath` | Actual parent dispatch URL, separate optional internal URL, and selected socket path. Missing internal URL is null. |
| `services.appSocket`, `services.probesSocket`, `services.label`, `services.systemdUnit`, `services.mode`, `services.ports` | Selected targets, not permission to spawn or signal. Missing mode is null; explicit modes use the existing service resolver normalization. Explicit systemd names gain `.service` only when absent. Ports preserve the selected layout plus the parent's effective broker/web/pairing configuration. |
| `configuration` | Only requested projections, described below. |
| `credentialInputs` | Empty in this context-only contract. No presence lookup or credential value is transported. |

The pure projector receives an explicit bootstrap snapshot. It does not read
ambient environment, configuration files, an instance ledger, credential
stores or pairing keys. Existing bootstrap and local-config readers remain
responsible for selection. The snapshot captures only named inputs after the
non-production mesh/push fence. Changing a client pointer later cannot retarget
it. Logical paths support operation; canonical artifact/root identity is kept
separately. Separate exact-tree grant management does not enable an input channel.

## Named configuration

Each requested projection is an object of named fields. Every field has
`present`, `source` (the selected environment name, or null) and `value` (the
trimmed string, or null). Missing configuration is explicit, not replaced by
another instance's default. Values retain the provider's parsing and
argv-over-environment precedence.

| Feature | Fields |
| --- | --- |
| `selection/v1` | The common frame, always delivered. |
| `web.selection/v1` | `profile`; the CLI version remains in `cli.version`. |
| `distribution.endpoint/v1` | `endpoint`; the provider owns the default and endpoint normalization. |
| `pair.configuration/v1` | `port`, `relayUrl`, `mobileRelayUrl`, `discovery`, `logLevel`. Port metadata preserves environment presence before the provider reads its own pairing configuration. |
| `runtime.tools/v1` | `bun`, `caddy`, `tailscale`, `tmux`, `scoutd`, `scout`. No harness-token inheritance is added. |
| `menu.bootstrap/v1` | `telemetryBootstrap`, `scoutCommand`, `statuslineInstance`. No build/signing projection is implied. |
| `server.configuration/v1` | `host`, `port`, `viteUrl`, `edgeScheme`, `portalHost`, `advertisedHost`, `localName`, `viteHmrPath`, `publicOrigin`, `trustedHosts`, `trustedOrigins`, `staticRoot`. No web-auth input is included. |

No manifest can name an arbitrary environment variable. Unknown required
projections refuse. Credential-bearing URLs, URL fragments/queries, control
characters and invalid selected service ports refuse without printing their values. Previously
accepted credential-bearing URLs are a held cohort, not silently rewritten
connections. The current context-only URL forms are HTTP(S) and WS(S).

The frame is non-secret; the inherited API 1 environment filter is not a
sandbox or a general secret scrubber. Other non-Scout environment variables
still have their existing disposition. A trusted provider retains ordinary
same-user OS rights. Neither context paths nor a publication receipt authorize
reading every file under a root, downloading, unlocking a store or starting a
service.

## Transport and cleanup

The runner takes its target from
`INHERITED_DESCRIPTOR_LAYOUTS.extensionApi2.context`, exported through
`@openscout/runtime/daemon`. It never allocates a literal target.
The credential target stays unmapped, as do the role parent/context/fence
capabilities. Stdio 0–2, stdin bytes, cwd, remaining argv, signals and exit status
retain their foreground meanings. Context does not consume stdin, argv or an
environment variable, and is not written to a temporary file.

The byte limit is 64 KiB including LF. The delivery deadline is five seconds,
not a lifetime limit on the command. Write completion means OS delivery, not a
provider acknowledgement. The provider must validate the schema, required
features, complete frame and EOF, then close its context descriptor before
command work or launching descendants. It must not print command output before
that validation. These are trusted-provider obligations, not confinement of a
malicious executable.

**No context host is approved for activation. API 2 is dormant:** every dispatch
refuses with `context_backend_unproven` before spawning a provider or creating
a channel. API 1 is unchanged. The frame and lifecycle above describe the
held contract, not an enabled delivery capability.

The former Node-extra-pipe qualification is withdrawn on both macOS and Linux.
The Node wrapper and native subprocess retain ownership of the same extra-pipe
number. After the socket destroys it, the native finalizer can close a regular
file or a new channel that reused that number. This was measured on macOS at
revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`; the identified finalizer
path is shared non-Windows code. A previous green Linux run does not qualify
that mechanism. Two extra simplex pipes inherit the same defect. Retaining
native objects to suppress GC is not an accepted workaround. Numeric descriptor
mapping on 1.3.13 remains rejected.

A new transport must have one descriptor owner and pass the corrected reclaim
witness on its exact revision and platform. Both the context simplex form on slot 5 and
the credential duplex form on slot 6 require at least eight sequential exchanges,
fresh regular files reclaiming each released parent number, identity checks
(file kind, device and inode) across repeated GC, and a second spawn that
reuses the first exchange's number without a stale close. The in-tree
post-context sentinel opens fresh files after context tests, not before them.
Stale-second-close controls must demonstrate sensitivity to that same failure.
With the product dormant, standard-stdio controls validate only the instrument;
they do not qualify an API 2 backend. No known-broken extra-pipe mechanism runs
as a passing product test.

W5 delivery requires a corrected-witness-qualified transport on its CI's exact
pinned revision and platform. A pin move alone buys no capability. Any later Bun
revision is subject to that same rule; there is no semver-based qualification.

The dormant executor instead uses the qualified numeric transport through the
[host facade](./extension-channel-host.md). The source adapter closes in the
synchronous spawn scope, before any await. The parent adapter alone closes its
endpoint after the frame to produce EOF. The parent never wraps either number
in a stream, Socket, FileHandle or Bun.file. Slot 6 stays ignored.

The adapter's final cooperative yield can finish after a child has read the
whole frame and exited. The runner distinguishes complete kernel write progress
from genuinely pending bytes before cancelling on child close. This is still
not a provider acknowledgement. The race is tested in both directions.

Deadline, write failure, early child exit with pending bytes or cancellation
closes pending work through its adapter. Failure cleanup sends TERM to only the invocation child,
then escalates to KILL after 250 ms if needed, and reaps it. Process listeners
are removed. No service tree or unrelated descendants are guessed or swept.
API 2 dispatch never performs automatic broker upkeep. Static JSON help never
executes the provider; direct provider help currently refuses with
`context_backend_unproven`, as does every other API 2 invocation.

Pre-spawn/context failures use #66's raw-stderr
`scout.cli.command-unavailable/v1` envelope and exit 69, with reasons
`context_invalid`, `selection_changed`, `context_delivery_failed` or
`context_backend_unproven`.
Unsupported declarations retain `incompatible`. Provider command failures keep
their own output and exit status. No credential channel is enabled. The separate
draft grant-management actions do not activate delivery.
