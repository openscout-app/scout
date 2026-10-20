# Connect a Linux guest directly to Scout

A Linux VM can reach one owner's runtime over Tailscale without a hosted
Scout service. It needs two separate permissions: restricted network access
and a key-bound Scout guest grant. Do not install a Scout runtime on the guest.
This guide uses out-of-band bootstrap import, not hosted profile pairing.

The owner-side `scout mesh guests` commands require the guest-grant CLI change.
Use a build that includes that change; these are not commands in Scout 0.3.9.
Use an operator-provided, checksum-verified client wheel until a public client
release is explicitly available. A source version is not a publication receipt.

## Prerequisites

- A fresh Ubuntu 24.04 VM with sudo, Python 3.11+, `python3-venv`, and `curl`.
  A normal Tailscale installation needs a usable `/dev/net/tun` and daemon
  privileges. Restricted containers need separate network setup; this guide
  does not configure a userspace-networking proxy.
- The owner already runs Scout with a signed node card, a pinned HTTPS mesh
  endpoint on its Tailscale address, and the intended agents. The owner can
  restrict mesh TLS binding with `OPENSCOUT_MESH_TLS_TAILSCALE_ONLY=1` when
  configuring that runtime. This guide does not start or reconfigure it.
- A tailnet administrator able to configure policy and issue a restricted
  auth key. Reachability does not grant Scout authority.

## 1. Owner: restrict network access before enrollment

Review the [policy fragment](examples/scout-guest-policy.json). Replace its
example IPs with the intended runtime and another actual tailnet node. Merge
it into the existing policy; do not replace the whole policy with the fragment.
It grants `tag:scout-guest` TCP access to the runtime's port 43110 only.
Use the runtime's actual advertised port if different.

