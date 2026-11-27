import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ScoutDeliverAcceptedResponse, ScoutDeliverHttpRequest, ScoutSkillRunRequest, ScoutSkillRunResult, ScoutSkillSummary,
} from "@openscout/protocol";
import { resolveHost, resolveWebPort } from "./local-config.js";
import { listSkills, prepareSkill, skillHarness, SkillLookupError } from "./skills.js";

const text = z.string().trim().min(1);
export const skillRunSchema = z.object({
  name: text,
  brief: z.string().refine(s => Boolean(s.trim()), "A skill needs a brief."),
  target: z.object({ project: text.optional(), harness: text.optional(), host: text.optional() }).strict().optional(),
  currentDirectory: text.optional(),
  requestId: text.max(256).optional(),
  senderId: text.optional(),
  replyToSessionId: text.optional(),
  replyToSessionHarness: text.optional(),
  source: text.optional(),
}).strict() satisfies z.ZodType<ScoutSkillRunRequest>;

// A remote selection must be checked on that host. Only catalog metadata
// crosses the authenticated broker connection. A null response denotes self.
type ForwardCatalog = (input: { nodeSelector: string; method: "GET"; path: string }) => Promise<{ status: number; body: unknown } | null>;
const wireCatalog = z.object({ skills: z.array(z.object({
  name: text, description: text, path: z.string().regex(/^~\/\.(?:agents|claude|codex|cursor)\/skills\/[^/]+\/SKILL\.md$/),
})) });
export async function targetSkills(home: string, harnessName?: string, host?: string, forward?: ForwardCatalog) {
  const harness = skillHarness(harnessName);
  if (host !== undefined) {
    if (!host.trim()) throw new Error("Specify a host.");
    if (!forward) throw new SkillLookupError(503, "skill_catalog_unavailable", "No broker connection to the target host.");
    const query = harness ? "?" + new URLSearchParams({ harness }) : "";
    const remote = await forward({ nodeSelector: host, method: "GET", path: "/v1/mesh/skills" + query });
    if (remote) {
      const catalog = wireCatalog.safeParse(remote.body);
      if (remote.status !== 200 || !catalog.success) {
        throw new SkillLookupError(503, "skill_catalog_unavailable",
          `Cannot read skills on ${host} (HTTP ${remote.status}). Check the host, its broker version and the mesh control grant.`);
      }
      return catalog.data.skills;
    }
  }
  return listSkills(home, harness);
}

// The ordinary ask is bound to the file in the target machine's catalog.
export function skillAsk(skills: ScoutSkillSummary[], input: ScoutSkillRunRequest, home: string): ScoutDeliverHttpRequest {
  const { skill, target, body } = prepareSkill(skills, input, home);
  const metadata = {
    skill: skill.name,
    skillPath: skill.path,
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
      metadata: { source: input.source ?? "scout-skill" },
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

export function skillRunResult(delivery: ScoutDeliverAcceptedResponse): ScoutSkillRunResult {
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
