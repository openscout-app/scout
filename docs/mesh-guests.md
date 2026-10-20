# Direct guest grants

Use `scout mesh guests` on the runtime's machine to let one guest key ask
specific agents for work. The commands use the runtime HTTP API. They do not
start services, enroll peers, modify Tailscale, or contact a hosted service.

A guest grant is not a trusted-peer grant. It permits signed guest requests to
exact agent IDs. It does not permit access to local administration routes or
peer-tier mesh routes. An allowed agent can use its own tools when it accepts
a task; the grant is not a sandbox for those tools.

## Grant access

1. On the guest, create a key with the standalone Python client:

   ```sh
   scout-tailscale --json key
   ```

   Give the owner the `publicKey` value. Keep the private key on the guest.

2. On the runtime's machine, choose the label, exact agent IDs, and expiry:

   ```sh
   scout mesh guests grant --public-key '<base64-Ed25519-SPKI>' \
     --label 'guest-assistant' --agent '<agent-id>' \
     --expires-at '<ISO-8601-timestamp-with-timezone>' \
     --request-id 'guest-approval-1' --json > grant.json
   ```

   Repeat `--agent` to allow more agents. A positional public key is also
   accepted. `--expires-at` accepts an ISO timestamp or epoch milliseconds.
   The broker caps expiry at 30 days. Read the effective expiry in the output.
   Reuse the request ID after a lost response. An unchanged retry returns the
   existing grant without extending its expiry. A different key or scope is
   refused. Re-approval after revocation requires a new request ID.

3. Send `grant.json` to the guest through a trusted channel. It contains the
   grant, signed node card, endpoints, and TLS pin, but no private key.
   Verify `bootstrap.nodeKeyId` through a separate trusted channel.

4. On the guest, import the bootstrap with the verified node key:

   ```sh
   scout-tailscale connect --bootstrap grant.json \
     --node-key '<verified-node-key-id>' --proxy direct
   scout-tailscale who
   scout-tailscale ask --to '<agent-id>' --wait 20 'Describe what you can help with.'
   ```

   The runtime must already advertise a reachable HTTPS mesh endpoint and TLS
   pin in its signed node card. The guest must already have network access.
   Use `--endpoint '<advertised-https-endpoint>'` if the card lists multiple
   endpoints and automatic selection does not choose the reachable one.
   `connect` verifies the signed, pinned connection before reporting success.
   Do not point Tailscale Serve, Funnel, or another reverse proxy at the
   runtime's privileged loopback listener.

## List and revoke

```sh
scout mesh guests
scout mesh guests list --json
scout mesh guests revoke '<grant-id>' --json
# Alternative when the grant response was lost:
scout mesh guests revoke --request-id 'guest-approval-1' --json
```

The list includes active, expired, and revoked grants. Revocation affects new
operations and waits. It does not undo accepted work or erase delivered
results. Removing Tailscale access and revoking a Scout grant are separate
operator actions. `scout-tailscale disconnect` only forgets local client state.

JSON list output is an array. Grant output preserves the runtime's
`created`, `grant`, and `bootstrap` fields. It also copies the broker's effective
scope to `allowed_targets` and `expires_at`, as required by the Python client's
out-of-band bootstrap format. Revoke output preserves `{ok, grant}`.
