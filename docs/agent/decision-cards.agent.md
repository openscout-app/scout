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
one decision-pack decision. Rules:

- 2 or 3 options, keyed `A`, `B`, `C` in order, with different labels of at
  most 18 characters.
- Each option has a `result` and an `undo` of `easy` or `hard`.
- Exactly one `pick` with a line of `why`.
- `door` is `one_way` or `two_way`. A `defaultKey` is allowed only on
  `two_way`.
- The question holds no ids, PR numbers or paths. Put them in `details`.
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
  same ask text reuses the cached card without a model call.
- **Fields first:** `--option` labels are the options, verbatim. A default
  makes the door two-way and sets `defaultKey`. The deadline gives
  `costOfWait`. The model only describes options.
- **Never invents:** every option the model adds, and the pick, must quote the
  ask verbatim. A pick must also quote a stated preference ("I'd go with ...",
  "recommend", "prefer"). Fewer than 2 grounded options, more than 3, or
  `isChoice: false` leaves a `question`. With no pick, the card has none.
- **Model:** `claude-haiku-5-5`, one structured-output call, effort low, no
  thinking, no retries, a 20 s timeout. Override the model with
  `SCOUT_DECISION_SYNTHESIS_MODEL`. Turn synthesis off with
  `SCOUT_DECISION_SYNTHESIS=0`. It runs only when the runtime's environment
  has `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, or an
  Anthropic config directory. Otherwise asks stay plain.
- **Cost:** about 1,000 input and 250 output tokens, about $0.0002 per card.
  Calls run one at a time. `decisionSynthesis` records the tokens and
  `costUsd` that were actually used.
- **Failure:** the record keeps `outcome: "failed"` and the error. The ask stays
  plain.

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
  question: string;                       // ≤ 60
  pick?: { key: "A"|"B"|"C"; why: string };  // required on agent cards
  options: Array<{
    key: "A"|"B"|"C"; label: string;      // ≤ 18 (≤ 60 synthesized)
    result: string;                        // ≤ 90
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
                inputTokens?: number; outputTokens?: number; costUsd?: number; error?: string; at: number };
  answer?: { answer: DecisionAnswer | PermissionAnswer; text: string; at: number; by: "operator"|"default" };
  requests?: Array<{ note?: string; at: number }>;   // show_more history
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
to retry.

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
- A runtime started by launchd may not have `ANTHROPIC_API_KEY`. It then does
  not synthesize, and asks stay plain.
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
