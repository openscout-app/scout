# Decision cards

## Role

A decision card is the one shape every surface shows for an operator ask. The
runtime makes the card. Surfaces read it and send answers back. No surface
builds a card itself.

A card has one of two kinds:

- `decision`: a choice between 2 or 3 options.
- `permission`: a permission request: what runs, where, its scope, and the
  answers the runtime can deliver.

An ask with no card stays a plain question. A surface shows `plain`. It never
shows an empty card.

## Where a card comes from

| Origin | Source | When |
|---|---|---|
| `agent` | `scout ask --operator --decision <file.json>` or MCP `ask { operator, decision }` | The agent gives the card when it asks. |
| `synthesized` | The runtime, from the ask, once | A need or consult ask with no card, when a model is configured. |
| `permission` | A native or Scout permission request (`metadata.permissionRequest`), or `--permission` | Always. It is built from the request's own payload. |

### Agent cards

The file holds our card shape (below), a decision-pack `pack.json` (use
`file#id` to pick one decision, or leave it out when only one is open), or
one decision-pack decision.

Scout refuses a card only for what it would get wrong. These rules refuse the
ask with `--decision is not valid`:

- 2 or 3 options, keyed `A`, `B`, `C` in order, with different labels.
- Each option has a label, a `result` and an `undo` of `easy` or `hard`.
- Exactly one `pick`, naming one of the options, with a line of `why`.
- `door` is `one_way` or `two_way`. A `defaultKey` names one of the options
  and is allowed only on `two_way`.

Length and wording are guidance, never a refusal. Aim for a question of at
most 60 characters, labels of at most 18 and no ids or paths in the question.
The runtime clips a longer field to the length in the type below and keeps a
clipped question's full words at the top of `details`. Labels are kept up to
60 characters.
- Pictures are local paths, `{ path, callouts? }`, relative to the file. The
  CLI or MCP reads them, sends them as images, and the runtime stores them as
  attachments on the ask's message. A stored card holds only an
  `attachmentId` and the pixel size read from the image. It never holds a
  path. There are at most 3 pictures.
- The labels become the task's `options`. The default label becomes its
  `defaultAction`. A conflicting `--option` or `--default-action` is refused.
- `--decision` cannot be combined with `--permission` or `--fyi`.

Decision-pack mapping: `title` becomes the question, `button` the label, the
`recommended: true` option the pick (its `bluf`, without "I recommend X:",
becomes `why`), and `shots` the pictures. `cost_of_wait` maps directly.
`details_md`, `impact` and `unknowns` become `details`. A `history_check` of
`doubtful` becomes `alreadyDecided`. `default_key` is kept only on a two-way
door with `gate: none`.

### Synthesis

- **Trigger:** the ask's question record is created (a need, or a consult ask
  with a default). The ask carries no agent card and is not a permission ask.
  At startup the runtime also queues up to 20 open asks that have no result.
- **Once:** the result (`card`, `question` or `failed`) is stored on the record
  as `decisionSynthesis`. A record with a result is not synthesized again. A
  result is cached by `sourceHash`: sha256 of the normalized question, body,
  options, `because` and default, plus the prompt version and the model. The
  same ask text reuses the cached card without a model call. The deadline is
  not in the key, so the cached card holds nothing derived from it.
- **Fields first:** `--option` labels are the options, verbatim. A default
  makes the door two-way and sets `defaultKey`. The ask's own deadline gives
  `costOfWait`, derived for each ask and never taken from the cache. The
  model only describes options.
- **Never invents:** every option the model adds, and the pick, must quote the
  ask verbatim. A pick must also quote a stated preference ("I'd go with ...",
  "recommend", "prefer"). Fewer than 2 grounded options, more than 3, or
  `isChoice: false` leaves a `question`. With no pick, the card has none.
