# Lifecycle hooks

Status: proposal. Nothing in this spec is implemented. "Current behavior"
describes `main` as of 2026-11-28 (e22da43d).

Scout installs one hook script into every lifecycle point of every harness it
supports, once. Every hook calls the same core function in Scout,
`onLifecycle(event)`, whatever the harness and whatever the point. To change
what Scout does at any point, for any harness, change that one function. Nobody
edits Claude Code's settings, Codex's config or Antigravity's `hooks.json`
again.

The first behavior this enables: when a turn ends with a long reply that asks
the operator to decide something, Scout builds a visual proposal from it. That
behavior is the worked example at the end of this spec.

## Current behavior

**Harness hooks** (`packages/runtime/src/harness-hooks.ts`)

- `scout hooks apply`, `scout hooks remove` and `scout hooks status` manage
  Scout's entries in harness settings. The runtime is the only writer. Remove
  takes out exactly Scout's entries and leaves other hooks unchanged.
- Claude Code: one `PermissionRequest` entry in `~/.claude/settings.json`,
  running `openscout-claude-permission-request.sh`. No other Claude Code hook
  point is tapped.
- Antigravity: one entry named `openscout` in `~/.gemini/config/hooks.json`,
  covering `PreToolUse` (300 s timeout), `PostToolUse` (10 s) and `Stop`
  (10 s), with the matcher
  `ask_question|run_command|write_file|edit_file|read_file`.
- Each wrapper is one line: `exec <scout> permission-hook <claude|antigravity>`.
  It reads the hook's JSON on stdin
  (`packages/cli/src/cli/commands/permission-hook.ts`). Its job is permission
  and attention, not general lifecycle.
- Codex has no Scout hook.

**Sessions Scout launched versus native sessions**

- For a session Scout launched, the broker already sees each turn end: the
  flight completes with the reply.
- For a session the operator started directly in a harness, Scout sees only
  what its hooks and session tracking report.

**Nearby mechanisms, unchanged by this spec**

- Task callbacks (`scout ask --callback`): a sandboxed module that runs once
  when one task ends.
- CLI extensions (`docs/extensions.md`): trusted native artifacts that add
  `scout <verb>`.

## Goals

1. Map the lifecycle of Claude Code, Codex and Antigravity onto one set of
   Scout lifecycle points.
2. Install a hook on every point each harness offers, once, with
   `scout hooks apply`.
3. Route every hook, from every harness and every point, to one core function.
   Changing behavior means changing that function.
4. Never slow down or break a harness turn because of Scout.

## Exclusions

- Changing how permission prompts are answered. `PermissionRequest` keeps its
  current wrapper and path. Folding it into this design is an open question.
- Operator-written handler files. Behavior lives in Scout's code. Handler
  files are an open question for later.
- Forwarding lifecycle events to other mesh nodes. They stay on the node where
  the harness runs.

## Lifecycle map

| Scout point | Claude Code | Codex | Antigravity | Scout-launched session |
|---|---|---|---|---|
| `sessionStart` | `SessionStart` | To verify | None | Broker: session launched |
| `promptSubmit` | `UserPromptSubmit` | To verify | None | Broker: ask delivered |
| `toolBefore` | `PreToolUse` | To verify | `PreToolUse` | Harness hook |
| `toolAfter` | `PostToolUse` | To verify | `PostToolUse` | Harness hook |
| `turnEnd` | `Stop` | Turn-complete notification, to verify | `Stop` | Broker: flight completed |
| `subagentEnd` | `SubagentStop` | None | None | Harness hook |
| `compact` | `PreCompact` | None | None | Harness hook |
| `sessionEnd` | `SessionEnd` | To verify | None | Broker: session ended |

A point a harness does not offer stays empty for that harness. The core
function simply never sees that point from that harness.

## Design

### One hook script, one command

- Every installed hook runs the same wrapper, `openscout-lifecycle.sh`. The
  wrapper runs `exec <scout> lifecycle <harness> <hook-point>` and reads the
  hook's JSON on stdin.
- `scout lifecycle` converts the input into a lifecycle event. It posts the
  event to the broker at `POST /v1/lifecycle`, with a 1 s timeout.
- `scout lifecycle` always exits 0 and prints nothing a harness would act on.
  If the broker is down or slow, it drops the event and records the drop in a
  counter, which `scout hooks status` shows.
- `scout hooks apply` adds this wrapper to every hook point in the lifecycle
  map. It leaves the existing `PermissionRequest` entry and other hooks as
  they are.
- `scout hooks status` reports each point per harness as applied, absent or
  stale.
- The wrapper never changes when Scout's behavior changes. Only the core
  function changes, so `scout hooks apply` is needed again only when a harness
  adds a hook point or changes its format.

### The lifecycle event

```ts
type LifecycleEvent = {
  id: string;            // lce-<time36>-<rand>
  point: LifecyclePoint; // "sessionStart" | "promptSubmit" | ... | "sessionEnd"
  at: number;            // epoch ms
  harness: "claude" | "codex" | "antigravity" | "scout";
  nodeId: string;
  sessionId: string;     // Scout session id when known, else the harness's
  taskId?: string;       // work item id, when the turn belongs to a task
  flightId?: string;
  project?: string;      // project root
  payload: Record<string, unknown>;
};
```

Payload by point:

