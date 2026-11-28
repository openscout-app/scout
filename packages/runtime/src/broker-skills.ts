import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { isSkillFolderName } from "@openscout/protocol";
import type {
  ScoutDeliverAcceptedResponse, ScoutDeliverHttpRequest, ScoutSkillRunRequest, ScoutSkillRunResult,
} from "@openscout/protocol";
import { resolveHost, resolveWebPort } from "./local-config.js";
import { listSkills, registeredSkill, skillRunInput, SkillLookupError } from "./skills.js";

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
  name: text, description: text, source: z.enum(["personal", "linked", "unregistered"]),
  path: text.refine(isAbsolute), directory: text.refine(isAbsolute),
})) });
export async function targetSkills(home: string, query: { name?: string; all?: boolean; host?: string }, forward?: ForwardCatalog) {
  const { name, all, host } = query;
  if (name !== undefined && !isSkillFolderName(name)) throw new SkillLookupError(400, "invalid_skill_name", "Use a registered skill folder name, not a path.");
  if (name !== undefined && all) throw new Error("Only registered skills can be referenced by name.");
  if (host !== undefined) {
    if (!host.trim()) throw new Error("Specify a host.");
    if (!forward) throw new SkillLookupError(503, "skill_catalog_unavailable", "No broker connection to the target host.");
    const params = new URLSearchParams();
    if (name !== undefined) params.set("name", name);
    if (all) params.set("all", "true");
    const remote = await forward({ nodeSelector: host, method: "GET", path: "/v1/mesh/skills" + (params.size ? "?" + params : "") });
    if (remote) {
      const catalog = wireCatalog.safeParse(remote.body);
      if (remote.status === 404 && name !== undefined && (remote.body as { error?: string } | null)?.error === "skill_not_found") {
        throw new SkillLookupError(404, "skill_not_found", `No skill named ${name} is registered on ${host}.`);
      }
      if (remote.status !== 200 || !catalog.success || (!all && catalog.data.skills.some(s => s.source === "unregistered"))
        || (name !== undefined && (catalog.data.skills.length !== 1 || catalog.data.skills[0]?.name !== name))) {
        throw new SkillLookupError(503, "skill_catalog_unavailable",
          `Cannot read skills on ${host} (HTTP ${remote.status}). Check the host, its broker version and the mesh control grant.`);
      }
      return catalog.data.skills;
    }
  }
  return name === undefined ? listSkills(home, all) : [await registeredSkill(home, name)];
}

// This is the same native task field as ask --skill, not a second execution path.
export function skillAsk(input: ScoutSkillRunRequest): ScoutDeliverHttpRequest {
  const { name, target } = skillRunInput(input);
  const metadata = {
    replyMode: "notify",
    ...(input.replyToSessionId && { replyToSessionId: input.replyToSessionId }),
    ...(input.replyToSessionHarness && { replyToSessionHarness: input.replyToSessionHarness }),
  };
  return {
    requestId: input.requestId ?? `ask-${randomUUID()}`,
    intent: "task_ask", task: { version: 1, skill: name }, body: input.brief,
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
