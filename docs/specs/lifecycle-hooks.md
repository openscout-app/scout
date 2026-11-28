# Lifecycle hooks

Status: proposal. Nothing in this spec is implemented. "Current behavior"
describes `main` as of 2026-11-28 (e22da43d).

Scout installs one hook script into every lifecycle point of every harness it
supports, once. From there, three layers:

- **Adapters**, one per harness. Each turns that harness's hook input into one
  common event. Anything special about a harness is handled in its adapter.
- **Moments**, one Scout function per lifecycle moment (`turnEnd`, `compact`,
  `subagentEnd` and so on). Each is the same for every harness.
- **One dispatcher**, `onLifecycle(event)`, which every hook reaches and which
  calls the function for the event's moment.

To change what Scout does at a moment, change that moment's function. Nobody
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
2. Install a hook on every point each harness offers, all at once, with
   `scout hooks apply`, even where Scout does nothing at that point yet.
   Install and uninstall are clean and exact.
3. Give each lifecycle moment one Scout function, shared by every harness.
   Changing behavior at a moment means changing that function.
4. Keep everything harness-specific in that harness's adapter.
5. Never slow down or break a harness turn because of Scout.

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

A point a harness does not offer stays empty for that harness. That moment's
function simply never runs for that harness.

## Design

### One hook script, one command

Every installed hook runs the same wrapper, `openscout-lifecycle.sh`, with
two arguments: the harness and the hook point.

The wrapper must cost almost nothing, because `PreToolUse` and `PostToolUse`
fire on every tool call, and every hook is installed even while its moment is
a no-op. So the wrapper does not start the Scout CLI and does not wait for the
broker:

```sh
#!/bin/sh
# Scout lifecycle hook. `scout hooks remove` takes it out.
input=$(cat)
printf '%s' "$input" | curl -s -m 1 --unix-socket "<broker socket>" \
  -H 'content-type: application/json' --data-binary @- \
  "http://scout/v1/lifecycle/raw?harness=$1&point=$2" >/dev/null 2>&1 &
exit 0
```

- It reads the hook's JSON, starts the post in the background and exits 0 at
  once. The harness never waits on Scout.
- It posts the raw input. The broker runs the harness's adapter, so adapters
  live in one process and change without reinstalling anything.
- It prints nothing a harness would act on.
- If the broker is down or slow, the background post fails silently and the
  event is lost. The broker cannot count drops it never saw, so
  `scout hooks status` instead reports the last event received per harness
  and point.
- `scout hooks apply` writes the broker's socket path into the wrapper. If the
  socket path changes, `scout hooks status` reports the wrapper as stale.
- The wrapper never changes when Scout's behavior changes. Only adapters and
  moment functions change, so `scout hooks apply` is needed again only when a
  harness adds a hook point or changes its format.

### Install and uninstall

- `scout hooks apply` installs the wrapper on every hook point in the
  lifecycle map, for every harness it finds, in one run. Every moment starts
  as a no-op, so installing everything changes nothing a harness does.
- Apply is idempotent. Running it twice leaves each settings file as one run
  did.
- `scout hooks apply --dry-run` prints the exact change to each settings file
  and writes nothing.
- `scout hooks remove` takes out every Scout entry and the wrapper script. It
  leaves every other hook, and the rest of each settings file, byte-for-byte
  unchanged. This uses the existing exact-removal logic in
  `harness-hooks.ts`.
- `scout hooks status` lists every harness and hook point: applied, absent or
  stale, and the time of the last event received.
- The existing `PermissionRequest` entry stays separate and is unaffected by
  apply and remove of lifecycle hooks.

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

### Code layout

```text
packages/runtime/src/lifecycle/
  adapters/
    claude.ts        Claude Code hook input -> LifecycleEvent
    codex.ts         Codex notification -> LifecycleEvent
    antigravity.ts   Antigravity hook input -> LifecycleEvent
    scout.ts         broker-launched sessions -> LifecycleEvent
  moments.ts         one function per moment, shared by every harness
  index.ts           onLifecycle: the one dispatcher
```

### Adapters: one per harness

```ts
type LifecycleAdapter = {
  harness: "claude" | "codex" | "antigravity" | "scout";
  /** Which of the harness's hook points map to which moment. */
  points: Partial<Record<LifecyclePoint, string>>;
  /** The harness's raw hook input, as a common event; null to ignore it. */
  toEvent(point: LifecyclePoint, input: unknown): LifecycleEvent | null;
};
```

- Everything harness-specific lives here: field names, matchers, how a session
  id or reply text is found, which tools count, and quirks. For example,
  Antigravity's adapter applies its tool matcher, and Codex's adapter reads the
  reply from its turn-complete notification.
- An adapter returns `null` for input it should ignore, such as an Antigravity
  `PostToolUse` for a tool outside its matcher.
- `scout hooks apply` reads each adapter's `points` to know which hook points
  to install.
- Adding a harness means adding one adapter. The moments do not change.

### Moments: one function each, shared by every harness

```ts
export const moments: Record<LifecyclePoint, Moment> = {
  sessionStart: async (event, scout) => {},
  promptSubmit: async (event, scout) => {},
  toolBefore:   async (event, scout) => {},
  toolAfter:    async (event, scout) => {},
  turnEnd:      async (event, scout) => {
    await run(event, scout, [presentDecisions]);
  },
  subagentEnd:  async (event, scout) => {},
  compact:      async (event, scout) => {},
  sessionEnd:   async (event, scout) => {},
};
```

