# Coding-agent collaboration in 2026: Codex, Claude Code, Grok, and OpenCode

*Updated September 26, 2026. Practical workflows and product documentation change; check your installed runtime before using an example.*

These agents collaborate as peers. Any agent can propose an approach, ask a question, make a change, or review another agent’s work. The task assignments below are examples you can swap as the work evolves.

You have an implementation in Codex and want Claude Code to question it. Or Claude has narrowed down a bug, and you want Grok to try a different explanation. Or OpenCode owns one component while another agent handles its caller.

These are all variations of the same problem: **give another coding agent enough context to do useful work, get a result you can inspect, and retain a reliable way to follow up.**

The direction can change with every task. Codex ↔ Claude Code, Claude Code ↔ Grok, Grok ↔ Codex, and Codex ↔ OpenCode are useful when those tools are available. Kimi Code, pi, and Cursor CLI fit the same pattern when Scout can launch them. No brand has to be the one that always plans or always implements.

This guide explains the choices, then walks through Scout's approach. Scout is a local control plane for existing agents, intended for high-trust developer environments. Its coordination features do not establish enterprise readiness, guaranteed delivery, or a shared transcript across tools.

## How the agents connect: the moving parts

Treat each agent as a peer with its own execution environment. To connect two of them, first identify five things:

- **Interface:** the terminal UI, editor, desktop app, or custom client a person uses.
- **Runtime:** the process that owns the model/tool loop and enforces permissions.
- **Transport:** how another program exchanges requests and events with that runtime—pipes, a local socket, HTTP, or a terminal pane.
- **Session:** the persistent conversation identifier, current working directory, and configuration you intend to continue.
- **Artifacts:** the files, revisions, and findings another peer needs. A connection does not automatically transfer them.

A frontend can disconnect while a server remains alive. A server can host more than one session. A successful connection can still point at the wrong session. Keeping these distinctions explicit makes collaboration much easier to reason about.

| Connection mechanism | What travels through it | What your integration must handle |
| --- | --- | --- |
| Structured app-server or HTTP API | Session requests, turn events, results, and supported controls | Authentication, exact session identity, permissions, lifecycle, and reconnection |
| ACP over stdio | Protocol requests and responses between a client and an agent process | Initialization, supported capabilities, process ownership, and permission responses |
| Headless CLI with structured output | A prompt plus machine-readable progress/results | Process lifetime, session resume, output framing, and errors |
| Terminal or tmux pane | Keystrokes, pasted text, and rendered terminal output | Correct pane, composer state, submission, approval UI, and reliable completion evidence |
| MCP tools inside an agent | Tool calls to a service such as Scout | The host's tool permissions and the service's routing contract |

These are connection choices. Any connected peer can ask questions, offer a change, or request feedback.

### Codex: app-server, threads, and turns

Codex's app-server defaults to newline-delimited JSON over stdio. The current interface also supports a Unix socket carrying WebSocket messages for local IPC, and an experimental TCP WebSocket listener. IPC describes communication between processes; stdio and Unix sockets are different transports within that category.

A client initializes the connection, starts or resumes a thread, submits a turn, and consumes progress, approval requests, and completion events. Generate schemas from the installed version. Remote TCP listeners need the documented authentication and TLS setup. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

For an integration author, launching and attaching have different ownership rules. A process you launched can have your client's lifetime. An existing shared server may serve other clients, so disconnecting must not imply shutting it down. Confirm which mode your installed integration implements.

### OpenCode: separate the server from its clients

OpenCode V2 makes the separation explicit: the background service owns execution, while a terminal or application acts as a client. Its current JavaScript client can discover an existing registered service, ensure a compatible one is running, and derive connection headers. The documented service command is `opencode serve --service`. Requests target a session and project location. Leaving an event subscription closes that subscription; stopping the service is a separate operation.

