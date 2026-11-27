import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { registeredSkill, skillBrief, skillRunInput } from "@openscout/runtime/skills";
import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { claimedSessionHarness, claimedSessionId } from "../../lib/core/broker/sender.js";
import { resolveHumanAskSenderName, resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";
import { skillAskReceipt, skillClient } from "../../lib/core/broker/skill-client.ts";
import { renderScoutAskReceipt } from "./ask.ts";
import { addSkill, editSkill, forkSkill, localSkillPath, newSkill } from "../skills-files.ts";

const broker = (ctx: ScoutCommandContext) => skillClient(ctx.env.OPENSCOUT_BROKER_URL || resolveScoutBrokerUrl());
const listUsage = "scout skills [--all] [--on <host>]\nscout skills new|edit|path|fork <name>\nscout skills add <path|git-url> [--as <name>]";
const runUsage = 'scout run <skill> "brief" [--project <path>] [--harness <harness>] [--on <host>] [--request-id <id>] [--dry-run]';
const targetOptions = { harness: { type: "string" }, on: { type: "string" } } as const;

export async function runSkillsCommand(ctx: ScoutCommandContext, args: string[]) {
  if (args[0] && ["new", "edit", "path", "fork", "add"].includes(args[0])) {
    const action = args[0];
    const usage = `scout skills ${action} ${action === "add" ? "<path|git-url> [--as <name>]" : "<name>"}`;
    const { positionals, values } = parseArgs({ args: args.slice(1), allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, ...(action === "add" ? { as: { type: "string" as const } } : {}) } });
    if (values.help) return ctx.output.writeText(usage);
    const [name] = positionals;
    if (positionals.length !== 1 || !name?.trim()) throw new Error(`Usage: ${usage}`);
    const home = ctx.env.HOME || homedir();
    const path = action === "new" ? await newSkill(home, name)
      : action === "fork" ? await forkSkill(home, name)
      : action === "add" ? await addSkill(home, name, ctx.cwd, ctx.env, typeof values.as === "string" ? values.as : undefined)
      : await localSkillPath(home, name, action === "edit");
    if (action === "edit") await editSkill(path, ctx.env.EDITOR || ctx.env.VISUAL || (ctx.isTty ? "vi" : ""), ctx.env);
    return ctx.output.writeValue({ path }, s => s.path);
  }
  const { values } = parseArgs({ args, options: { all: { type: "boolean" }, on: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) return ctx.output.writeText(listUsage);
  const { skills } = await broker(ctx).list({ all: values.all, host: values.on });
  ctx.output.writeValue(skills, items => items.map(s => `${s.name}  ${s.description}  [${s.source}] ${s.path}`).join("\n")
    || "No Scout skills registered. Use scout skills new <name> or scout skills add <path>.");
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
    const route = skillRunInput(input);
    const skill = target.host ? (await broker(ctx).list({ name, host: target.host })).skills[0] : await registeredSkill(home, name);
    if (!skill || skill.name !== name || skill.source === "unregistered") throw new Error(`No registered skill named ${name}.`);
    const run = { skill, target: route.target, body: skillBrief(skill, brief) };
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