- There is one function per moment, never one per harness. `turnEnd` is the
  same code whether the turn ended in Claude Code, Codex, Antigravity or a
  session Scout launched.
- A moment's function is a list of small named behaviors, run by `run`. `run`
  catches and records an error in one behavior, and the next one still runs.
- A moment never checks which harness sent the event. A difference between
  harnesses belongs in an adapter. When a moment genuinely needs to know, it
  reads `event.harness`, and the spec for that behavior says why.
- `scout` is the broker's own services: posting to the feed, notifying the
  operator, reading a task and, once it exists, building a proposal page.

### The dispatcher

```ts
export async function onLifecycle(event: LifecycleEvent, scout: Scout): Promise<void> {
  record(event);
  await moments[event.point](event, scout);
}
```

- Every hook from every harness, and every broker-launched event, reaches
  `onLifecycle`. There is no other entry point.
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
  const { reply, scope } = event.payload;
  if (scope.kind !== "document" || !asksToDecide(reply)) return;
  await scout.present({ taskId: event.taskId, markdown: reply });
}
```

Adding it is one entry in `turnEnd`'s list. It then runs for Claude Code,
Antigravity, Codex and sessions Scout launched alike, because each adapter
already delivers the reply in the same field.

`asksToDecide` and `scout.present` belong to the proposal page feature, which
has its own spec. The point here is where the trigger lives: in one moment's
function, the same for every harness.

## Failure behavior

| Failure | Behavior | Recovery |
|---|---|---|
| Broker down or slow | The hook has already exited 0. The background post fails and the event is lost. | `scout hooks status` shows the last event received per point, so a gap is visible. Nothing to recover. |
| A behavior throws | The error is recorded. The next behavior in the moment's list still runs. The harness is unaffected. | Fix the behavior in Scout. |
| An adapter cannot read an input | The adapter returns `null`, and the input is counted as unreadable. | `scout hooks status` shows the count per harness. Fix the adapter. |
| A harness changes its hook format | `scout hooks status` reports `stale`. | `scout hooks apply`. |
| A harness lacks a point | That point's function never runs for that harness. | None needed. |

## Acceptance checks

1. One `scout hooks apply` installs the wrapper on every point in the
   lifecycle map for every harness found. After it, a Claude Code session
   started outside Scout produces `sessionStart`, `promptSubmit`, `toolBefore`,
   `toolAfter` and `turnEnd` in `scout lifecycle tail`.
2. With every moment a no-op, the wrapper adds less than 10 ms to a hook, as
   measured from the harness's side over 100 `PreToolUse` calls.
3. With the broker stopped, a Claude Code turn completes normally and is not
   slower.
4. Running `scout hooks apply` twice leaves each settings file as one run did.
   `--dry-run` writes nothing.
5. A turn in a session Scout launched produces one `turnEnd`, not two.
6. A behavior added to `turnEnd` runs for Claude Code, Antigravity and
   Scout-launched sessions without any change to their settings files.
7. A behavior that throws does not stop the next behavior in the list, and the
   harness turn is not delayed.
8. Every installed hook, for every harness and point, reaches `onLifecycle`.
   No other entry point exists.
9. No code in `moments.ts` branches on harness without a stated reason. A
   change in how a harness reports something touches only its adapter.
10. `scout hooks remove` removes every Scout entry and the wrapper script, and
    leaves non-Scout hooks in each settings file byte-for-byte unchanged.
    Apply followed by remove restores each settings file exactly.

## Implementation steps

Each step can ship on its own.

1. All the plumbing, with every moment a no-op:
   - the lifecycle module, `onLifecycle` and empty moments;
   - `POST /v1/lifecycle/raw`, the event buffer and `scout lifecycle tail`;
   - the wrapper, and `scout hooks apply`, `remove`, `status` and
     `--dry-run` for every point of every harness in the map;
   - the Claude Code, Antigravity and `scout` adapters.
   After this step every hook is in place, and nothing a harness does has
   changed.
2. The first behavior, `presentDecisions`, once the proposal page exists.
   From here on, new behavior is a change to a moment, never to hooks.
3. The Codex adapter and its hook points, after its hook surface is confirmed.

## Open questions

1. **Codex.** Which lifecycle points does the installed Codex version offer,
   and does its turn-complete notification carry the reply text? This needs
   checking against the Codex version on each node.
2. **Permissions.** Should `PermissionRequest` become a lifecycle point with a
   function that can answer, so permission handling lives in the same module?
   That point blocks the harness, so it needs its own time limit and rules.
3. **Lost events.** Should the wrapper append an event to a small local file
   when the post fails, so the broker can read it later? This adds a write to
   every hook while the broker is down.
4. **Operator behaviors.** Should the operator be able to add a behavior
   without changing Scout, for example as a sandboxed file run in the
   task-callback engine? Version 1 keeps behavior in Scout's code.
5. **Privacy.** `turnEnd` carries up to 20,000 characters of reply text into
   the broker's memory buffer. That is acceptable on the operator's own node.
   Review it before events leave the node.
