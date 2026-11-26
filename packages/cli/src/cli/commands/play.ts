import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { draftPlay, playbookDirectory, preparePlay, readPlayFile, writePlay } from "@openscout/runtime/playbook";
import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { claimedSessionHarness, claimedSessionId } from "../../lib/core/broker/sender.js";
import { resolveHumanAskSenderName, resolveScoutBrokerUrl, resolveScoutSenderId } from "../../lib/core/broker/service.ts";
import { playAskReceipt, playClient } from "../../lib/core/broker/play-client.ts";
import { renderScoutAskReceipt } from "./ask.ts";

const brokerUrl = (ctx: ScoutCommandContext) => ctx.env.OPENSCOUT_BROKER_URL || resolveScoutBrokerUrl();

const playUsage = "scout play show <name> | new <name> | save <name> --from <invocation-or-flight-id>";
const runUsage = "scout run <play> [name=value ...] [--project <path>] [--harness <harness>] [--on <host>] [--request-id <id>] [--dry-run]";
const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

export async function runPlaysCommand(ctx: ScoutCommandContext, args: string[]) {
  if (wantsHelp(args)) return ctx.output.writeText("scout plays  List playbook names, descriptions and inputs.");
  if (args.length) throw new Error("Usage: scout plays");
  const { plays } = await playClient(brokerUrl(ctx)).list();
  ctx.output.writeValue(plays, items => items.map(({ name, description, inputs }) => {
    const fields = inputs.map(field => field.default !== null ? `${field.name}=${field.default}` : field.required ? field.name : `[${field.name}]`);
    return `${name}  ${description}  Inputs: ${fields.join(", ") || "none"}`;
  }).join("\n") || "No plays yet. Create one with scout play new <name>.");
}

export async function runPlayCommand(ctx: ScoutCommandContext, args: string[]) {
  if (wantsHelp(args)) return ctx.output.writeText(playUsage);
  const [action, name, ...rest] = args;
  const dir = playbookDirectory(ctx.env);
  if (!name) throw new Error(playUsage);
  if (action === "show" && !rest.length) {
    const markdown = await readPlayFile(dir, name);
    return ctx.output.writeValue({ name, markdown }, value => value.markdown.trimEnd());
  }
  let brief: string | undefined;
  if (action === "save") {
    const { values } = parseArgs({ args: rest, options: { from: { type: "string" } } });
    const id = values.from;
    if (!id) throw new Error(playUsage);
    const { loadScoutInvocationSnapshot, loadScoutFlight } = await import("../../lib/core/broker/service.ts");
    const url = brokerUrl(ctx);
    const invocation = /^flt[-_]/.test(id) ? (await loadScoutFlight(url, id))?.invocationId : id;
    brief = invocation ? (await loadScoutInvocationSnapshot(url, invocation))?.invocation?.task : undefined;
    if (!brief?.trim()) throw new Error(`No ask brief found for ${id}.`);
  } else if (action !== "new" || rest.length) throw new Error(playUsage);
  const path = await writePlay(dir, name, draftPlay(name, brief));
  ctx.output.writeValue({ path }, value => value.path);
}

export async function runNamedPlayCommand(ctx: ScoutCommandContext, args: string[]) {
  if (wantsHelp(args)) return ctx.output.writeText(runUsage);
  const { positionals: [name, ...pairs], values } = parseArgs({
    args, allowPositionals: true,
    options: { project: { type: "string" }, harness: { type: "string" }, on: { type: "string" },
      "request-id": { type: "string" }, "dry-run": { type: "boolean" } },
  });
  if (!name) throw new Error(runUsage);
  const inputs: Record<string, string> = Object.create(null);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`Expected name=value, got: ${pair}`);
    const key = pair.slice(0, eq);
    if (Object.hasOwn(inputs, key)) throw new Error(`Input provided twice: ${key}`);
    inputs[key] = pair.slice(eq + 1);
  }
  for (const [flag, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`--${flag} needs a value.`);
  }
  const cwd = defaultScoutContextDirectory(ctx);
  const target = {
    ...(values.project && { project: values.project }),
    ...(values.harness && { harness: values.harness }),
    ...(values.on && { host: values.on }),
  };
  if (values["dry-run"]) {
    const run = await preparePlay(playbookDirectory(ctx.env), name, inputs, target, cwd);
    const { project, harness, host } = run.target;
    return ctx.output.writeValue(run, () => [
      "Dry run. No ask sent.", `Project: ${project}`, ...(host ? [`Host: ${host}`] : []),
      ...(harness ? [`Harness: ${harness}`] : []), "", run.body,
    ].join("\n"));
  }
  const requestId = values["request-id"] ?? `ask-${randomUUID()}`;
  const senderId = await resolveScoutSenderId(resolveHumanAskSenderName(null, ctx.env), cwd, ctx.env);
  const replyToSessionId = claimedSessionId(ctx.env);
  ctx.stderr(`request ${requestId} (reuse with --request-id after an uncertain receipt)`);
  const result = await playClient(brokerUrl(ctx)).run({ name, inputs, target, currentDirectory: cwd, senderId, source: "scout-cli",
    replyToSessionId, replyToSessionHarness: claimedSessionHarness(replyToSessionId, ctx.env), requestId });
  ctx.output.writeValue(result, value => renderScoutAskReceipt({ receipt: playAskReceipt(value),
    replyMode: "notify", followUrl: value.followUrl, onHost: values.on }));
}
