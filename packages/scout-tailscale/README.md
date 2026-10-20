# scout-tailscale

Direct, owner-approved guest access to an owner's Scout machines over a
private network (Tailscale). The client holds an Ed25519 key; the owner approves the matching
code in Scout on their Mac, which installs a scoped grant on its own broker.
Every request is signed and sent over TLS pinned to the node's signed card.
Hosted profile mode coordinates pairing and discovery; agent tasks and replies
travel directly to the approved machine. Out-of-band bootstrap mode needs no
hosted Scout service: the owner installs a grant locally and shares the signed
bootstrap, while the guest verifies the node key independently.

Protocol: `scout-guest/1`. This standalone client is MIT-licensed; see [LICENSE](LICENSE).

Guest asks are recorded in the guest identity's private Scout conversation
with the permitted target. The target's normal threaded reply completes the
request; the guest can retrieve only its own request's result, not browse the
conversation or other broker records. Repeated submissions reuse the same
request and message. Queued retries recheck grant validity before proceeding.

## Install

Source release candidate: **0.3.2, not published by this change**. See
[CHANGELOG.md](CHANGELOG.md) and the maintainer [release checklist](RELEASE.md).
A version bump or local build is not evidence that a public release exists.
No candidate download URL is asserted here. Obtain the reviewed wheel and
checksums through a trusted channel until maintainers publish a release.
This pilot client uses its own version, not the main Scout version. Do not
install a similarly named PyPI/npm package or replace the full `scout` CLI.

Requires macOS or Linux and Python 3.11+. The only runtime dependency is
`cryptography>=42,<51`. Never use sudo pip or `--break-system-packages`.
Check the release's exact requirements and artifact identity before installing.
Checksums verify bytes, not the identity of an untrusted checksum publisher.

Before upgrading, check `command -v scout-tailscale` and
`scout-tailscale --version`. Keep the existing environment, `SCOUT_TAILSCALE_HOME`,
identity, pins and proxy settings. Installing the client does not pair or grant
access. For a fresh installation from reviewed local files:

```sh
shasum -a 256 -c SHA256SUMS &&
uv tool install ./scout_tailscale-0.3.2-py3-none-any.whl &&
scout-tailscale --version
```

If uv is unavailable, use a dedicated virtualenv:

```sh
shasum -a 256 -c SHA256SUMS &&
python3 -m venv "$HOME/.local/share/scout-tailscale" &&
"$HOME/.local/share/scout-tailscale/bin/python" -m pip install --only-binary=:all: ./scout_tailscale-0.3.2-py3-none-any.whl &&
"$HOME/.local/share/scout-tailscale/bin/scout-tailscale" --version
```

