import { randomUUID } from "node:crypto";

import type { OperatorCardAnswer, OperatorCardView } from "@openscout/protocol";
import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export function renderDecisionCommandHelp(): string {
  return [
    "Usage:",
    "  scout decision list [--all] [--json]",
    "  scout decision show <id> [--json]",
    "  scout decision answer <id> <answer> [<option>] [--note <text>] [--request-id <id>] [--json]",
    "",
    "Operator asks as decision cards. The runtime makes each card once: the agent's own",
    "(scout ask --operator --decision), one synthesized from the ask, or a permission card.",
    "An ask with no card shows its plain question. <id> is the question record, the ask's",
    "message id, or its task id.",
    "",
    "Answers for a decision card:",
    "  pick <A|B|C>        choose an option (add --note to say why)",
    "  take                take the agent's pick",
    "  disagree --note …   go with the pick, and say the concern",
    "  else --note …       none of these; say what to do",
    "  more [--note …]     keep the task open and ask the agent for more material",
    "  keep                keep the earlier answer the card found on record",
    "Answers for a permission card: allow, always (only when offered), deny.",
    "",
    "The answer goes back to the asking session as its task's reply, with a one-line",
    "text form for harnesses that read only text.",
  ].join("\n");
}

const ANSWER_KINDS: Record<string, OperatorCardAnswer["kind"]> = {
  pick: "pick", take: "take_pick", take_pick: "take_pick", disagree: "disagree_go", disagree_go: "disagree_go",
  else: "something_else", something_else: "something_else", more: "show_more", show_more: "show_more",
  keep: "keep_earlier", keep_earlier: "keep_earlier",
  allow: "allow_once", allow_once: "allow_once", always: "allow_always", allow_always: "allow_always", deny: "deny",
};

type Options = {
  command: "list" | "show" | "answer";
  id?: string;
  answer?: OperatorCardAnswer;
  all: boolean;
  requestId?: string;
};

function parse(args: string[]): Options | "help" {
  if (!args.length || args.includes("--help") || args.includes("-h")) return "help";
  const [command, ...rest] = args;
  if (command !== "list" && command !== "show" && command !== "answer") throw new ScoutCliError(`unknown decision command ${command} (see scout decision --help)`);
  const positional: string[] = [];
  let note: string | undefined;
  let requestId: string | undefined;
  let all = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--all") { all = true; continue; }
    if (arg === "--json") continue;
    if (arg === "--note" || arg === "--request-id") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ScoutCliError(`${arg} needs a value`);
      if (arg === "--note") note = value; else requestId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new ScoutCliError(`unexpected flag for decision: ${arg}`);
    positional.push(arg);
  }
  if (command === "list") {
    if (positional.length) throw new ScoutCliError("scout decision list takes no arguments");
    return { command, all };
  }
  const id = positional[0];
  if (!id) throw new ScoutCliError(`scout decision ${command} needs an id`);
  if (command === "show") return { command, id, all };
  const kind = ANSWER_KINDS[positional[1] ?? ""];
  if (!kind) throw new ScoutCliError("scout decision answer needs an answer: pick, take, disagree, else, more, keep, allow, always or deny");
  const key = positional[2]?.toUpperCase();
  if (kind === "pick" && !key) throw new ScoutCliError("pick needs an option: A, B or C");
  const answer = { kind, ...(key ? { key } : {}), ...(note !== undefined ? { note } : {}) } as OperatorCardAnswer;
  return { command, id, answer, all, ...(requestId ? { requestId } : {}) };
}

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 16);
}