That distinction also exposes a recovery problem: current subscriptions have no replay or automatic reconnection. After a disconnect, a client must resubscribe and reconcile what actually happened. [OpenCode V2 client and service documentation](https://opencode.ai/v2/docs/build/client).

Check the API generation before connecting. V1 and V2 now use the same `opencode` command, but their server contracts differ. V1 examples using `/session` and `/event` cannot be assumed to work with V2's `/api/*` contract. [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1).

Scout's [V2 adapter notes](https://github.com/openscout-app/scout/blob/main/packages/agent-sessions/src/adapters/opencode-v2/README.md) describe an explicit pinned beta integration with an older client package and a registered `opencode2` service. It queues and correlates its own inputs, filters events to the session, and leaves the shared service running on disconnect. Match the adapter's supported version instead of copying current upstream client code into an older integration.

### Claude Code: choose the control surface deliberately

Claude Code has an interactive terminal interface and a programmatic CLI. `claude -p` can return JSON or streamed events, and `--resume` continues a captured session identifier. Reusing a conversation and reusing an operating-system process are separate choices. [Claude programmatic mode](https://code.claude.com/docs/en/headless).

The Agent SDK provides another application interface. Its permission callbacks handle requests that reach that point in evaluation; earlier rules can already allow an operation. Tool preapproval, available tools, and instructions in a prompt are different controls. A peer's request to “only read” should be backed by the appropriate permissions if read-only operation is required. [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

Scout's structured Claude adapter drives the CLI's stream-JSON interface; it is not an Agent SDK integration. Its terminal path preserves a human-visible session. In either case, the integration needs to represent both ordinary replies and requests for human attention. A permission dialog intercepted inside the host may never reach an MCP server, so watching only the runtime cannot establish that the peer is unblocked.

### tmux: a visible session with terminal semantics

tmux keeps its own server, sessions, windows, and panes. A person can detach and later reattach while the terminal process continues, provided the host and tmux server remain running. [tmux getting started](https://github.com/tmux/tmux/wiki/Getting-Started).

For agent collaboration, a terminal adapter also needs to identify the correct pane, confirm its current session, place text in the composer, and submit it. Pasted text proves neither submission nor task completion. The adapter must observe output and attention states, and retain an explicit way to correlate the reply. tmux supplies terminal continuity; the integration supplies those agent-level semantics.

Use this route when keeping the interactive session visible matters. Prefer a structured control surface when you need machine-readable events and the installed harness supports it.

### Native support and Scout routing are separate checks

A tool may expose an HTTP server while Scout's default route uses ACP. A CLI may support an SDK while a particular adapter drives its JSON stream. Read the integration path you will actually use, including how it resumes a session and reports an interrupted turn.

In this repository's current routes and adapters, Codex uses app-server; runtime-created OpenCode work defaults to ACP; Claude Code has terminal and structured-CLI paths; and the listed Grok CLI route uses ACP. The product-V2 OpenCode server has a separate, explicit adapter/configuration path. A command alias is not evidence that this path was selected; names and routing differ by release. Run `scout runtimes --json` against your installed version before selecting a route.

For any pairing, answer three concrete questions before a larger handoff: **Which process owns the work? Which session receives the request? What event proves it finished?** Then pass the files and context the peer needs. This works in both directions without giving a brand a permanent job.

## Choose the collaboration path by the work

| What you need | Start with | Main tradeoff |
| --- | --- | --- |
| A bounded research task inside your current agent | Native subagent | Simple delegation within one harness; context and tool access follow that product's rules. |
| An independent review from another coding tool | Separate sessions and an explicit handoff | You must supply context and an exact review target. |
| Several agents changing independent components | Separate worktrees and one integration owner | File isolation helps; shared services and interfaces still need coordination. |
| Repeated requests across Claude, Codex, Grok, or OpenCode | A runtime such as Scout | Adds routing and work records; each runtime still needs installation and authentication. |
| Work on another machine you own | A reachable agent and a checkout that already exists there | Moving a request does not move source files or credentials. |
| Work in a managed cloud environment | A hosted coding-agent service | Environment setup and artifact transfer become part of the handoff. |

Stay inside one tool when a helper can return a summary to the session you already have. Copy a short brief between terminals when you want another harness. Add Scout when routing, waiting, and follow-up become recurring chores.

## First, separate the harness from the model

A **harness** runs the agent: its tools, permissions, session, and execution loop. A **model** supplies the reasoning within that environment. An **MCP host** can call tools exposed by an MCP server. These roles can overlap in one product, and configuring one does not supply the others.

Claude Code, Codex, Grok CLI (`@xai-official/grok`), and OpenCode are harnesses. Opus, GPT, and Grok are models you select inside a harness. `--harness claude` selects Claude Code, not Opus. A Grok model inside OpenCode or Cursor is still that other harness's session. Grok Bot is xAI's hosted agent product, where each Bot works on its own cloud computer. It can call Scout through a connector, which is a different path from Scout launching Grok CLI. [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [Scout's Grok paths](https://openscout.app/docs/scout-for-grok).

The repository's [runtime catalog](https://github.com/openscout-app/scout/blob/main/packages/protocol/src/runtime-catalog.v1.json) (revision `2026-09-14.1`) contains these execution routes:

| Tool | Scout harness identifier | What to check |
| --- | --- | --- |
| Claude Code | `claude` | Installed Claude runtime and authentication. |
| OpenAI Codex | `codex` | Installed Codex runtime, account access, and selected model. |
| Grok CLI | `grok`, `grok-acp` | Both are configured. In this revision `grok-acp` is the listed route: Scout drives the `grok` binary over the Agent Client Protocol. The unlisted `grok` id is still legal. Both use the same xAI sign-in. |
| OpenCode | `opencode` | Runtime and configured model provider. |
| Cursor CLI, Kimi Code, pi | `cursor`, `kimi`, `pi` | The corresponding executable and provider configuration. |
| Flue, Devin | `flue`, `devin` | Runtime-specific prerequisites and access. |

Run `scout runtimes --json` and `scout doctor` on your machine. A catalog row does not prove the executable, account, or model is ready. Hermes Agent and Herdr connect as a host or a terminal surface; they are not `--harness` ids. See the [CLI guide](https://github.com/openscout-app/scout/blob/main/packages/cli/README.md) and the [integration guide](https://github.com/openscout-app/scout/blob/main/docs/integrations.md).

## When a native subagent is enough

Use a subagent when the parent session should keep the decisions and a helper should return a summary. Claude Code subagents do that inside one session, with their own context and a tool list you can narrow. Current Codex releases enable subagent workflows by default: local Codex spawns them after a direct request or a project or skill instruction, then consolidates their results. The same docs caution that parallel write-heavy work can create conflicts. Grok CLI's readme describes plans, subagents, and parallel work inside that CLI. [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Grok CLI package](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/npm/grok/README.md).

Switch to a separate harness when you want another vendor's tools or account, when the reviewer must sit outside the implementer's permission world, when the work needs a different checkout or machine, or when you need a request handle that survives the original terminal.

Claude's agent teams are the middle case: separate Claude Code sessions that message each other. Checked on September 26, 2026, the feature is experimental, off unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, and the docs list limits around resume, task status, and shutdown. A teammate loads project context and the spawn prompt, and does not receive the lead's conversation history. The same rule applies across vendors: **say the task again, and attach artifacts by path or commit.** [Claude agent teams](https://code.claude.com/docs/en/agent-teams).

Claude Code also has cross-session messaging: one Claude Code session can send plain text to another, including sessions on other machines through Remote Control. The docs are explicit that a message is never the sender's conversation history or files. It connects Claude Code sessions to each other; it does not route work to Codex, Grok, or OpenCode. [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

## Can Claude Code and Codex review each other's work?

Yes. Give one of them a frozen target and the behavior the diff cannot show.

Suppose Codex implements a retry policy. Record the base and head commits and stop changing that range. A commit range stays still. An uncommitted diff is reviewable only while writers are paused, and the reviewer should report the `git status` it saw. Also state the behavior the diff cannot show: ordering, which failures are retryable, and what must stay compatible.

Put that brief in a file the reviewer can read, then point Scout at the file. `--prompt-file` replaces the inline message; do not pass both.

```bash
scout ask --project . --harness claude \
  --prompt-file ./reviews/retry-review.md
```

`./reviews/retry-review.md` can contain:

```text
Goal: review the retry-policy change for correctness.
Checkout: /path/to/project
Base commit: <actual base SHA>
Head commit: <actual head SHA>
Expected behavior: retry transient failures without reordering deliveries.
Ownership: read-only review; do not edit, merge, push, or deploy.
Checks: inspect source. Report any commands you run and their results.
Return: findings with file and line, triggering input, and consequence.
If there are no findings, say so and state the limits of the review.
```

Scout prints a broker receipt with a flight id and, when the runtime binds one, a `ref:` handle. A receipt means the request was recorded. It does not mean the review finished. Replace `ref:RETURNED` with the handle from your receipt:

```bash
scout wait ref:RETURNED --timeout 600
scout ask --ref ref:RETURNED \
  "Explain the triggering input for the ordering finding. Keep the review read-only."
```

`scout wait` accepts an invocation id, a flight id, a message id, or a `ref:…` value; `scout ask --ref` takes the `ref:` handle. The wait default is 600 seconds. A timeout only ends the wait; it does not cancel or fail the flight. On timeout, wait again with the same handle or inspect `scout flight`.

For **Claude Code → Codex**, use `--harness codex` and the same brief. Reproduce the triggering input before you accept either agreement or a disagreement.

## How do Grok, Codex, Claude Code, and OpenCode hand work both ways?

The mechanism generalizes. These are illustrative assignments, not claims that a particular model is inherently best at a role. Swap the harness id, and keep the brief specific.

| Pairing | One direction | Reverse direction |
| --- | --- | --- |
| Claude Code ↔ Grok | Claude proposes an implementation; Grok reviews a named risk. | Grok returns a sourced diagnosis; Claude checks it against repository behavior and does not treat the diagnosis as a patch. |
| Grok ↔ Codex | Grok returns sources, constraints, and a proposed approach, with no edits. Codex implements only the approach you accept. | Codex returns a commit. Grok reviews one specified risk in that commit. |
| Codex ↔ OpenCode | Codex defines an interface and the tests that lock it. OpenCode implements one component behind that interface, in its own worktree. | OpenCode returns its revision. Codex reviews the caller against that revision. |
| Either side ↔ Kimi, pi, or Cursor CLI | Same brief, with `--harness kimi`, `--harness pi`, or `--harness cursor`. `scout runtimes` lists the route; readiness still depends on that CLI being installed and signed in where it runs, so start with a small ask. | The return trip uses the other harness id. Cursor-the-editor can also connect as an MCP host through `scout mcp`; that connection does not by itself launch the Cursor CLI harness. |

Example, Grok investigates and Codex later implements. First request, from the repo:

```bash
scout ask --project . --harness grok-acp \
  --prompt-file ./reviews/retry-research.md
```

`grok-acp` is the listed Grok route; the unlisted `grok` id also works where that route is installed. After you accept the approach, start a fresh ask to Codex. Pass the accepted file and the decisions. Do not assume the Codex session can see Grok's chat:

```bash
scout ask --project ../payments-retry --harness codex \
  --prompt-file ./reviews/retry-implement.md
```

OpenCode takes the same commands with `--harness opencode`. A Grok model configured inside OpenCode is still an OpenCode session. Confirm the model on the invocation Scout returns before you describe which model ran.

Grok Bot reaches your broker through Scout's hosted MCP gateway and your online bridge; Scout still launches the harness you name. The published page separates that hosted connector, a local installer that points Cursor at `scout mcp`, and launching Grok CLI. The bridge is operator-assisted, and adding the connector does not create it. On September 26, 2026, the page still listed custom MCP as the connect path, with marketplace approval pending.

## How do peers keep shared work moving?

Initiative can move between agents. One peer raises a question, another proposes a change, and either can request another pass. Agree on ownership for the current task so two writers do not unknowingly change the same files. Ownership can change when the task does; it does not give a model a permanent rank.

Keep a request reference, an exact revision, and the decision made about the result. If a finding remains unresolved, continue the same request with the missing evidence. If the scope changes from investigation to editing, state the new scope and permissions explicitly. Completion of a task does not itself authorize a merge or deployment.

Scout's `ask` creates tracked work and a return path. `send` records a status note. Neither copies another harness's complete conversation into the recipient. The useful unit of collaboration is a specific question or artifact that a peer can inspect and answer.

## What context does the next agent need?

Write the brief as if the reader has the repository and none of your conversation. Include:

- the goal, in one or two sentences;
- the checkout path on the machine that will do the work;
- the revision: two SHAs, or an explicit statement that the target is the paused working tree;
- behavior, invariants, and non-goals the diff cannot reveal;
- ownership: which paths may change, and whether merge, push, and deploy are forbidden;
- which checks are allowed;
- the return shape: findings, a commit, sources, or a list of unresolved questions;
- the previous artifact you accepted, by path or SHA, when this stage depends on one.

Leave out scratch reasoning, tool logs, and secrets. Keep the brief in a file and pass it with `--prompt-file`, or `--message-file` on a send. Paste it only when the recipient cannot read the path, and say why. `--ref` continues the same Scout work. `session:<id>` continues one exact harness session. A fresh `--project` and `--harness` is the clean start between research and implementation.

## How do I keep parallel agents from editing the same checkout?

Give each writer a Git worktree and a branch. From the main checkout:

```bash
git worktree add -b payments-retry ../payments-retry HEAD
git worktree add -b payments-api ../payments-api HEAD
```

Route each ask with `--project` set to that worktree. One owner per tree, plus one integration owner. Agree on signatures, migration order, and feature flags before the writers start.

Worktrees isolate working files. They leave a shared database, dev-server port, queue, browser profile, or external account shared. Name those resources in the brief. The integration owner reviews the combined result against the contract. A harness that parks its own subagent in a temporary worktree is still that harness; use an explicit worktree when the other writer is a different product.

## What has to exist before an agent on another machine can help?

Scout's optional mesh extends reachability among machines you trust. Pair a second workstation with `scout pair`, or discover peers with `scout mesh discover` when runtimes can already see each other (a shared Tailscale network, or `OPENSCOUT_MESH_SEEDS` pointing at the other broker). `scout who` can then show agents whose authority is the other machine, and an ask addressed to one of them is forwarded there. Forwarding does not copy the repository, credentials, or the other harness's transcript. Provider inference can still happen on that vendor's service. Mesh does not promise exactly-once delivery. These commands are for a high-trust pilot among your own machines.

Before you send the work, confirm:

1. `scout doctor` is healthy on the machine that will run the harness.
2. The two brokers are paired or discovered, and `scout who` shows the destination agent.
3. That machine has the repository checked out at the revision you name.
4. The destination harness is installed and authenticated *there*. A login on your laptop does not sign in the other computer.
5. The brief uses the destination's checkout path. `--project` on your laptop selects a project path the local runtime can resolve. It does not create that directory on the other disk. When the worker lives elsewhere, address that worker with `--to` and put its local path in the brief.

## When is a hosted coding agent a different handoff?

A local ask starts a harness against a checkout you can open. A hosted agent runs in an environment someone else provisions, then hands you artifacts to review.

Codex cloud runs tasks in a cloud environment you configure (dependencies, tools, variables, and setup steps), then gives you a summary and diff to review or open as a pull request. That is a different lifecycle from `scout ask --harness codex`, which launches local Codex. Bring the cloud result back as a branch, diff, or pull request before the next local brief. [Codex cloud](https://learn.chatgpt.com/docs/cloud), [cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment).

Grok Bot reaches your broker through the connector described above. The agents it asks still run where Scout launches them, so the brief names the project directory on the Scout machine and you keep the returned handle.

Devin is a catalogued route with its own environment. A catalog entry does not establish account access. Name what that environment must contain, and bring back a revision you can review locally. A finished cloud task is not yet a commit on your machine.

## Where do MCP, ACP, and A2A fit?

They solve different joins. Using one does not imply the others.

**MCP** connects an application (the host) to tool servers. Each connection is an MCP client. Servers expose tools, resources, and prompts. `scout mcp` is Scout's local stdio coordination server; the runtime still owns the messages and asks. Local hosts such as Claude Code, Codex, and Cursor can launch it, and Grok Bot reaches the same tools through the hosted gateway. The connection does not pour another agent's conversation into the caller. Tool names can change while the [MCP posture](https://github.com/openscout-app/scout/blob/main/docs/mcp-api-posture.md) is v0 guidance, so use `tools/list` to see what your server exposes. Ordinary handoffs are still `ask` or `ask` with `fyi: true`. [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture).

**ACP**, the Agent Client Protocol, is how a coding client talks to a coding agent, analogous to the Language Server Protocol. Local agents typically use JSON-RPC over stdio. The introduction describes remote agents over HTTP or WebSocket, and says full remote support is still in progress. Scout's `grok-acp` route uses ACP as a client adapter: Scout talks to that agent. Scout does not become an ACP server, and this ACP is not BeeAI's Agent Communication Protocol. [ACP introduction](https://agentclientprotocol.com/get-started/introduction).

**A2A**, Agent2Agent, is how agents discover each other and exchange tasks. MCP reaches tools and data; A2A reaches agents. Scout's [concepts](https://github.com/openscout-app/scout/blob/main/docs/concepts.md) describe Scout as the local coordination substrate and A2A as a boundary where some primitives are exposed and full conformance is not claimed. An MCP connection or an ACP launch does not make that session a general A2A peer. [What is A2A?](https://a2a-protocol.org/latest/topics/what-is-a2a/).

## What to check when a handoff stalls

Work through the layer that failed. A broker receipt, a running harness, and a finished review are three different events.

| What you see | What to check |
| --- | --- |
| The CLI says the target is unresolved | The route is unclear here. That is different from the agent merely being offline. Run `scout who`, then qualify the harness or use the full id. |
| `scout wait` times out | The wait ended. The flight may still be running. Wait again on the same ref, or run `scout flight`. A longer `--timeout` does not cancel work. |
| The wrong product ran | The id was a model family, or a Grok model inside OpenCode. Read `scout runtimes --json`. `grok` and `grok-acp` are separate catalog entries. |
| The review describes code you have since edited | The target moved. Put the new SHAs in a `--ref` follow-up. |
| The worker cannot find the brief or the checkout | The path is on the wrong machine. Use the destination path, or paste the brief and say the file was unreachable. |
| Grok Bot can chat and cannot reach your agents | The connector reaches your broker only through the online bridge. Check `scout doctor`, then `scout mesh bridge status`; the bridge is an early-stage, operator-assisted path. |
| The harness cannot authenticate | Sign in to that harness on the machine that runs it. `scout doctor` checks Scout, not the vendor login. |
| Two writers conflict | They shared a checkout, a port, or an interface. Give each writer a worktree and name an integration owner. |

## Handoff templates you can copy

Replace every angle-bracket placeholder. Delete sections that do not apply. Keep the file next to the work and pass it with `--prompt-file`.

Research, no edits:

```text
Goal: <question you need answered>
Checkout: <absolute path on the machine doing the work>
Revision: <SHA or "working tree, writers paused">
Constraints: <invariants, compatibility, and files that must not change>
Out of scope: <what not to investigate>
Ownership: read-only. Do not edit, commit, push, or open a pull request.
Return:
- proposed approach in a few paragraphs
- repository facts with file references
- external claims with primary-source URLs
- uncertainties and what you could not verify
```

Implementation of an accepted approach:

```text
Goal: <the change>
Checkout: <worktree path>
Start from: <SHA>
Accepted approach: <path to the research note, plus the decisions you accepted>
Do not: <merge, push, deploy, or edit these paths>
Checks: <commands that are allowed>. Report the command and the result. Do not claim a check you did not run.
Return: commit SHA, files changed, checks run, and unresolved questions.
```

Review of a stable target:

```text
Goal: <what "correct" means for this change>
Checkout: <path>
Base: <SHA>
Head: <SHA>
Read: <path to the accepted requirements>
Ownership: read-only. Do not edit or suggest drive-by refactors as findings.
Return each finding as: file and line, triggering input, consequence, and why it violates the requirements.
If there are no findings, say so and state what you did not check.
```

Follow-up on the same Scout task:

```bash
scout ask --ref ref:RETURNED \
  "The ordering finding: quote the input that triggers it and the line that reorders. Stay read-only."
```

Status with no new work:

```bash
scout ask --to TARGET --fyi \
  "FYI: review ref:RETURNED is in flight. No action until it returns."
```

## What this workflow does not promise

Scout records requests, routes them, and gives you handles. The destination harness can still be offline or unauthenticated, mesh reachability is not exactly-once delivery, and a cloud task or a pasted transcript is not yet a local commit. The next agent needs the goal, the revision, the ownership limits, and the artifact you accepted.

[Web version](https://openscout.app/blog/coding-agent-collaboration-2026) · [Return to the Scout README](https://github.com/openscout-app/scout/blob/main/README.md) · [Make your first handoff](https://github.com/openscout-app/scout/blob/main/packages/cli/README.md#make-your-first-handoff-claude-code-or-codex) · [Agents and collaboration](https://github.com/openscout-app/scout/blob/main/docs/agents-and-collaboration.md)


## Pick your first collaboration

Start with one complete request and result before adding more workers:

- [Claude Code and Codex: a focused code review](https://openscout.app/blog/claude-code-codex-review-workflow).
- [Claude Code and Grok: collaborating as peers](https://openscout.app/blog/claude-code-grok-collaboration).
- [Codex and OpenCode: an independent review loop](https://openscout.app/blog/codex-opencode-review).

Ready to connect your tools? Choose an [integration guide](https://openscout.app/integrations), or begin with the [Scout quickstart](https://openscout.app/docs/quickstart).
