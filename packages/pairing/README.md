# Host pairing

This core package owns `scout pair`, the pairing controller, the encrypted
phone bridge, and the host-side RPC projections used by paired devices.

The bridge has one implementation. It retains the web bridge procedures and
the terminal bridge's `tail.events` subscription. The CLI uses the same host
service as the controller. Its existing bridge listener mounts the host pairing
HTTP routes; the controller owns LAN discovery even with a remote relay.
Apps can reuse these mounts, but pairing does not require an app listener or
a browser client. The unauthenticated route is the existing `/pair` knock.
Operator HTTP routes require a same-Mac request and the runtime bearer token.

Pairing admission stays in the runtime's trust owner. A daemon restart does
not create a QR invitation. Discovery publishes only the owner-gated account
room, never the QR invitation room.
The legacy Herdr permission-answer adapter retains its existing version,
claim, and audit guards; this move does not activate the newer public
host-attention answer kernel.

The `models` directory contains pure phone response projections and their
types, not a browser entry, component tree, or static client.
The package is internal to the core workspace and bundled into the CLI.
It adds no separate install-time dependency. The closed export map supports
Bun source loading and a declaration-bearing dist build for core consumers.
The root, `/runtime`, `/controller`, and `/http` need Bun. The other
entrypoints also load from `dist` in Node. Run `test:node` to build and check
those imports.

```sh
bun run --cwd packages/pairing check
bun run --cwd packages/pairing test
```

The former desktop bridge now uses the existing broker receipt-backed
native-session reply procedure instead of its unsupported-operation stub.
Receipt validation and refusal behavior are owned by the runtime. This is an
intentional unification of the former web and desktop procedure sets, not a
new input authority.

## Account approval without an app

The controller joins an account room only when it installs the host admission
callback. Account discovery is reachability, not consent: a new Noise identity
waits in the same cross-process pending-request store used by LAN pairing.
While it waits, ordinary RPC and subscriptions are refused.

```sh
scout pair requests list
scout pair requests show <token>
scout pair requests approve <token>
scout pair requests deny <token>
```

These commands read this host's store. `--json` selects structured output.
Compare the complete Noise key with the requesting device before approval.
Only a pending row can be answered; repeating a decision fails. Account
approval opens no LAN invitation. The connected account waiter must win
conditional approved fulfillment, remain live, and pass the canonical trust
owner's current authority check before it gains access. A denial, expiry,
disconnect, or authority change cannot grant trust.

Runtime snapshots carry a top-level `accountPairing` lease with `relay`,
optional `fallbackRelays`, `accountRoom`, `publicKey`, and `expiresAt`.
`pairing` remains null until an explicit QR invitation exists. The account
lease refreshes while the runtime lives and becomes null on shutdown.
Readers treat a present top-level lease as authoritative: null, malformed,
or expired means withdrawal, not fallback to an older QR snapshot. Legacy
nested `pairing.accountRoom` is read only when `accountPairing` is absent;
`pairing.room` is never an account-room fallback.
