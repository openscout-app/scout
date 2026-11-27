import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { listSkills, prepareSkill } from "@openscout/runtime/skills";
import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { claimedSessionHarness, claimedSessionId } from "../../lib/core/broker/sender.js";
import { resolveHumanAskSenderName, resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";
import { skillAskReceipt, skillClient } from "../../lib/core/broker/skill-client.ts";
import { renderScoutAskReceipt } from "./ask.ts";

const broker = (ctx: ScoutCommandContext) => skillClient(ctx.env.OPENSCOUT_BROKER_URL || resolveScoutBrokerUrl());
const listUsage = "scout skills [--harness <harness>] [--on <host>]";
const runUsage = 'scout run <skill> "brief" [--project <path>] [--harness <harness>] [--on <host>] [--request-id <id>] [--dry-run]';
const targetOptions = { harness: { type: "string" }, on: { type: "string" } } as const;

export async function runSkillsCommand(ctx: ScoutCommandContext, args: string[]) {
  const { values } = parseArgs({ args, options: { ...targetOptions, help: { type: "boolean", short: "h" } } });
  if (values.help) return ctx.output.writeText(listUsage);
  const { skills } = await broker(ctx).list(values.harness, values.on);
  ctx.output.writeValue(skills, items => items.map(s => `${s.name}  ${s.description.replace(/\s+/g, " ")}  ${s.path}`).join("\n")
    || "No skills found for the selected harness.");
}

export async function runNamedSkillCommand(ctx: ScoutCommandContext, args: string[]) {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, options: { ...targetOptions, project: { type: "string" }, "request-id": { type: "string" },
      "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return ctx.output.writeText(runUsage);
  const [name, brief] = positionals;
  if (positionals.length !== 2 || !name?.trim() || !brief?.trim()) throw new Error(runUsage);
  for (const [flag, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`--${flag} needs a value.`);
  }
  const cwd = defaultScoutContextDirectory(ctx);
  const target = { project: values.project, harness: values.harness, host: values.on };
  const input = { name, brief, target, currentDirectory: cwd };
  if (values["dry-run"]) {
    const home = ctx.env.HOME || homedir();
    const skills = target.host ? (await broker(ctx).list(target.harness, target.host)).skills : await listSkills(home, target.harness);
    const run = prepareSkill(skills, input, home);
    return ctx.output.writeValue(run, () => [
      "Dry run. No ask sent.", `Project: ${run.target.project}`, ...(target.host ? [`Host: ${target.host}`] : []),
      ...(run.target.harness ? [`Harness: ${run.target.harness}`] : []), "", run.body,
    ].join("\n"));
  }
  const requestId = values["request-id"] ?? `ask-${randomUUID()}`;
  const senderId = await resolveScoutSenderId(resolveHumanAskSenderName(null, ctx.env), cwd, ctx.env);
  const replyToSessionId = claimedSessionId(ctx.env);
  ctx.stderr(`request ${requestId} (reuse with --request-id after an uncertain receipt)`);
  const result = await broker(ctx).run({ ...input, senderId, source: "scout-cli",
    replyToSessionId, replyToSessionHarness: claimedSessionHarness(replyToSessionId, ctx.env), requestId });
  ctx.output.writeValue(result, value => renderScoutAskReceipt({ receipt: skillAskReceipt(value),
    replyMode: "notify", followUrl: value.followUrl, onHost: target.host }));
}
