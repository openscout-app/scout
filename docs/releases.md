# Public package releases

## Core-only source boundary

The core release contains no web app or native app source. The Mac, iOS,
Android, and web apps are separate clients. Historical release notes below
about a bundled basic web client describe earlier artifacts, not the current
package contract. Source exports and the former five-package web-composition
plan are superseded by the [public-source boundary](./public-source-boundary.md).


## Standalone Scout Tailscale client

`packages/scout-tailscale` is a separately versioned MIT Python client. Its
wheels are distributed only through this repository's GitHub releases,
using tags such as `scout-tailscale-v0.3.1`. They do not change Scout's shared
npm/native version, publish to PyPI, or claim GitHub Latest.

Review and merge the client, license, tests and version before publishing.
Use a clean checkout at freshly fetched canonical `openscout-app/scout` main. Run the
Python tests against this checkout's runtime fixture, build the wheel once,
inspect its contents and license, and fresh-install those exact bytes in an
isolated environment. Retain the wheel outside the source tree along with
`SHA256SUMS` (the wheel's digest) and `receipt.json` recording its version,
canonical source commit, filename, SHA-256 and build/test commands.

Create the dedicated tag at that reviewed main commit. Publish a GitHub
prerelease with the retained wheel, checksums and receipt, using
`gh release create --repo openscout-app/scout --verify-tag --prerelease --latest=false`.
Do not rebuild on a publication retry, overwrite an existing asset, move a
published tag, or invoke the npm publisher for this client. A retry must first
compare existing remote assets to the retained bytes.

Verify the public tag's commit and download all release assets anonymously.
Compare their hashes to the retained artifacts, fresh-install the downloaded
wheel, and confirm its version. A wheel release does not establish a real
owner-approved connection or completed agent reply; report those separately.

Beginning with `0.2.91`, Scout's complete supported public npm set is released
from this repository. npm accepted only `@openscout/protocol@0.2.88` during the
local authority cutover; the strict partial-set guard stopped that attempt, and
neither package was promoted to `latest`. Version `0.2.89` stopped before its
first upload. The first GitHub OIDC attempt then published both `0.2.90`
artifacts under their version-specific staging tag, but npm correctly rejected
the workflow's later `dist-tag` mutations: trusted publishing authorizes
`npm publish`, not `npm dist-tag`. None of those versions reached `latest`, so
all three are historical and unsupported.

Do not complete or manually promote the `0.2.88` or `0.2.90` candidates. Do not
publish public packages from a private product checkout or from a commit that
is not public `openscout-app/scout` `main`.

## Publication ownership

This public repository owns `@openscout/protocol` and `@openscout/scout`.
Other workspaces share the source version but are not separately supported npm
releases. Native macOS/iOS apps remain in the private product repository.

Stable releases publish from the hosted `release-package-npm.yml` workflow, so
npm records provenance for each version it publishes. See
[Hosted publication](#hosted-publication). `bun run ship -- <version> --execute --yes`
refuses a new upload and prints the tag and dispatch commands. Add
`--local-publish` only when the hosted workflow cannot run. A local publish has
no npm provenance, and because npm versions are immutable, that version never
gains it. Recover a failed hosted run with
`recovery_run_id`, not with a local publish. Record proportional local checks
against the exact reviewed head and current main base; observe required GitHub
rules and feedback before merging.

These versions have no npm provenance: 0.2.104 through 0.2.110, 0.3.2 through
0.3.5, and 0.3.6 through 0.4.2. npm versions are immutable, so they keep that
state. Before hosted publication became the default, the last version with
provenance was 0.3.6-dev.4.

## Package publication versus the latest downloadable installer

Scout keeps one shared version across npm packages and native apps. Sharing a
version does not make them one publication: package publication and the
downloadable installer have separate owners and separate release steps.

- **Package publication** (this repository): `@openscout/protocol` and
  `@openscout/scout` on npm, plus a GitHub release on `openscout-app/scout` that
  carries the npm integrity `receipt.json` and, once `release-scout-tui.yml` has
  run, the `scout tui` archives.
- **Latest downloadable installer** (private product): the signed macOS DMG,
  built and verified as a local operator task rather than in CI. GitHub's
  **Latest** release, and therefore `/releases/latest` download links, belongs
  to the release that carries that verified installer.

`bun run ship` therefore never claims GitHub Latest. It creates a missing
package release with `--latest=false`, and when it finalizes a draft or
prerelease it also passes `--latest=false`, so a receipt-only release cannot
replace the downloadable installer as Latest. It never edits an existing
stable release: a retry or receipt verification against a release that is
already Latest, such as a verified native release for the same version, leaves
that state unchanged instead of demoting it. Marking a release Latest is a
separate step owned by the native installer release after its DMG is attached
and verified; package publication neither requires nor performs it.

A released Mac app’s install card requests `@openscout/scout@<app-version>`,
so publish and verify the matching npm version before distributing its DMG.
The DMG may be built locally before npm publication; candidate validation
and promotion continue to follow the existing gates below.

## Prepare and review

Choose an explicit unused version. Never use `patch` to recover from registry
drift.

```bash
bun scripts/bump-version.mjs <version>
bun install
bun run ship -- <version>
bun run check
bun run test:unit
bash scripts/ship-npm.sh --dry-run
```

Commit the source, version manifests, `packages/cli/src/lib/shared/product.ts`,
`docs.json`, and lockfile on a review branch. Merge only after the standalone
checks and packed artifact audit pass.

## 0.4.2 the openscout-app organization

Scout's GitHub organization is now `openscout-app`. GitHub redirects the old
`oscout` links, so nothing needs to change before you upgrade.

- **Native downloads** for `scoutd` and the TUI come from
  `https://github.com/openscout-app/scout/releases`. They no longer depend on
  the redirect from the old organization.
- **Messages and help** name `openscout-app/scout`, including the hint to
  install a missing extension and the `cargo install --git` fallback for the
  TUI.
- **Integrations** link the Claude Code, Codex, Cursor, and other plugin
  repositories under `openscout-app`, with matching install hints.
- **MCP Registry:** the package declares
  `"mcpName": "io.github.openscout-app/scout"`. The Scout MCP server can be
  listed under that name in the official MCP Registry.

## 0.4.1 sign in from the terminal

`scout auth login` signs a host in to your Scout account through the browser.
`scout web install` no longer needs a download key made by hand. Keys saved by
0.4.0 keep working, and nothing needs to change before you upgrade.

- **`scout auth login`** shows a short code and opens
  `https://console.openscout.app/device`. Sign in or make an account there, then
  approve the terminal. The download key that comes back is saved in the macOS
  Keychain, in the Secret Service on Linux desktops, or otherwise in a private
  file. Over SSH, without a terminal, or with `--no-browser`, the command prints
  the page instead of opening it. The page must be on the host that
  `OPENSCOUT_DIST_URL` names; a sign-in page on another site is refused.
- **`scout auth status`** shows the signed-in account and where its key is
  saved, never the key. **`scout auth logout`** removes the key from this host
  and says where to revoke it.
- **`scout auth login --key -`** saves a key you already have. At a terminal it
  asks for the key without showing it; otherwise it reads stdin.
  `SCOUT_DIST_KEY` still overrides the saved key for VMs and CI.
- **`scout web install`** with no saved key signs in first when it runs at a
  terminal. Without a terminal it stops with
  `No download key. Sign in first: scout auth login` and does not contact the
  host.
- **`scout web login`** at a terminal is now the browser sign-in. A key piped to
  it is saved as before. `scout web logout` does what `scout auth logout` does.
- **When sign-in stops, the message says why:** the code was denied or expired,
  it was already used, the account can't download the web app, or the account
  holds as many keys as it can. In that last case, revoke one at
  `https://console.openscout.app/#downloads`.
- **No saved key:** the runtime's suggested fix is now **Sign in**, which runs
  `scout auth login`.

## 0.4.0 terminal-only core

This repository now holds the Scout core alone: the runtime, protocol, harness
adapters, session observation and extraction, CLI, TUI, and the host side of
phone pairing. Host pairing is `@openscout/pairing`. The CLI bundles it, and it
is not published separately. The Mac, iOS, Android, and web apps are the
separate Scout apps. npm publishes `@openscout/protocol` and `@openscout/scout`.
The [public-source boundary](./public-source-boundary.md) states the ownership
rules.

### Before you upgrade

- **Keep 0.3.9 while you use Mac app 0.3.9.** That app loads its views and
  sends messages through the web server that the 0.3.9 npm package starts on
  port 43120. 0.4.0 does not include that server. Upgrade the CLI together with
  a Mac app release that supplies its own web server. Until then, install
  `@openscout/scout@0.3.9`.
- **Bun 1.4.4 or newer is required.** `scout`, `openscout-runtime`, the update
  helper and the runtime's child processes check the version before they load
  workspace code. An older Bun exits 1 with
  `Scout requires Bun 1.4.4 or newer; installed: <version>. Upgrade: bun upgrade`.
  A remote host with an older Bun refuses `scout update` before it reads or
  installs anything, and its existing installation stays in place. The remote
  tail client drops its legacy WebSocket fallback for Bun 1.3: on Bun 1.4 and
  Node it reads the failed-upgrade HTTP status directly.
- **The npm package contains no web app.** `scout server` and `scout web` serve
  a web client only when the separate Scout apps supply one, through
  `OPENSCOUT_WEB_SERVER_ENTRY` or the runtime's app service configuration.
  Without one, `scout server start` explains that the web app comes from the
  apps, and `scout web status` reports that no web app is bundled. The runtime
  starts the web server and Scoutbot only from an explicit entry. A configured
  entry that is missing fails closed.
- **`scout setup` and `scout doctor` check the core only.** They report runtime
  liveness, startup, projection, journal writes and storage. They do not check
  app health, the local-edge certificate authority or terminal PTY readiness.
  JSON output uses new schema names: `scout.setup.v2`, `scout.doctor.core/v1`
  (an NDJSON stream on Bun) and `scout.doctor.core.node/v1` (Node). See
  [Core setup and readiness](./core-readiness.md).
- **The journal format moves forward.** The runtime writes a generation header
  when it creates or compacts its journal. Earlier runtimes refuse that
  header, so after that point a downgrade cannot load the journal. The first
  start also runs migration `0028_attachment_message_keys` (schema v19).
- **Hosts with the mesh bridge enabled need a preflight.** The bridge runs only
  from the installed `mesh` extension or an explicit `OPENSCOUT_MESH_BRIDGE_BIN`.
  Run `openscout-runtime mesh-bridge-preflight` from 0.4.0 as the service user,
  before the service restarts on 0.4.0. Exit 0 is required. Exit 78 names the
  `reason` and the `fix`. The
  [bridge cutover guide](../packages/runtime/MESH-BRIDGE-CUTOVER.md) gives the
  full procedure.
- **Serve and Funnel in front of the runtime lose local trust.** If a Tailscale
  Serve or Funnel handler forwards to the runtime's loopback port or socket,
  local-tier requests on that listener are refused with
  `tailscale_runtime_listener_guarded` until the handler is removed. Local
  requests that carry proxy headers are refused with `loopback_proxy_refused`.
  Connect remote clients to the authenticated mesh TLS listener.
- **Some CLI and API output changed.** `scout session touched` and
  `scout diff session` take the exact session tuple
  `<native-session-id> --node <node-id> --harness <claude|codex|pi>`.
  `scout providers` JSON is `scout.provider-usage/v1`, one row per observed
  quota pool, and a missing observation reads `unknown`, not zero. A Scoutbot
  answerer must hold the runtime's answerer claim, or it is refused with
  `assistant_claim_required`.

### Run the core on its own

`scout runtimes`, `scout role`, the mission log, `scout diff`,
`scout session touched` and `scout providers` read the runtime's `/v1` routes.
The MCP session inventory, attachment reader and `herdr_workspaces` tool do the
same. None of them needs a web server or sends a browser cookie.
`scout completion zsh|bash|fish` prints tab completion from the live command
registry, installed extensions included.

On macOS, the runtime keeps the host from idle sleep while a local agent works,
and for 10 minutes after. The `caffeinate -i` hold ends with the runtime
process. Set `OPENSCOUT_KEEP_AWAKE=0` to turn it off.

### Give a tailnet guest access

`scout mesh guests list|grant|revoke` manages key-bound guest grants on the
runtime's host, through its local HTTP API. A grant names exact agent IDs and
expires within 30 days. `grant --json` prints the bootstrap file that
`scout-tailscale connect` imports. See [Direct guest grants](./mesh-guests.md)
and [Connect a Linux guest](./linux-tailnet-guest.md).

### Manage the mesh

Local-tier runtime APIs configure approval sharing, read cached Tailscale
diagnostics, ping a pinned peer, configure the bridge, and collect
consent-gated diagnostic reports. Revoking a peer's trust also withdraws its
approval sharing. See the [mesh management API](./mesh-management-api.md).

`scout mesh enroll ssh://host --tier observe` applies the tier on both hosts and
confirms it in the receipt. Hosts unseen for 7 days are dormant: `scout mesh`
status, doctor and nodes hide them, and `--all` includes them. Mesh calls
without a caller deadline time out after 2.5 s to connect, 10 s to response
headers and 12.5 s for a card probe. `scout mesh enroll --confirm-sas` accepts
a code that contains `yo-yo`.

### Extend the CLI

`scout` runs explicitly installed, trusted extensions. Built-in commands always
win, and a PATH executable never claims a verb.
`scout extensions install|update|remove` installs local prebuilt artifacts as
staged generations, with a prior generation kept for rollback. Conditional
flags such as `--expect-absent` and `--expect-tree-digest` fence concurrent
installers. `scout help <verb>` shows an extension's docs without running it.
The mesh bridge ships as the installable `mesh` extension. Installing it does
not replace the built-in `scout mesh` command. See [Extensions](./extensions.md).

### Pair a phone

A relay handshake no longer grants trust. A phone pairs only in an explicit,
single-use window that Show code, Start pairing or `scout pair` opens for at
most five minutes. A revoked phone that retries reaches only the reconnect room
and is refused. Approving a pairing request opens a private window bound to
that request, and to the phone's Noise key when the phone sends one. A
cancelled request stays spent, and a poll for a spent window gets HTTP 410.

A phone that finds the host through your account waits for the host owner's
decision. `scout pair requests list|show|approve|deny` shows and answers those
requests. Until approval, the phone gets no RPC, subscriptions or events.

Pairing trust has one owner. Pairing authority can move to a verified capsule
store whose reads stay fast on hosts with long pairing histories. The move is
an explicit local cutover, and normal startup does not migrate. See the
[pairing capsule cutover](./pairing-capsule-cutover.md) runbook. Revoking a
phone does not close a session that is already connected.

### Ask agents and follow replies

- ACP agents (Grok, Kimi, Cursor, Devin, OpenClaw and OpenCode) keep their
  messages apart. Narration before a tool call or plan update and the answer
  after it arrive as separate paragraphs.
- A Codex turn that fails, for example at model capacity, fails its flight but
  leaves a live session ready for the next ask. A session that an earlier
  failure marked offline returns to idle on its next ask when its app server
  is still alive. Codex input keeps flowing when its diagnostic log cannot be
  written.
- Blocked asks fail promptly. Asks that are still working stay alive after the
  requester's wait times out.
- The MCP server keeps one reply waiter per flight when a client retries an ask
  with the same request ID, and releases it on completion, failure or
  disconnect. A single-flight wait reads that flight through
  `GET /v1/flights/:id`, not the whole registry.
- `scout watch` keeps bounded correlation IDs instead of message bodies, so a
  long watch does not grow with traffic. Exact flight and message reads fall
  back to archived storage when the SQLite projection is disabled.
- Codex Tail finds history outside the discovery window, including Scout's
  background Codex store. Tail events can carry a classified `prompt`, redacted
  like summaries. Tail subscriptions keep every publication across the handoff
  from replay to live.

### Send images to the operator

`scout notify --image` and `scout operator --image` store the image as a
runtime blob bound to its message. The receipt no longer expires after six
hours; availability follows blob and message retention. An earlier runtime
refuses the write, and clients that display these images need blob support.
Authorized image reads accept up to 25 MiB.

### Runtime reliability

A retired SQLite projection worker can no longer crash the runtime. The
knowledge index publishes its schema in one transaction, and readers treat an
incomplete cache as empty until a writer upgrades it.

## 0.3.7 natural-language recipient discovery

The local MCP server exposes `route_context` and a `scout` prompt. An agent host
can interpret a roughly remembered recipient, inspect live mesh agents and
conversations alongside local indexed topic evidence, send clear matches through
`ask`, and clarify ambiguous matches. `scout locate` exposes the same discovery
primitive to CLI callers. Broker-issued conversation addresses preserve exact
cross-machine continuation; missing or capped coverage remains explicit.

See [Natural-language recipient routing](./natural-language-routing.md) for the
host-driven interpretation boundary, local-only history coverage, and installed
peer requirements. This package release does not publish a new native installer.

## 0.3.6 routing and historical context

Cross-host requests now carry their exact request-message anchor, including
when that message lives in historical storage. A remote reply completes the
originating request, and conflicting duplicate submissions are rejected rather
than silently changing the accepted request. Completed requests keep their original
flight receipt after rotation into historical storage, so a retry does not
create another execution. Explicit journal-only brokers retain their existing
request path.

The peer worker rechecks cancellation and shutdown after reading historical
context and immediately before forwarding. The packaged broker includes its
SQLite projection worker; its regression test verifies startup, incremental
replay, and restart with complete records intact. Source checks cover delayed
history reads, cross-host replies, and duplicate delivery identity. Publication
is followed by a separate installation check against the exact registry bytes.

Availability checks use each transport's receive evidence and the local
adapter's queue capability. Registered polling mailboxes can accept durable
work while their consumer is between polls; they do not depend on a tmux
process probe. Session execution still follows the broker's serialized owner
lane, and retired endpoints remain unavailable.

## 0.3.0 package review follow-up

This release makes an explicitly selected channel authoritative for message
routing, so body text such as scoped npm package names cannot prevent a channel
update. Claude catalog discovery now tracks pending persistence work and awaits
it during shutdown, so session catalog writes settle before shutdown completes.

The npm guide lists only the bundled CLI, broker/runtime, and basic web surface.
The retired `scout monitor` console is no longer advertised as installed; the
Rust TUI remains a separate optional installation.

Root `bun run test:unit` includes the dedicated CLI suite. Public CI runs those
tests as an explicit step before the source unit suite. Launcher tests build
fresh temporary JavaScript fixtures and isolate HOME, broker endpoints, sockets,
and service settings; they do not depend on existing `dist` output or package a
native supervisor. The signed tarball audit and isolated installed-package smoke
remain separate release gates.

## 0.2.110 source update

This release brings the reviewed CLI, broker, protocol, and web source updates
into the public package, including invitation previews and readable Scout Chat
feeds, participant inbox commands, clearer ask/status/wait receipts, and the
examples-first npm guide. Commercial support and plans link to
[OpenScout contact](https://openscout.app/contact).

Public-only publication tooling and MCP registry metadata remain authoritative.
The browser package still uses the basic Home, DMs, and Tail profile; the existing
exact tarball limits and excluded-feature checks apply unchanged. The public
Tail session fallback and isolated mobile catalog test are retained. Hosted
Worker parity checks stay in the private product repository; the exported client
behavior tests have no dependency on private Worker source.

## Local publication

### 0.2.109 basic web package footprint

The npm browser client now includes Home, DMs and Tail. World, Replay and
3D character studio assets are excluded. The exact tarball audit rejects the
character asset directory and full-app script markers, requires the basic
shell and emitted JavaScript, and rejects an unbuilt source entry. These checks
inspect the retained tarball itself, not just a successful local client build.

The build retains all 29 runtime crew portraits and eye patches and excludes
the crew preview page, source masters, runs, and QA trees. The tarball audit
still requires those runtime assets, the broker binary, and the server entries.
The reviewed dry-run candidate measures approximately 6.9 MB packed, 29.0 MB
unpacked, and 127 files. The existing total ceilings remain 26 MB packed,
60 MB unpacked, and 670 files; exact excluded-feature checks enforce this cut. The separate
1,024-byte limit on the legacy web-server entry still rejects a duplicated full
server bundle, regardless of total size. Every final candidate must pass the
exact tarball audit; this scope change does not waive signing, artifact checks,
or authorize incidental limit increases.

Use local publication only when the hosted workflow cannot run. After the
chosen version and source are reviewed and merged, run from a clean public
`main` checkout:

```bash
bun run ship -- <version>                                 # read-only plan; does not build
bun run ship -- <version> --execute --yes --local-publish # authorized local release
```

Execution never selects a version, bumps manifests, commits source, or starts
hosted jobs. It requires the canonical public origin, clean `main`, HEAD equal
to freshly fetched remote `main`, lockstep versions, and matching existing tags.
It creates/pushes the explicitly chosen tag only after registry preflight.
Versions through `0.2.90` are historical and cannot be published or promoted.

The publisher prepares and audits both exact tarballs once, including signed
`scoutd`, then atomically retains the candidates and integrity receipt under
`.git/scout-release/npm/<version>-<release-sha>/`. `--publish-prepared` publishes
those retained bytes without rebuilding. Preserve this bundle through registry
and GitHub verification. Receipts bind repository, source SHA, version,
authority, package SHA-256/SRI and sizes. New receipts explicitly record
`provenance: "none"` for local publication; the `local-signed` authority describes
signed artifacts, not npm OIDC provenance. Historical schema-1 receipts remain
readable through their bound authority.

Provide `NPM_TOKEN` or the local secret-store entry `OPENSCOUT_NPM_TOKEN` with
permission to publish both packages and update their dist-tags. The script uses
a private temporary npm configuration and removes it on exit. Local publication
explicitly disables npm provenance generation. It neither stores credentials in
receipts nor falls back to hosted credentials. Signed build prerequisites still
apply; do not bypass the binary signing gate.

When package policy requires interactive two-factor authentication, explicitly
select the operator's existing npm login instead:

```bash
npm login --registry https://registry.npmjs.org # establish a login separately
bun run ship -- <version> --execute --yes --local-publish --auth npm-login
```

Run this mode in an interactive terminal so npm can present browser or OTP
challenges. It verifies the existing login with `npm whoami` and inherits npm
configuration and terminal input/output. It does not read, copy, or write
credentials, or fall back to another authentication mode. `NPM_TOKEN` and
`NODE_AUTH_TOKEN` must be unset; hosted execution rejects this mode.

Without a terminal for npm to prompt in, name a command that prints a fresh
one-time code in `SCOUT_NPM_OTP_COMMAND`. The publisher runs it immediately
before each npm write and passes the code to that write only, as
`npm_config_otp`. It never prints the code. One code cannot cover a whole
release: a code lasts about 30 seconds, and the publisher waits for registry
propagation between writes.

```bash
SCOUT_NPM_OTP_COMMAND='<command that prints a code>' \
  bun run ship -- <version> --execute --yes --local-publish --auth npm-login
```

The publisher calls no secret-store helper unless you name one this way.

The lower-level publisher accepts `SCOUT_NPM_AUTH_MODE=npm-login`.
Default and `@openscout` scoped registries are pinned to npmjs for every package
read and mutation, including when the inherited login has a different scope registry.
Token authentication remains the default, and both local modes retain the same
source, signing, artifact, receipt, staging, and promotion gates.

Local publication uploads protocol and Scout under a version-specific staging
tag, verifies both against retained candidates, and only then promotes the pair
to `latest`. A fresh release must advance the current versions and begin with
both package versions unused. A matching completed release is idempotent. A
complete immutable pair may resume missing dist-tag promotion only with its
exact retained receipt. A retained bundle for the current HEAD marks a local
release already in progress: finishing a pair that is already on npm does not
need `--local-publish`, but uploading either package still does.
The ordinary publisher still rejects a partial local pair. A protocol-first
local interruption may use the explicit retained recovery command below. Changed
artifacts, wrong source, missing receipt, foreign authority, and historical
candidates remain forbidden.

After registry verification succeeds, the command creates or verifies the final
public GitHub release, without marking it Latest, and attaches `receipt.json`. Existing receipts are never
clobbered: their size and anonymously downloaded SHA-256 must match the retained
receipt. An upload command succeeding alone is not a verified release.

## List the release in the MCP Registry

The official MCP Registry lists `io.github.openscout-app/scout`. Each registry
version names one exact `@openscout/scout` npm version, so each stable release
gets its own registry version.

- `bump-version.mjs` writes the release version into `packages/cli/server.json`,
  both as the server version and in its npm package entry. The ship command
  and the hosted npm workflow refuse a `server.json` that does not match.
- A stable GitHub release starts `publish-mcp-registry.yml` when it is
  published or when a candidate prerelease is promoted to stable. The workflow
  waits until npm lists the exact version with its `mcpName`, signs in to the
  registry with GitHub OIDC, and publishes `server.json`. It uses no stored
  credential.
- The hosted npm path creates its GitHub release in `release-scout-tui.yml`
  with the workflow token. That token starts no release-event workflow, so the
  same job dispatches `publish-mcp-registry.yml` for each stable version.
- Prereleases, drafts and dev versions are skipped, including on a manual run.
  A version that the registry already lists is left unchanged, so a rerun is
  safe.

To publish or retry one release by hand:

```bash
gh workflow run publish-mcp-registry.yml -R openscout-app/scout -f tag=v<version>
```

## Validate a candidate before promotion

A local release normally uploads and promotes in one command. For releases that
require a real installation pass before changing npm `latest`, explicitly split
candidate publication from promotion:

```bash
# From clean reviewed public main already versioned at the exact unused version.
# Run in an interactive terminal using the operator's existing npm login.
bun run ship -- <version> --phase candidate --execute --yes --local-publish --auth npm-login

# Install the exact published version and validate the retained candidate.
# After operator approval of that result, promote the same source and bytes.
bun run ship -- <version> --phase promote --execute --yes --auth npm-login
```

Promotion and retained-candidate finalization finish an upload that already
happened, so they do not need `--local-publish`.

Candidate mode establishes the ordinary `v<version>` tag at the reviewed public
source, prepares the exact signed pair once, and publishes both under the existing
`scout-release-<version-with-dashes>` staging tag. It verifies the complete pair
and staging tags, then creates or verifies a non-draft GitHub **prerelease** with
`--latest=false`. It uploads `candidate-receipt.json`, clearly labeled
`scout-npm-candidate` / `CANDIDATE`, binding the public source SHA, version,
local authority, staging tag, both package measurements and the SHA-256 of the
original integrity receipt. The ordinary `receipt.json` stays in the retained
bundle until promotion. Candidate mode changes neither npm `latest` nor GitHub
Latest; an exact version remains installable from npm for candidate validation.
A candidate retry reuses the same bundle and verifies an existing public marker;
it never rebuilds, overwrites conflicting assets, or relabels a stable release.

Keep the original bundle, tag and candidate marker throughout validation.
Promotion requires that same source on clean public `main` equal to freshly
fetched remote `main`; if main has moved, stop rather than rebuild or infer a
new candidate source. It verifies the original local bundle, exact tag, the
anonymously downloaded public candidate marker and complete immutable registry
pair before changing a dist-tag. It performs no package build or npm upload.
Only then does it promote both npm `latest` tags, verify them, finalize the same
GitHub release as stable with `--latest=false`, and attach the unchanged ordinary
`receipt.json`. The candidate marker remains as historical validation identity.
An interrupted promotion can verify already-promoted members and finish the
remaining promotion/metadata without replacing bytes. An existing stable/native
release's GitHub Latest state remains untouched by a completed retry.

The public candidate release can retain a separately verified native DMG through
an explicitly authorized operator handoff. That handoff must preserve the exact
signed/notarized artifact, its private source/dependency receipt and public byte
verification; it is not performed by the npm publisher. Candidate creation does
not satisfy private native stable-promotion guards. After validation and public
package promotion, the existing native owner can verify the ordinary stable
receipt and promote GitHub Latest separately. Appcast/site publication remains
another verified follow-up.

The lower-level local modes are `ship-npm.sh --publish-candidate`,
`--verify-candidate`, and `--promote-prepared`. They require the exact retained
bundle and clean matching public source/tag. `--publish-candidate` verifies the
pair and exits before npm promotion; `--promote-prepared` requires the complete
published pair and never builds or uploads a missing package. These modes reject
hosted execution. `--verify-candidate` accepts an exact staging tag or an
already-promoted member so explicit promotion retries can complete safely.
The top-level candidate/promotion commands additionally enforce the public
candidate marker and GitHub release metadata.

A partial candidate upload stops the ordinary candidate command. Preserve the
original bundle and registry evidence; resume only with the explicitly reviewed
candidate-only retained recovery below. It can upload only the missing original
Scout tarball under the staging tag and stops before either Latest channel.
The ordinary local recovery command refuses a local candidate marker or GitHub
prerelease, because its promoting behavior would bypass installation validation.
Candidate mode never invokes recovery automatically.
If installation validation fails, preserve the published immutable bytes,
receipts and held staging tag. Fix the source through review and select a new
explicit unused version for the next candidate; never rebuild or replace the
failed version, roll it back, or promote it through partial-pair recovery.
The default full release command refuses to finalize a retained candidate
prerelease; use explicit `--phase promote` after validation. Wrong source,
tampered/missing markers or bundles, changed staging tags, incomplete package
pairs and newer `latest` versions stop promotion before mutation. No private npm
publisher, automatic hosted fallback, rollback or credential-storage behavior
is added by these phases.

### Recover and finalize the original held candidate

Recovery tooling may be reviewed and merged after the candidate's source. Keep
the candidate identity separate from that newer tooling commit. From clean
canonical public `main` equal to freshly observed remote `main`, supply the
original source SHA, integrity-receipt SHA-256 and candidate-receipt SHA-256.
Read these digests from the preserved files before execution; do not reconstruct
or rewrite a missing marker. Both original local and remote version tags must
still match the source, which must be an ancestor of the reviewed tooling.
`SCOUT_NPM_RELEASE_STATE_DIR` is refused for these retained operations.

```bash
# 1. Complete only the missing exact staged Scout artifact. Omit --execute/--yes
#    for a read-only plan; use an interactive terminal for existing npm login.
node scripts/recover-local-npm-release.mjs \
  --version <version> --source <original-source-sha> \
  --receipt-sha256 <original-receipt-sha256> \
  --candidate-receipt-sha256 <original-candidate-receipt-sha256> \
  --phase candidate --execute --yes --auth npm-login

# 2. Verify the complete pair and finalize its original prerelease/marker only.
bun run ship -- <version> --phase candidate \
  --source <original-source-sha> --receipt-sha256 <original-receipt-sha256> \
  --candidate-receipt-sha256 <original-candidate-receipt-sha256> \
  --execute --yes --auth npm-login

# 3. Install and validate the exact npm/native candidate before approving promotion.

# 4. Explicitly promote that same complete candidate after successful validation.
bun run ship -- <version> --phase promote \
  --source <original-source-sha> --receipt-sha256 <original-receipt-sha256> \
  --candidate-receipt-sha256 <original-candidate-receipt-sha256> \
  --execute --yes --auth npm-login
```

Unset `NPM_TOKEN` and `NODE_AUTH_TOKEN`; do not carry credential-free npm config
overrides from a source audit into publication. Candidate recovery verifies
source package identities, the original receipt, both retained tarballs and the
exact marker digest and semantics. It requires protocol already staged, one
unchanged older `latest` baseline for both packages, and verified registry
metadata plus anonymously downloaded tarball bytes from the pinned public
registry without following registry redirects. Only a structured exact-version
E404 proves version absence; empty successful responses and unknown errors fail
closed. Changed markers/tags/bytes, a foreign authority/repository, CLI-first
state or an already/newer promoted version stop before mutation.

Only the missing retained Scout tarball can be uploaded, with lifecycle scripts
disabled and local provenance disabled. The tool waits for both its exact bytes
and staging tag to become observable, preserves both receipts and the older
Latest baseline, and never mutates a dist-tag in candidate mode. A complete
staged pair skips upload and authentication. During bounded post-upload polling,
an exact registry record can precede canonical tarball availability: only an
HTTP 404 at the verified tarball path is treated as pending. Finalization and
promotion still require every byte to match. A failed mutation performs one
read-only state observation and reports exact bytes observable or an unknown
upload outcome; a version not yet observable does not prove rejection. It never
retries automatically or changes authentication. Preserve uncertain outcomes
and inspect them before an explicitly authorized retry.

Retained finalization and promotion never build, pack, upload a missing npm
package, recreate a tag, or call the HEAD-bound publisher. They read all version
sources from `git show <original-source-sha>:...`, locate the bundle under the
Git common directory using that source, and leave its marker bytes unchanged.
Candidate finalization creates/verifies a non-draft prerelease with
`--latest=false` and the original public marker. Promotion requires that public
marker byte-for-byte before changing npm `latest`, including when the lower-level
recovery command is invoked directly with `--phase promote`. It verifies the complete
pair before each tag change and attaches the unchanged ordinary receipt while
finalizing GitHub metadata with `--latest=false`. Native GitHub Latest and
appcast/site updates remain separately owned gates.

## Recover a retained local release

If npm accepts protocol but it becomes visible only after the publication wait
expires, keep the original signed candidate bundle. Do not rebuild it or bump a
version solely because registry propagation exceeded the wait. The ordinary
publisher still rejects partial local state; recovery is a separate explicit
command in reviewed public tooling (see [issue #23](https://github.com/openscout-app/scout/issues/23)).
This ordinary promoting path is for an unmarked stable release only. A local
`candidate-receipt.json`, a GitHub prerelease, or unknown GitHub release state
refuses execution; use the explicit held-candidate sequence above instead.

The recovery tooling can be merged after the candidate: run it from clean public
`main` equal to remote `main`. Supply the **original** release SHA and original
receipt SHA-256, not the tooling commit. The original local and remote version
tag must still resolve to that source, and the source must be an ancestor of the
reviewed tooling. The command locates the bundle in the shared Git directory at
`scout-release/npm/<version>-<original-source-sha>/`; it does not accept a rebuilt
bundle or an alternate state-directory override.

```bash
# Inspect and record the original receipt digest before requesting execution.
shasum -a 256 .git/scout-release/npm/<version>-<original-source-sha>/receipt.json
node scripts/recover-local-npm-release.mjs \
  --version <version> --source <original-source-sha> \
  --receipt-sha256 <original-receipt-sha256>

# After review and explicit authorization, use the operator's existing npm login.
# Run in an interactive terminal so npm can present any browser/OTP challenge.
node scripts/recover-local-npm-release.mjs \
  --version <version> --source <original-source-sha> \
  --receipt-sha256 <original-receipt-sha256> \
  --execute --yes --auth npm-login
```

Authentication is the operator's existing local npm configuration, including a
browser login established with `npm login` separately. Recovery calls `npm
whoami` and inherits terminal input/output for mutations; it never logs in,
reads or writes credential files, copies tokens, invokes secret-store helpers,
or falls back to hosted authority. Local provenance remains disabled.

Recovery verifies the receipt's repository, source, version, local authority,
and both tarballs' size, SHA-256, SRI, and package manifests before proceeding.
Registry protocol must already match those exact values and its staging tag or
`latest`; CLI-first state, an absent protocol, unknown registry errors, newer
`latest`, and split older baselines fail closed. It can upload **only** the
missing retained CLI tarball, with lifecycle scripts disabled. Both immutable
artifacts must match before either `latest` tag is changed. An exact complete
pair can resume an interrupted promotion without re-uploading anything.

The command holds the same candidate lock as the ordinary publisher and
preserves the original receipt. It waits up to 15 minutes for registry
propagation (`--wait-seconds` accepts 5–3600). A timeout or uncertain upload does
not cause an automatic upload retry: retain the bundle and rerun the identical
command after checking registry state. A later-visible matching CLI is verified
and skipped. Versions through `0.2.90` remain frozen. Staging tags are left as
harmless recovery evidence. GitHub release creation and attaching/verifying the
original receipt remain separate steps after the pair succeeds.

## Hosted publication

Stable releases publish this way. After the reviewed release merges to public
`main`, tag the tip of `main` and dispatch the public `release-package-npm.yml`
workflow before anything else merges. The workflow requires the tag to resolve
to the commit that `main` points at when you dispatch:

```bash
git fetch <public remote> main
git tag -a v<version> FETCH_HEAD -m "Scout <version>"
git push <public remote> refs/tags/v<version>
gh workflow run release-package-npm.yml --repo openscout-app/scout --ref main \
  -f tag=v<version> -f npm_tag=latest
```

The hosted path has no candidate hold: it publishes straight to npm `latest`.
A release that must be validated before `latest` uses the local candidate
sequence above, with `--local-publish`, and has no npm provenance.

The workflow verifies its canonical workflow identity and refuses token
authentication. There is no automatic transition
between local and hosted authority; retained receipts cannot cross authorities.
The hosted path uses npm trusted publishing/OIDC and these signing secrets:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_P12_PASSWORD`
- `MACOS_RELEASE_KEYCHAIN_PASSWORD`
- `OPENSCOUT_SIGN_IDENTITY`
- npm trusted publishing for
  `openscout-app/scout/.github/workflows/release-package-npm.yml`

The workflow explicitly refuses `v0.2.90` and older. Dispatch
`release-package-npm.yml` for an already-reviewed public `v0.2.91` or later tag
and wait for it to verify both packages. Before its first npm mutation, the
workflow builds and audits both exact tarballs, writes their durable receipt,
and uploads the complete candidate bundle as a run artifact. The candidate
bundle and final receipt use distinct artifact names: the former is recovery
state containing both immutable tarballs and their receipt, while the latter is
publication evidence uploaded only after registry verification.

GitHub OIDC publishes protocol first and Scout second, directly to `latest`; it
never invokes `npm dist-tag`. That dependency-safe ordering gives consumers a
valid protocol before the CLI that consumes it appears. npm may keep an accepted
upload in processing for several minutes, so the workflow waits for up to ten
minutes per immutable upload before failing closed.

Recovery is explicit and deliberately narrow. If a run stops after publishing
only protocol, dispatch the same reviewed tag again with `recovery_run_id` set
to that failed workflow run. The new run downloads the prior run's exact
candidate bundle before preparation. It first proves that the prior run used
this exact workflow on `main` for the same release commit, ended unsuccessfully,
and owns exactly one live artifact with the expected version-and-SHA name. It
then verifies the receipt and both retained tarballs byte-for-byte, and may
publish only the missing Scout tarball when the registry is the exact
protocol-first prefix: protocol matches the retained SRI, public commit,
repository, version, and `latest`, while Scout does not yet exist. A missing or
foreign `recovery_run_id`, a rebuilt candidate, Scout-first state, a mismatched
artifact, a different partial prefix, or a complete unpromoted set fails closed
and requires a fresh version.

After both packages match the retained candidates and reach `latest`, the
workflow performs a separate registry-verification pass and uploads the final
integrity receipt. Attach that receipt to the GitHub release only after the
package set succeeds. Do not weaken the signing gate or publish a GitHub release
before that verification completes. When the run succeeds,
`release-scout-tui.yml` attaches the terminal UI archives and creates the GitHub
release if it does not exist, without marking it Latest.

## Verify

After publication, verify that the git tag, both manifests, npm versions,
dist-tags, package repository metadata, and public source commit agree. Install
the packed CLI in an empty directory and exercise `scout --version`, setup,
runtime health, and operation without an app or web client. A partial or mismatched publication
is not promoted as a successful release.

## Hosted dev channel (dogfood prereleases)

`release-package-npm.yml` also accepts `npm_tag=dev`, **only** with a reviewed
`vX.Y.Z-dev.N` tag. `latest` still accepts only plain `vX.Y.Z`. Both public
packages publish directly to `dev` using the same Production signing configuration
without recording a stable Production deployment. They retain the same signing, OIDC, canonical main/SHA/reachability, retained candidate, integrity,
and recovery gates. No dev command updates `latest` or invokes `npm dist-tag`.
Local stable/candidate/promotion/recovery commands remain stable-only; do not
use `bun run ship` for a dev release. The publisher rejects dev rollback and a
dev version not newer than stable; it checks that stable tags remain unchanged
within each run. Protocol-first recovery uses the selected `dev` tag and the
original failed run's exact bundle, not a rebuild.

The existing `scout-release-0-3-3` through `scout-release-0-3-5` tags are **held
local stable-number candidates**, not a dev channel. They were produced by the
local two-phase candidate path (`--phase candidate`, with retained recovery
where needed), deliberately stopping before promotion. In particular, the
[v0.3.5 release record](https://github.com/openscout-app/scout/releases/tag/v0.3.5)
records local-signed artifacts, a blocked first-run preservation check, and
`latest` held at 0.3.2. Do not relabel/promote those historical candidates.
A new dev channel does not approve their onboarding or waive that blocker.

### Cross-host replies in 0.3.6-dev.4

A `scout ask --on <host>` now completes on the asking machine when the remote
agent replies. The remote broker records the reply against the forwarded
invocation and returns it, so `scout wait` reports `completed` instead of
staying `running`. An exact machine name wins over a prefix match, conflicting
duplicate deliveries are refused, and forwarded bundles are checked against the
persisted invocation before they apply. The broker bundle ships its SQLite
projection worker.

### Cross-host asks in 0.3.6-dev.3

`scout ask --on <host>` (MCP `on`) starts or reaches an agent on another of
the operator's machines through the broker. Names that match more than one
machine are refused; the node id picks one. `scout hosts` (MCP `hosts_list`)
lists machines and the projects each one serves, `scout where` shortlists
routes, and `scout check` shows live work by topic or machine. `scout setup
agents-md` and `scout setup permissions` help other agents find Scout.
Linux hosts advertise a local edge over Avahi, and forwarded invocations are
kept in the broker's SQLite projection. The basic client keeps 0.3.6-dev.2's
sidebar, Lanes and Tail, and terminal toolbar, and adds Sessions.

### Shared navigation in 0.3.6-dev.2

The basic npm client uses the shared sidebar for Home, Chat, Terminals, Broker,
Search, Ops, and Settings. Ops includes Lanes and Tail; full-shell workspaces
and the 3D floor/studio remain excluded. Work and follow links retain their
routes. Terminal controls share one toolbar; a single shell fills the browser
workspace and existing sessions are available through Add existing. The package
audit checks full-view implementation markers rather than
shared navigation labels, and allows the terminal client required by Terminals.
Linux and macOS npm installs serve the same basic web bundle; a running server
must be restarted after an upgrade to serve the new installed assets.

### Repeatable cut

Use a clean public checkout after this workflow change has merged. Choose an
explicit unused version: e.g. `0.3.6-dev.1` for the next base after 0.3.5,
then `0.3.6-dev.2`. Inspect registry versions first; never reuse an accepted
version. The existing bumper now supports this exact prerelease shape and
numeric ordering (dev.10 > dev.9, stable > dev on the same base).

```bash
# Prepare a review branch. This bumps ALL lockstep manifests, not just the CLI.
VERSION=0.3.6-dev.1
bunx npm view @openscout/scout versions --json
bunx npm view @openscout/protocol versions --json
git switch main
git pull --ff-only
git switch -c "release/v${VERSION}"
bun scripts/bump-version.mjs "$VERSION"
bun install
bun run check
bun run test:unit
NPM_TAG=dev GITHUB_ACTIONS=true bash scripts/ship-npm.sh --dry-run
# Review the version-only diff; commit only bumper/install output.
git add package.json packages/*/package.json \
  packages/cli/src/lib/shared/product.ts docs.json bun.lock
git commit -m "🔖 Prepare v${VERSION} dev release"
git push -u origin HEAD
gh pr create --repo openscout-app/scout --base main --title "🔖 Prepare v${VERSION} dev release" \
  --body "Lockstep dogfood prerelease; publish only to dev after review."
```

After that version PR is reviewed and merged, and publication is explicitly
approved, run the following from clean public main. The tag **must equal the
main dispatch SHA**, not merely an older ancestor; if main moves before dispatch,
stop and prepare a new reviewed version rather than weakening that guard.
These are operator instructions, not an automatic publish script:

```bash
VERSION=0.3.6-dev.1
git switch main
git pull --ff-only
test -z "$(git status --porcelain)"
test "$(bun -p 'require("./packages/cli/package.json").version')" = "$VERSION"
git tag -a "v${VERSION}" -m "Scout ${VERSION} dev"
git push origin "refs/tags/v${VERSION}"
gh workflow run release-package-npm.yml --repo openscout-app/scout --ref main \
  -f tag="v${VERSION}" -f npm_tag=dev
# After successful artifact + registry verification:
bunx npm view @openscout/scout dist-tags --json
bunx npm view @openscout/protocol dist-tags --json
bun add -g @openscout/scout@dev
scout --version
```

The bumper keeps workspace versions and pinned first-party dependencies in
lockstep. Packing resolves `workspace:*` to the exact prerelease (and
`workspace:^`/`~` to ranges including that prerelease); workspace devDependencies
are removed, and the CLI bundles its runtime. Protocol is uploaded first, so
any shipped first-party dependency is available before Scout becomes visible.

### npm.openscout.app recommendation

Use a tiny static landing on the **existing openscout.app site deployment**,
not a registry/proxy. Show `bun add -g @openscout/scout@dev` and fetch the current
version anonymously from `https://registry.npmjs.org/@openscout%2fscout/dev`.
Show “No dev release yet” on 404 and “Version unavailable” on network failure;
keep the install command visible. An optional stable link can point to npmjs.com.
The public repository has no existing site deployment to extend, so this change
adds no landing, DNS, domain binding, or infrastructure. The site owner can add
that page and bind npm.openscout.app only after operator approval. A redirect
alone to npmjs.com is simpler but cannot show the requested dev install command
and live version together.

## Reconcile an already-published production release

Use `Verify Production Release` when an existing stable publication needs fresh
production evidence, including a completed local publication with no hosted
receipt. This is a read-only reconciliation, not a new publication. It requires
an explicit stable version that is currently `latest` for both packages and a
final public GitHub release carrying the original `receipt.json`.

```bash
gh workflow run verify-production-release.yml --repo openscout-app/scout --ref main \
  -f version=0.3.8
```

The workflow checks the original release tag/source against public main, verifies
both registry metadata records and downloaded tarballs against the exact original
receipt, installs the verified CLI in an isolated directory with lifecycle scripts
disabled, checks its version/help, then rechecks stable pointers. It retains the
byte/source and install evidence. It cannot publish, move npm tags, replace
artifacts, or confer OIDC provenance on a local release. A passing Production job
means this exact stable distribution was verified; it does not mean existing
clients were upgraded or native apps were rebuilt.

GitHub Latest remains the native download pointer until a newer verified stable
DMG is available. Package-only GitHub releases must not displace it. npm and native
versions may therefore differ; inspect the native appcast and DMG assets separately.

Dev npm jobs retain access to Production signing configuration but explicitly
opt out of creating Production deployment records. Only `npm_tag=latest` creates
a stable publication deployment. TUI-created prerelease tags are marked as GitHub
prereleases and never become Latest.

Publication verification polls explicitly revalidate npm's cached registry data.
Missing versions and transient network/registry errors are retried within the
bounded propagation window; permanent errors fail immediately and timeout output
preserves the last diagnostic. An accepted upload is never automatically repeated.
Retain its exact candidate bundle and inspect registry state before using the
existing recovery path. A historical log that discarded npm stderr establishes
only a visibility timeout, not its underlying registry cause.