| Point | Payload |
|---|---|
| `sessionStart` | `cwd`, `source` (startup, resume) |
| `promptSubmit` | `text` (first 2,000 characters) |
| `toolBefore` | `tool`, `input` (first 2,000 characters) |
| `toolAfter` | `tool`, `ok` |
| `turnEnd` | `reply` (first 20,000 characters), `truncated`, `scope` |
| `subagentEnd` | `reply` (first 2,000 characters) |
| `compact` | `trigger` |
| `sessionEnd` | `reason` |

- `scope` uses the classifier Scout's feed already has
  (`classifyResultScope`): characters, words, headings, tables, read minutes,
  and a kind from `micro` to `document`.
- For a session Scout launched, `turnEnd` comes from the broker's flight
  completion, with `harness: "scout"`. The broker drops the same turn from the
  harness hook. The key is the session id plus the reply message id.

### One core function

Every lifecycle event, from every harness and every point, goes to one
function in `packages/runtime/src/lifecycle.ts`:

```ts
export async function onLifecycle(event: LifecycleEvent, scout: Scout): Promise<void> {
  await run(event, [
    presentDecisions,
    // add a behavior here
  ], scout);
}
```

- There is one entry point, not one per harness and not one per point. The
  hook script, the broker route and the core function are each written once.
- Harness differences end at the hook script. By the time an event reaches
  `onLifecycle`, it has the same shape whichever harness sent it.
- A behavior is a small named function that receives every event and returns
  early when the event is not its concern. For example, `presentDecisions`
  acts only on `turnEnd`.
- `run` calls every behavior in the list, in order. It catches and records an
  error in one behavior, and the next behavior still runs.
- `scout` is the broker's own services: posting to the feed, notifying the
  operator, reading a task and, once it exists, building a proposal page.
- `onLifecycle` runs after the broker has answered the hook. It can never
  delay a harness turn.

### Visibility

- The broker keeps the last 1,000 lifecycle events in memory, with the
  behaviors each one ran and their outcomes. `scout lifecycle tail` shows them.
- A behavior that fails is recorded with its error. The broker's log gets one
  line per failure.

## Worked example: present decisions

```ts
async function presentDecisions(event: LifecycleEvent, scout: Scout) {
  if (event.point !== "turnEnd") return;
  const { reply, scope } = event.payload;
  if (scope.kind !== "document" || !asksToDecide(reply)) return;
  await scout.present({ taskId: event.taskId, markdown: reply });
}
```

Adding it is one line in `onLifecycle`'s list. It then runs for Claude Code,
Antigravity, Codex and sessions Scout launched alike.

`asksToDecide` and `scout.present` belong to the proposal page feature, which
has its own spec. The point here is where the trigger lives: in the one core
function, the same for every harness.

## Failure behavior

| Failure | Behavior | Recovery |
|---|---|---|
| Broker down or slower than 1 s | The hook exits 0. The event is dropped and counted. | `scout hooks status` shows the count. Nothing to recover. |
| A behavior throws | The error is recorded. The next behavior in the list still runs. The harness is unaffected. | Fix the behavior in Scout. |
| A harness changes its hook format | `scout hooks status` reports `stale`. | `scout hooks apply`. |
| A harness lacks a point | That point's function never runs for that harness. | None needed. |

## Acceptance checks

1. After `scout hooks apply`, a Claude Code session started outside Scout
   produces `sessionStart`, `promptSubmit`, `toolBefore`, `toolAfter` and
   `turnEnd` in `scout lifecycle tail`.
2. With the broker stopped, a Claude Code turn completes normally, and
   `scout hooks status` shows the dropped events.
3. A turn in a session Scout launched produces one `turnEnd`, not two.
4. A behavior added to `onLifecycle`'s list runs for Claude Code, Antigravity
   and Scout-launched sessions without any change to their settings files.
5. A behavior that throws does not stop the next behavior in the list, and the
   harness turn is not delayed.
6. Every installed hook, for every harness and point, reaches `onLifecycle`.
   No other entry point exists.
7. `scout hooks remove` removes every Scout entry and leaves non-Scout hooks in
   each settings file byte-for-byte unchanged.

## Implementation steps

Each step can ship on its own.

1. The lifecycle module with `onLifecycle` and an empty behavior list,
   `POST /v1/lifecycle`, the event buffer and `scout lifecycle tail`. The
   broker sends `turnEnd` and `sessionEnd` to `onLifecycle` for sessions it
   launched.
2. The `scout lifecycle` command, the wrapper, and `scout hooks apply` for
   every Claude Code point in the map.
3. Antigravity: its existing entry also posts lifecycle events.
4. The first behavior, `presentDecisions`, once the proposal page exists.
5. Codex, after its hook surface is confirmed.

## Open questions

1. **Codex.** Which lifecycle points does the installed Codex version offer,
   and does its turn-complete notification carry the reply text? This needs
   checking against the Codex version on each node.
2. **Permissions.** Should `PermissionRequest` become a lifecycle point with a
   function that can answer, so permission handling lives in the same module?
   That point blocks the harness, so it needs its own time limit and rules.
3. **Dropped events.** Should the hook write events to a small local file when
   the broker is down, so the broker can read them later?
4. **Operator behaviors.** Should the operator be able to add a behavior
   without changing Scout, for example as a sandboxed file run in the
   task-callback engine? Version 1 keeps behavior in Scout's code.
5. **Privacy.** `turnEnd` carries up to 20,000 characters of reply text into
   the broker's memory buffer. That is acceptable on the operator's own node.
   Review it before events leave the node.
