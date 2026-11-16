---
name: scout-inventory
description: Inventory and set up a user's coding agents and connected providers for Scout. Use when the user's main coding agent needs to discover existing installations, logins, model choices, account status, or missing Scout connections across other agents.
---

# Scout inventory and setup

The user's main coding agent owns this workflow. Scout supplies discovery,
readiness and account readings; each other agent keeps its own configuration,
login, execution and transcript. Do the investigation in this conversation.
Starting another agent is unnecessary for ordinary inventory or setup.

## Establish the scope

Use the host, OS user, projects and requested changes from the conversation.
An inventory request authorizes reads. A setup request also authorizes the
specific installs or connection changes it describes; do not ask again for
those. It does not authorize buying credits, replacing existing credentials,
changing account settings, or restarting the user's running agents.

Prefer connected Scout inventory/readiness tools; otherwise use the installed
CLI's help before its commands. Start with `scout runtimes --json` and, when
Scout health matters, `scout doctor --json` without `--fix`. Bun doctor emits
NDJSON; the Node headless CLI emits one JSON report. Private app readiness is
not part of core doctor. Keep failures and inconclusive checks distinct.

If Scout is absent, inventory the native agents first. Install Scout only if
that is part of the requested setup. Do not invent a runtime URL or assume the
default port is the selected instance. For another host, use Scout's host and
project discovery. Do not infer that local files describe the remote host.

## Inspect the actual integrations

Read only the reference needed for the entries being investigated:

- [Harness locations](references/harnesses.md): binaries, config overrides,
  native auth, models, Scout connections and special adapter boundaries.
- [Provider and account locations](references/accounts.md): subscriptions,
  model gateways, credential names, cloud accounts and balance limitations.

Inspect the installed version and active config roots before defaults. A
project override, named profile or Scout background home may differ from the
user's interactive account. Record these as separate scopes. Follow explicit
provider IDs and gateway-qualified model IDs; do not derive one from another.

Use file existence and narrowly parsed, allowlisted fields. Do not dump config,
credentials, environment variables, browser databases, logs or transcripts into
conversation output. Record secret *names and presence*, never values. A secret
manager's name index may be synced even when the local value is absent; verify
local accessibility through that manager without printing the value. Do not
source shell startup files or execute credential helpers just to inventory them.
Do not copy CLI OAuth state between users or hosts.

A catalog or model list proves a listed option, not funded access. A credential
file proves a file exists, not that its token works. A status command may prove
sign-in, not remaining credits. Read balances through the existing account
adapter or provider account endpoint; never make an inference call as a probe.
Use Scout's existing normalized quota observations rather than searching harness
history. If past sessions are needed, use `scout search` or session inventory.

## Complete the requested setup

For each gap, identify the owning tool and the smallest change:

1. Resolve the active binary/profile and the requested installation target.
2. Use the tool's current native setup or login flow. Interactive sign-in stays
   with the user. Keep working on independent entries while sign-in is pending.
3. Connect Scout using its supported integration command. Inspect
   `scout mcp --help` and the supported installer/dry-run options before changing
   a harness configuration. Preserve existing MCP servers, statusline delegates,
   model defaults, hooks and project instructions.
4. Re-read native status and Scout readiness. Do not launch a model turn merely
   to mark setup complete. If the user requested an execution test, report it
   separately, including the selected provider/model and observed result.

`scout setup` can install/start the runtime and write integration settings;
`scout doctor --fix` can repair it. Neither is a read-only inventory command.
Use them only when the requested setup includes those changes. Do not edit
Scout's databases or fabricate a provider-account record to turn a row green.
Where no supported write API exists, report the missing operation.

Keep auth owned by the CLI or provider secret store. Attach a credential through
its supported process environment or credential mechanism; do not paste it into
agent instructions, MCP arguments, public JSON, or a report. Account-status
adapters must remain independent of inference and must not drive login/setup.

## Reconcile and report

Return one compact inventory per host/user/profile. For each entry report:

- Kind: harness, model/API account, compute/hosting, or service integration.
- Installed/configured, authenticated, readable account/quota, and Scout
  readiness as separate findings; use unknown when no check establishes one.
- Evidence source and observation time; include each balance/usage window's
  scope, unit, capture time and matching reset. Stale readings stay stale.
- Config root or credential-name hint without secret values; relevant provider,
  harness, model/profile and project scope.
- Changes actually made, verification, and the next unresolved action.

Kimi's headline uses its seven-day usage and seven-day reset together. Cursor
login is not evidence of personal credits. EXE compute and model allocation are
separate. OpenCode Console and Go are separate accounts. Keep per-key spending
limits distinct from an account balance, and preserve a reported overdraft.

Scout's public `/.well-known/model-worldview.json` describes model knowledge and
editorial preferences. It never receives this user's inventory, credentials,
credits or usage. Persist Scout configuration through supported commands/APIs;
a private receipt can be saved if requested. A successful native login, merged
source change, installed integration and running session are different results.
