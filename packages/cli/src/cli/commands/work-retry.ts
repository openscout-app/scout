import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { retryScoutWorkItem } from "../../lib/core/broker/service.ts";

export const WORK_RETRY_HELP = "Usage: scout work-retry <workId> [--attempt <number>]\n\nRetry the original ask in a fresh session, whatever the failure cause. Without --attempt the runtime uses the next attempt, or repeats the pending one after an uncertain receipt. Reuse the same attempt to recover its receipt.";

export function parseWorkRetryOptions(args: string[]): { workId: string; attempt?: number } | null {
  if (!args.length || args.includes("--help") || args.includes("-h")) return null;
  const [workId, ...rest] = args;
  if (!workId || workId.startsWith("-")) throw new ScoutCliError(WORK_RETRY_HELP);
  if (!rest.length) return { workId };
  const [flag, value, ...extra] = rest;
  const raw = flag?.startsWith("--attempt=") ? flag.slice("--attempt=".length) : flag === "--attempt" ? value : undefined;
  const leftover = flag?.startsWith("--attempt=") ? [value, ...extra].filter(item => item !== undefined) : extra;
  const attempt = Number(raw);
  if (raw === undefined || !raw.trim() || leftover.length || !Number.isSafeInteger(attempt) || attempt < 1) {
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