- **Path:** one turn through Scout's Claude CLI path,
  `invokeClaudeStreamJsonAgent` (`claude --print`, stream-json), on the
  operator's signed-in harness. There is no API key and no SDK. Each card gets
  a fresh session named `scout-decision-synthesis`: the turn runs, then
  `shutdownClaudeStreamJsonAgent(..., { resetSession: true })` ends it, so no
  card sees another's text. The turn runs in an empty folder under the
  session's runtime directory with `--model haiku --effort low --tools ""
  --strict-mcp-config --disable-slash-commands --no-session-persistence` and a
  short `--system-prompt`. It has no tools, no MCP servers and no project
  instructions, and it writes no transcript.
- **Model:** the harness's own `haiku` alias, which Claude Code resolves to its
  current small model (`claude-haiku-5-5` today). Override it with
  `SCOUT_DECISION_SYNTHESIS_MODEL`, which takes any value `claude --model`
  accepts. Turn synthesis off with `SCOUT_DECISION_SYNTHESIS=0` (or `off`).
  Synthesis runs only when the Claude CLI resolves (`resolveClaudeExecutable`).
  Otherwise asks stay plain.
- **Output check:** the model gets the reply's shape and one rule per field,
  not a raw JSON Schema; given the raw schema, Haiku echoed it back. The
  runtime then checks the reply strictly against `DECISION_MODEL_OUTPUT_SCHEMA`
  (`decisionModelOutputProblems`): every required key, no extra keys, and the
  right types and enum values. Any problem is `outcome: "failed"`, so the ask
  stays plain. A card built from valid output is checked again by
  `validateDecisionCard`.
- **Cost:** time and plan quota, not dollars. One Haiku turn takes about 3 to
  6 s of wall time. Of that, Claude Code start-up takes under 1 s, and the
  model takes 2.7 to 5.3 s. The turn uses about 2.4k input tokens (the
  system prompt and the ask) and 230 to 830 output tokens, including any
  thinking. Calls run one at a time and never retry. `decisionSynthesis`
  records `model`, `via: "claude-cli"` and `durationMs`.
- **Failure:** the record keeps `outcome: "failed"` and the error, which
  covers a failed turn, a timeout (90 s), no JSON, or JSON that breaks the
  schema. The ask stays plain. A failed result is not cached, but the same
  record is not tried again.

### History check

When a decision card is stored, the runtime searches the operator's earlier
answers: closed operator questions that the operator answered, not defaults.
A match needs most content words shared (Jaccard ≥ 0.6, at least 3 shared
words) and, when both asks have options, matching options. The most recent
match fills `alreadyDecided` with the operator's words, the date, and the
option they chose if their answer starts with its label. It is shown, never
used to answer. `keep_earlier` is the operator's way to reuse it.

### Free-text questions (not built)

An agent that ends its turn with a question instead of `scout ask --operator`
creates no question record and no card today. The hook point:
`taskCompletionMessage` in `packages/runtime/src/broker-tasks.ts` sees each
automatic harness final before it completes a task. Observed sessions outside
tasks surface final assistant text through `readTaskTail`
(`packages/agent-sessions/src/task-tail.ts`). A final that ends in a question
to the operator can be posted as a question record there and then passed to
`BrokerDecisionCardService.register`. The same synthesis rules apply.

## Shapes

`@openscout/protocol` (`packages/protocol/src/decision-cards.ts`) defines
these:

```ts
type DecisionCard = {
  kind: "decision"; version: 1;
  question: string;                       // clipped to 60
  pick?: { key: "A"|"B"|"C"; why: string };  // required on agent cards
  options: Array<{
    key: "A"|"B"|"C"; label: string;      // aim for 18; clipped to 60
    result: string;                        // clipped to 90
    undo: "easy"|"hard"|"unknown";         // unknown: synthesized only
    picture?: { attachmentId: string; width: number; height: number;
                callouts?: Array<{ n: number; box: [x,y,w,h]; note: string }> };
  }>;
  door: "one_way"|"two_way"|"unknown";    // unknown: synthesized only
  defaultKey?: "A"|"B"|"C";               // two_way only
  costOfWait?: string; details?: string;
  alreadyDecided?: { quote: string; at: string; key?: "A"|"B"|"C"; recordId?: string };
  source?: { kind: "decision-pack"; project?: string; id: string; version: number };
};

type PermissionCard = {
  kind: "permission"; version: 1;
  question: string;
  action: { summary: string; tool?: string; command?: string; target?: string;
            fields?: Array<{ key: string; value: string }> };
  where: { project?: string; session?: string; harness?: string; host?: string };
  scope: string;
  reason?: string;              // only the request's own words
  answers: Array<{ kind: "allow_once"|"allow_always"|"deny"; label: string; grants?: string[] }>;
  alreadyDecided?: DecisionAlreadyDecided;
};

type DecisionAnswer = {
  kind: "pick"|"take_pick"|"disagree_go"|"something_else"|"show_more"|"keep_earlier";
  key?: "A"|"B"|"C";            // pick only
  note?: string;                // required for disagree_go and something_else
  regions?: Array<{ optionKey: "A"|"B"|"C"; calloutN?: number; boxPx?: [x,y,w,h] }>;
};
type PermissionAnswer = { kind: "allow_once"|"allow_always"|"deny"; note?: string };