export function renderDecisionView(view: OperatorCardView): string {
  const lines: string[] = [];
  const card = view.card;
  lines.push(`${view.id}  ${view.state}${view.origin ? ` · ${view.origin} card` : " · plain ask"}  ${when(view.createdAt)}`);
  if (!card) {
    lines.push(`  ${view.plain.question}`);
    if (view.plain.options.length) lines.push(`  options: ${view.plain.options.join(" / ")}`);
    if (view.synthesis) lines.push(`  no card: ${view.synthesis.outcome}${view.synthesis.error ? ` (${view.synthesis.error})` : ""}`);
  } else if (card.kind === "decision") {
    lines.push(`  ${card.question}  [${card.door.replace("_", "-")} door]`);
    for (const option of card.options) {
      const marks = [card.pick?.key === option.key ? "pick" : "", card.defaultKey === option.key ? "default" : "", option.picture ? "picture" : ""].filter(Boolean);
      lines.push(`  ${option.key}  ${option.label}${marks.length ? ` (${marks.join(", ")})` : ""}: ${option.result} · undo ${option.undo}`);
    }
    if (card.pick) lines.push(`  why ${card.pick.key}: ${card.pick.why}`);
    if (card.costOfWait) lines.push(`  waiting: ${card.costOfWait}`);
    if (card.alreadyDecided) lines.push(`  already decided ${card.alreadyDecided.at.slice(0, 10)}: "${card.alreadyDecided.quote}"`);
  } else {
    lines.push(`  ${card.question}`);
    lines.push(`  action: ${card.action.summary}${card.action.tool ? ` · ${card.action.tool}` : ""}`);
    if (card.action.command) lines.push(`  command: ${card.action.command}`);
    if (card.action.target) lines.push(`  target: ${card.action.target}`);
    const where = [card.where.project, card.where.session, card.where.harness, card.where.host].filter(Boolean).join(" · ");
    if (where) lines.push(`  where: ${where}`);
    lines.push(`  scope: ${card.scope}`);
    if (card.reason) lines.push(`  reason: ${card.reason}`);
    lines.push(`  answers: ${card.answers.map((answer) => answer.label).join(" / ")}`);
  }
  if (view.requests?.length) lines.push(`  asked for more ${view.requests.length}×${view.requests.at(-1)?.note ? `: ${view.requests.at(-1)!.note}` : ""}`);
  if (view.answer) lines.push(`  answer (${view.answer.by}): ${view.answer.text}`);
  return lines.join("\n");
}

export async function runDecisionCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const options = parse(args);
  if (options === "help") { context.output.writeText(renderDecisionCommandHelp()); return; }
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  const socketPath = context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined;
  const signal = AbortSignal.timeout(15_000);
  try {
    if (options.command === "list") {
      const result = await requestScoutBrokerJson<{ decisions: OperatorCardView[] }>(baseUrl, `/v1/decisions${options.all ? "?state=all" : ""}`, { method: "GET", socketPath, signal });
      context.output.writeValue(result, (value) => value.decisions.length ? value.decisions.map(renderDecisionView).join("\n\n") : "No open operator asks.");
      return;
    }
    if (options.command === "show") {
      const result = await requestScoutBrokerJson<{ decision: OperatorCardView }>(baseUrl, `/v1/decisions/${encodeURIComponent(options.id!)}`, { method: "GET", socketPath, signal });
      context.output.writeValue(result, (value) => renderDecisionView(value.decision));
      return;
    }
    const requestId = options.requestId ?? `decision-${randomUUID()}`;
    context.stderr(`request ${requestId} (reuse with --request-id after an uncertain answer)`);
    const result = await requestScoutBrokerJson<{ decision: OperatorCardView }>(baseUrl, "/v1/decisions/answer", {
      method: "POST", socketPath, signal, body: { id: options.id, answer: options.answer, requestId },
    });
    context.output.writeValue(result, (value) => renderDecisionView(value.decision));
  } catch (error) {
    if (error instanceof ScoutBrokerHttpError && error.status === 404 && options.command === "list") {
      throw new ScoutCliError("this runtime has no decision cards yet; update Scout");
    }
    throw error;
  }
}

/** What MCP's decision_read uses: one ask by id, or the open (or all) asks. */
export async function readBrokerDecisions(
  input: { id?: string; all?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ decision: OperatorCardView } | { decisions: OperatorCardView[] }> {
  const baseUrl = env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  const socketPath = env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined;
  const signal = AbortSignal.timeout(15_000);
  if (input.id) {
    return requestScoutBrokerJson<{ decision: OperatorCardView }>(baseUrl, `/v1/decisions/${encodeURIComponent(input.id)}`, { method: "GET", socketPath, signal });
  }
  return requestScoutBrokerJson<{ decisions: OperatorCardView[] }>(baseUrl, `/v1/decisions${input.all ? "?state=all" : ""}`, { method: "GET", socketPath, signal });
}