Remove or exclude overlapping broad allows for this guest from both ACLs and
grants. Adding one narrow allow does not subtract broader access. Include
negative tests for SSH, other runtime/admin ports, and the other nodes that
matter in this tailnet. Save the resulting policy in Tailscale's policy editor
and require its assertions to pass. Local JSON parsing is not a substitute for
that validation. See the official
[policy tests](https://tailscale.com/docs/reference/syntax/policy-file#tests).

Issue a short-lived, non-reusable auth key with only `tag:scout-guest`. For a
disposable VM, choose an ephemeral device; for a persistent assistant, choose
and document its device renewal/removal policy. Auth-key expiry does not revoke
an already enrolled device or a Scout grant. Tagged-device key expiry also has
its own policy. See [auth keys](https://tailscale.com/docs/features/access-control/auth-keys)
and [ephemeral devices](https://tailscale.com/docs/features/ephemeral-nodes).

Deliver the key through the VM's secret facility as an owner-only file, for
example `/run/secrets/scout-tailnet-key`. Never paste its value into chat,
command arguments, shell history, logs, or the bootstrap JSON.

## 2. Guest: install and join Tailscale

For Ubuntu 24.04 only, use Tailscale's signed package repository:

```sh
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o tailscale-keyring.gpg &&
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o tailscale.list &&
sudo mkdir -p --mode=0755 /usr/share/keyrings &&
sudo install -m 0644 tailscale-keyring.gpg /usr/share/keyrings/tailscale-archive-keyring.gpg &&
sudo install -m 0644 tailscale.list /etc/apt/sources.list.d/tailscale.list &&
sudo apt-get update && sudo apt-get install tailscale &&
sudo systemctl enable --now tailscaled &&
sudo tailscale up --auth-key=file:/run/secrets/scout-tailnet-key --advertise-tags=tag:scout-guest --accept-routes=false --ssh=false &&
tailscale status
```

Choose the correct repository for another distro from
[Tailscale's package instructions](https://pkgs.tailscale.com/stable/).
The `file:` input keeps the key out of argv; check that the installed version
supports it with `tailscale up --help`. See the official
[`tailscale up` reference](https://tailscale.com/docs/reference/tailscale-cli/up).
Remove the consumed key through the secret facility. Do not enable Tailscale
SSH, subnet advertisement, exit-node routing, Serve, or Funnel for this flow.
Use a fresh VM; do not reset an existing device's networking flags blindly.

Check the policy from this guest before adding a Scout grant. For example,
when `nc` is installed, TCP 43110 on the runtime should connect, while TCP 22,
other admin ports, and representative other nodes must not. A closed port or
a failed probe alone does not prove a policy deny. Retain the policy editor's
positive/negative test results as well.

## 3. Guest: install the client and generate a public key

Obtain the exact wheel, SHA256SUMS, and expected release identity from the
owner through a trusted channel. Checksums detect changed bytes; a checksum
from the same untrusted download is not independent release authentication.
Run from the directory containing those files:

```sh
WHEEL='<verified-wheel-filename>'
sha256sum -c SHA256SUMS &&
python3 -m venv "$HOME/.local/share/scout-tailscale" &&
"$HOME/.local/share/scout-tailscale/bin/python" -m pip install --only-binary=:all: "$WHEEL" &&
SCOUT_CLIENT="$HOME/.local/share/scout-tailscale/bin/scout-tailscale" &&
"$SCOUT_CLIENT" --version &&
"$SCOUT_CLIENT" --json key > guest-public-key.json
```

Stop if verification or installation fails. Do not use sudo pip, disable TLS
verification, overwrite the full `scout` CLI, or start a broker on the guest.
Share only the `publicKey` value with the owner. Keep client state and its
Ed25519 private key persistent and owner-only. `SCOUT_TAILSCALE_HOME` selects
a separate state directory when needed; changing it also changes the identity.

## 4. Owner: grant exact agent access

On the runtime's own machine, choose a future expiry and exact allowed agent:

```sh
scout mesh guests grant --public-key '<guest-public-key>' --label 'linux-guest' --agent '<agent-id>' --expires-at '<future-ISO-timestamp-with-timezone>' --request-id 'linux-guest-approval-1' --json > grant.json
```

Repeat `--agent` for more exact IDs. The broker caps expiry at 30 days; read
the effective expiry in the response. Reuse the request ID after a lost response.
Deliver `grant.json` privately and verify its `bootstrap.nodeKeyId` with the
guest over a separate trusted channel. The file contains private network
inventory and public grant metadata, not the guest's private key.

## 5. Guest: connect, ask, and check denial

Use a reachable HTTPS endpoint from the signed card, not the runtime's
privileged loopback port or an invented address:

```sh
"$SCOUT_CLIENT" connect --bootstrap grant.json --node-key '<independently-verified-node-key-id>' --endpoint '<advertised-tailnet-HTTPS-endpoint>' --proxy direct
"$SCOUT_CLIENT" doctor
"$SCOUT_CLIENT" who
"$SCOUT_CLIENT" ask --to '<agent-id>' --wait 20 'Describe the work you can accept.'
```

Keep the resulting request ID. If acceptance or result delivery is lost, use
`ask --resume '<request-id>'` or `wait '<request-id>'` with this same client
state. Do not recreate the task on another machine. An ask to an agent outside
the grant must fail. Signed, pinned reachability and a completed ask/result
are the acceptance test; Tailscale status or `/v1/node` alone is insufficient.
A grant permits an agent to use its own tools; it is not a sandbox for them.

## 6. Owner: revoke; guest: verify and forget

```sh
# Owner, on the runtime's machine:
scout mesh guests revoke --request-id 'linux-guest-approval-1' --json
# Guest, using the original state:
"$SCOUT_CLIENT" doctor
"$SCOUT_CLIENT" disconnect
```

After owner revocation, a further signed operation with the old grant must be
denied. `doctor` must not report an active grant. Disconnect only forgets local
state; it does not revoke broker access. Revocation does not cancel accepted
work or erase results already delivered. The administrator must also remove
the device from the tailnet when network access should end; revoking the
admission auth key alone does not remove that device.

## Validation status

The grant/bootstrap, signed TLS ask/result, scope denial, retry, and revocation
path is covered by isolated runtime/Python fixtures. Policy examples and shell
syntax are checked locally. No Linux VM has been enrolled for this change.
Distro installation, real tailnet policy enforcement, real network denial,
and a cross-machine Linux acceptance run remain operator-run release gates.
