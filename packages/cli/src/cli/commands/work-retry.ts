import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { retryScoutWorkItem } from "../../lib/core/broker/service.ts";

export const WORK_RETRY_HELP = "Usage: scout work-retry <workId> --attempt <number>\n\nRetry the original ask in a fresh session. Start at 1; reuse the same attempt after an uncertain receipt. Only endpoint_lost and harness_start can retry.";

export function parseWorkRetryOptions(args: string[]) {
  if (!args.length || args.includes("--help") || args.includes("-h")) return null;
  const [workId, flag, raw, ...rest] = args;
  const attempt = Number(raw);
  if (!workId || workId.startsWith("-") || flag !== "--attempt" || rest.length || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ScoutCliError(WORK_RETRY_HELP);
  }
  return { workId, attempt };
}

export async function runWorkRetryCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const input = parseWorkRetryOptions(args);
  if (!input) { context.output.writeText(WORK_RETRY_HELP); return; }
  const result = await retryScoutWorkItem(input);
  context.output.writeValue(result, value => `Retry ${value.attempt} accepted for ${value.workId}. Flight: ${value.flightId}\nRecover this receipt: scout work-retry ${value.workId} --attempt ${value.attempt}`);
}