type OperatorCardView = {
  id: string;                   // operator-question:<message> or the permission record
  messageId?: string; conversationId?: string; taskId?: string; askedBy?: string;
  createdAt: number;
  state: "open"|"needs_material"|"answered"|"defaulted"|"closed";
  plain: { question: string; options: string[]; because?: string; defaultAction?: string; answerDeadline?: number };
  card?: DecisionCard | PermissionCard;
  origin?: "agent"|"synthesized"|"permission";
  synthesis?: { outcome: "card"|"question"|"failed"; sourceHash: string; model?: string;
                via?: string; durationMs?: number; cached?: boolean; error?: string; at: number };
  answer?: { answer: DecisionAnswer | PermissionAnswer; text: string; at: number; by: "operator"|"default"; requestId?: string };
  requests?: Array<{ note?: string; at: number; requestId?: string }>;   // show_more history, one per requestId
};
```

### Permission cards

- `action` comes from the native display (`action`, `command`, `target`,
  `fields`, `questions`). Without one, it falls back to the record summary or
  the tool name.
- `where.project` is the project root's folder name. `where.session` is the
  session alias or display name. It is never a raw id.
- `answers` lists only the decisions the request carries. `allow_always`
  appears only when the runtime backs it. For Claude, that is when the native
  prompt suggested a rule, and `grants` names that rule.
- `reason` is the display note, or the session's own words just before the
  call. Nothing else is used.
- An agent's `--permission` ask offers `allow_once` and `deny`.

The card is computed at read time from the request record, so it follows the
request's version. It replaces the companion's `permissionPresentation`.

## Answers

`POST /v1/decisions/answer { id, requestId, answer }` (`scout decision answer`).
`id` is the record id, the ask's message id or its task id. Reuse `requestId`
to retry. The record keeps the answering `requestId`; a repeat with the same
one returns the current view and sends nothing, for every answer kind. A
different `requestId` on a settled ask is refused with 409.

`metadata.decisionAnswer` on a reply is written only by the runtime. A
client's reply metadata never carries it: the runtime removes the key.

| Answer | Effect |
|---|---|
| `pick`, `take_pick`, `disagree_go`, `something_else`, `keep_earlier` | A final task reply from the operator. The body is the one-line text form, and `metadata.decisionAnswer` holds the structure. The task completes and the record closes. |
| `show_more` | A progress reply that names what to add. The task stays open. `state` becomes `needs_material`. |
| `allow_once`, `allow_always`, `deny` | The permission decide path (`once`, `project`, `deny`) at the request's version. |

The one-line form is, for example,
`B (Pro only): only Pro, not Starter. Pointed at callout 3 on B.`

A default applies only to a two-way door, at the existing deadline. When the
window runs out, `expireOperatorTasks` proceeds with `defaultAction`. The card
service then closes the record with `answer.by: "default"`. A one-way card
never gets a default.

Errors: 400 for an answer that does not fit the card, 404 for an unknown id,
409 for a settled ask or a plain ask with no card, 410 for an ended permission
request, and 502 when delivery was not confirmed.

## Reads

| Surface | Read |
|---|---|
| HTTP | `GET /v1/decisions?state=open\|all&limit=N` → `{ decisions: OperatorCardView[] }`; `GET /v1/decisions/:id` → `{ decision }` |
| CLI | `scout decision list [--all] [--json]`, `scout decision show <id> [--json]`, `scout decision answer <id> <answer> [A\|B\|C] [--note …]` |
| MCP | `decision_read { id?, all? }` (read-only) |

The routes are machine-local. A remote transport gets 403.

## Invariants

- The runtime is the only writer. Cards live on question-record metadata
  (`operatorCard`, `operatorCardOrigin`, `decisionSynthesis`, `decisionAnswer`,
  `decisionRequests`). Writing them does not change `updatedAt`.
- A card never holds a local path, an option or pick the ask does not state,
  or a reason the request did not carry.
- A card is made at most once per ask. Answers go through the existing task
  reply path, not a second channel.
- The history check never answers.

## Limits and follow-ups

- Reading decision-pack packs from the plugin's data home is not built. Today
  agents pass the file.
- An ask copied over the mesh can be answered by card only on its home host.
- Synthesis needs the Claude CLI to be installed and signed in. When it is
  missing or signed out, the turn fails and asks stay plain.
- Synthesis runs only through Claude. Other harnesses (Codex, ACP) are not
  wired as a synthesis path.
- More than 3 `--option` values stay a question.

## Code map

- `packages/protocol/src/decision-cards.ts`: shapes, validation, mapping,
  answer text, history match.
- `packages/runtime/src/broker-decision-cards.ts`: the service (register,
  synthesis queue, views, answers, defaults).
- `packages/runtime/src/decision-synthesis.ts`, `decision-synthesis-model.ts`:
  grounding rules and the model call.
- `packages/runtime/src/permission-card.ts`, `decision-card-binding.ts`.
- `packages/cli/src/cli/commands/decision.ts`, `cli/decision-file.ts`, and
  MCP `ask.decision` and `decision_read` in `mcp/scout-mcp.ts`.

## Verification

`bun test packages/protocol/src/decision-cards.test.ts` and
`bun test packages/runtime/src/decision-cards.test.ts`.
