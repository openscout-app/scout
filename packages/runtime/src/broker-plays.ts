import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ScoutDeliverAcceptedResponse, ScoutDeliverHttpRequest, ScoutPlayRunRequest, ScoutPlayRunResult,
} from "@openscout/protocol";
import { resolveHost, resolveWebPort } from "./local-config.js";
import { playTargetSchema, preparePlay } from "./playbook.js";

const text = z.string().trim().min(1);
export const playRunSchema = z.object({
  name: text,
  inputs: z.record(z.string(), z.string()).optional(),
  target: playTargetSchema.optional(),
  currentDirectory: text.optional(),
  requestId: text.max(256).optional(),
  senderId: text.optional(),
  replyToSessionId: text.optional(),
  replyToSessionHarness: text.optional(),
  source: text.optional(),
}).strict() satisfies z.ZodType<ScoutPlayRunRequest>;

// Feed the ordinary task-ask boundary. Clients provide a name and inputs,
// never a path to a play, a rendered body, or a claim of verified attribution.
export async function playAsk(dir: string, input: ScoutPlayRunRequest): Promise<ScoutDeliverHttpRequest> {
  const { target, body } = await preparePlay(dir, input.name, input.inputs ?? {}, input.target ?? {}, input.currentDirectory);
  const metadata = {
    play: input.name,
    replyMode: "notify",
    ...(input.replyToSessionId && { replyToSessionId: input.replyToSessionId }),
    ...(input.replyToSessionHarness && { replyToSessionHarness: input.replyToSessionHarness }),
  };
  return {
    requestId: input.requestId ?? `ask-${randomUUID()}`,
    intent: "task_ask", task: { version: 1 }, body,
    caller: {
      actorId: input.senderId ?? "operator",
      currentDirectory: input.currentDirectory,
      metadata: { source: input.source ?? "scout-play" },
    },
    target: { kind: "project_path", projectPath: target.project, ...(target.host && { host: target.host }) },
    targetLabel: target.project,
    ensureAwake: true,
    execution: { session: "new", ...(target.harness && { harness: target.harness }) },
    ...(target.host || target.harness ? { projectAgent: { persistence: "one_time" } } : {}),
    replyToSessionId: input.replyToSessionId,
    messageMetadata: metadata, invocationMetadata: metadata,
  };
}

function webOrigin(): string {
  const configured = process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch { /* Use the configured local web port instead. */ }
  }
  const host = process.env.OPENSCOUT_WEB_HOST?.trim() || process.env.SCOUT_WEB_HOST?.trim() || resolveHost();
  const localHost = ["0.0.0.0", "::", "[::]"].includes(host) ? "127.0.0.1" : host;
  const hostname = localHost.includes(":") && !localHost.startsWith("[") ? `[${localHost}]` : localHost;
  return `http://${hostname}:${resolveWebPort()}`;
}

export function playRunResult(delivery: ScoutDeliverAcceptedResponse): ScoutPlayRunResult {
  const receipt = {
    ...delivery.receipt,
    flightId: delivery.flight?.id ?? delivery.receipt.flightId,
    invocationId: delivery.flight?.invocationId,
    workId: delivery.workItem?.id,
    ...(delivery.workPageUnavailable && { workPageUnavailable: true as const }),
  };
  const route = receipt.workId && !receipt.workPageUnavailable
    ? `/work/${encodeURIComponent(receipt.workId)}`
    : "/follow?" + new URLSearchParams({
        view: "session", conversationId: receipt.conversationId,
        ...(receipt.flightId && { flightId: receipt.flightId }),
        ...(receipt.invocationId && { invocationId: receipt.invocationId }),
      });
  return { receipt, followUrl: webOrigin() + route };
}