Use the executable's full path if its directory is not on PATH. The Linux
admission and no-hosted-service guide is
[here](https://github.com/oscout/scout/blob/main/docs/linux-tailnet-guest.md);
ship those instructions only after their CLI prerequisites are merged.

## Without hosted pairing

On the guest, run `scout-tailscale --json key` and share only `publicKey`.
The owner installs a grant using a runtime-local admin client, for example
`scout mesh guests grant` in a Scout build containing that command, and exports
its bootstrap as JSON. This command is not in Scout 0.3.9. Verify the node key
through a separate trusted channel, then import the owner's file:

```sh
scout-tailscale connect --bootstrap grant.json --node-key '<verified-node-key-id>' --endpoint '<advertised-https-endpoint>' --proxy direct
scout-tailscale who
```

The bootstrap must include `bootstrap`, `allowed_targets`, and `expires_at`.
The runtime must already expose its authenticated mesh TLS endpoint on the
private network. Never expose privileged loopback through Serve or Funnel.
Bootstrap import verifies the signed card, pins TLS, and requires a signed
reachability probe before reporting connected. It neither enrolls a Tailscale
node nor creates a Scout grant. No hosted payload or bootstrap fallback occurs.

## Hosted profile mode

For this separate mode, the owner needs Scout running on the destination Mac and a published
`oscout.net` profile with assistant requests enabled. Replace `<owner>` with
that profile's handle. The owner approves the matching code and permitted
agent IDs on that Mac; Tailscale reachability alone does not grant access.

```sh
scout-tailscale connect --owner "https://oscout.net/<owner>"
scout-tailscale doctor
scout-tailscale who
scout-tailscale ask --to <target-returned-by-who> "Identify your project. Do not edit files." --wait 120
scout-tailscale wait <requestId>
scout-tailscale ask --resume <requestId>     # after a lost response: same id, never a duplicate
```

Use the direct tailnet connection when available. For an environment that
already uses a tailnet tunnel proxy, preserve `SCOUT_TAILSCALE_PROXY` or pass
the approved proxy with `--proxy`; do not substitute an ordinary public proxy.

`doctor` checks the pinned connection, signed node card, grant, and registered
permitted targets separately. If the grant passes but no approved targets are
registered, the owner must restore the intended agent or approve a current one.
Reinstalling the client, replacing its key, or logging into the hosted gateway
does not restore that destination. A completed `ask` reply is the final setup
check; successful connection and discovery do not prove execution.

**Machines.** Each Mac grants access on its own. Run `connect --owner` again
to request another machine; the owner picks it by approving in Scout on that
Mac. Then:

```sh
scout-tailscale machines          # every approved machine: availability, agents, tailnet status
scout-tailscale use laptop        # remember where new asks go
scout-tailscale ask --to fixture.echo --machine mini "..."   # choose (and remember) for one ask
```

`machines` reads the owner's directory at `oscout.net/<owner>/directory` with a
request signed by this client's key. The directory lists only machines that
approved this key, with their node-signed bootstraps; it never shows the
owner's other machines. Each machine is then probed with a pinned, signed
request. **available** means that probe succeeded. Other statuses are
unreachable, grant_inactive, pin_mismatch, revoked, revoking, and expired.

If the `tailscale` CLI is present (set `$SCOUT_TAILSCALE_TAILSCALE` to use a
different command or socket), its peers are shown as hints. A peer that
matches a machine's signed endpoint shows as online or offline on the
tailnet. Any other device is listed as "Scout not verified": being missing
from this key's directory says nothing about whether Scout runs there. You
never type IP addresses or ports.

A new ask goes to the first match below:

- the machine you name with `--machine` (remembered);
- your remembered machine, if its grant allows the agent;
- the only approved machine whose grant allows the agent;
- among several such machines, the only one that answers.

If several machines qualify and none answers, `ask` exits 1 with
`no_reachable_machine`. If several answer, it exits 2 with
`machine_choice_required`; both list the candidates. An explicit or remembered machine that is offline fails
there; the ask never moves elsewhere.

Every ask is journaled with the machine, node key and grant it was sent under.
`wait` and `--resume` go back to that machine only. If that grant is gone
(for example, the machine was revoked and approved again), they exit 4 with
`original_grant_gone` rather than start a second ask under the new grant.
Asks journaled by 0.1 recorded no machine. On upgrade they are bound to the
0.1 machine and grant when those are known; otherwise they exit 4 with
`unbound_ask` and are never sent anywhere.

**Proxy.** Node traffic uses only the proxy you name — `--proxy` (saved) or
`$SCOUT_TAILSCALE_PROXY` (`direct` forces none). Ambient `HTTPS_PROXY` is
ignored for node traffic because it is often the public egress path, not the
route into the tailnet. Hosted pairing calls to oscout.net use the ambient
proxy and normal CA validation. Only HTTP CONNECT proxies are supported; the
pin is checked end to end through the tunnel, so a TLS-inspecting proxy fails
closed with exit 3 and nothing is sent.

`connect` reports connected only after a signed request is accepted over the
pinned connection; otherwise it saves the pairing, says it is not connected,
and exits non-zero.

Exit codes: 0 ok · 1 failure · 2 usage or machine choice required · 3 TLS pin mismatch ·
4 not paired, grant inactive, or the ask's original grant is gone or unknown.
`--json` output never contains the private key, device code or proxy credentials.

State (owner-only, 0700/0600): `$SCOUT_TAILSCALE_HOME`, else
`$XDG_CONFIG_HOME/scout-tailscale`, else `~/.config/scout-tailscale`.

## Uninstall

Revoke the client grant on each owner machine when access should end. Removing
the executable or running `disconnect` does not revoke broker-side access.

For a uv installation, run `uv tool uninstall scout-tailscale`. For a dedicated
virtualenv, remove only the environment used for this client after confirming
its path. Keep the pairing state if reinstalling; run `scout-tailscale disconnect`
before uninstalling only when you also intend to remove the local pairing state.
Leave Tailscale and any separate hosted Scout client installed.

## Integration fixture (no live broker)

`fixture/guest-fixture.ts` serves the real runtime guest gate and routes with
temporary state, its own node key and TLS identity, and one harmless agent,
`fixture.echo`, that replies deterministically. Enrollment uses only the
client's public key:

```sh
# owner machine
bun fixture/guest-fixture.ts serve --host <tailscale-ip> --port 43191 --advertise https://<magicdns-name>:43191
# client:  scout-tailscale key            -> send the public key to the owner
bun fixture/guest-fixture.ts grant --public-key <base64> --out claim.json   # owner, loopback admin
# client:  scout-tailscale connect --bootstrap claim.json --node-key <nodeKeyId from the owner> --proxy <tunnel|direct>
#          scout-tailscale ask --to fixture.echo "hello" --wait 30
```

`tests/test_fixture_e2e.py` runs the same flow on loopback.
`tests/test_discovery_e2e.py` runs two fixtures ("mini" and "laptop", each
with `--label`, `--agents` and its own `grant --targets`) against a stand-in
directory and a fake tailnet listing. It covers discovery, automatic and
explicit choice, remembered machines, offline behaviour, and resume across
revoke and re-approval.

## Develop

```sh
uv venv && uv pip install -e .
.venv/bin/python -m unittest discover -s tests -v
bun tests/vectors/generate-card.ts > tests/vectors/node-card-v1.json   # regenerate the card vector
```

`tests/vectors/` holds vectors produced by the TypeScript runtime; the Python
signer and card verifier must match them byte for byte.


### Receive Scout assignments

The client can attach a native assistant conversation to the broker's existing
external-session mailbox. The broker derives its owner from the signed guest
grant; the caller cannot choose another owner or provider connection.

```sh
scout-tailscale --json session attach --machine "My Scout" --native-session "my-conversation"
scout-tailscale --json session poll --session <returned-session>
scout-tailscale --json session ack --session <returned-session> --delivery <delivery>
scout-tailscale --json session reply --session <returned-session> --delivery <delivery> --body-file reply.txt
```

Send a tracked Scout ask to the returned exact session address. Polling retrieves
that assignment; acknowledgement records receipt without completing it. Replying
completes the original flight and conversation. Repeating an identical reply is
idempotent; replacing a reply with different text fails. Poll again for follow-ups.

There is no automatic wake: a host may need a short native-chat nudge to check
its mailbox, but assignment content and replies travel through Scout. The saved
session binds to its original machine, node identity, and grant regardless of
later machine preferences. Revocation/expiry denies every mailbox operation;
reapproving the same key creates a separate mailbox and does not restore access
to the revoked grant's history. The broker remains the canonical writer.

For an isolated private pilot broker, `OPENSCOUT_MESH_TLS_TAILSCALE_ONLY=1`
restricts mesh TLS listeners to a detected Tailscale IPv4 interface. If it is
absent there is no remote listener; the broker does not fall back to LAN. This
setting does not grant access or enroll a guest.
