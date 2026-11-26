import { parseArgs } from "node:util";
import { draftPlay, listPlays, playbookDirectory, preparePlay, readPlayFile, writePlay } from "../../lib/core/plays.ts";
import { defaultScoutContextDirectory, type ScoutCommandContext } from "../context.ts";
import { parseAskCommandOptions } from "../options.ts";

const playUsage = "scout play show <name> | new <name> | save <name> --from <invocation-or-flight-id>";
const runUsage = "scout run <play> [name=value ...] [--project <path>] [--harness <harness>] [--on <host>] [--request-id <id>] [--dry-run]";
const wantsHelp = (args: string[]) => args.includes("--help") || args.includes("-h");

export async function runPlaysCommand(ctx: ScoutCommandContext, args: string[]) {
  if (wantsHelp(args)) return ctx.output.writeText("scout plays  List playbook names, descriptions and inputs.");
  if (args.length) throw new Error("Usage: scout plays");
  const plays = await listPlays(playbookDirectory(ctx.env));
  ctx.output.writeValue(plays, items => items.map(({ name, description, inputs }) => {
    const fields = Object.entries(inputs).map(([key, value]) => value === null ? key : `${key}=${value}`);
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
    const { resolveScoutBrokerUrl, loadScoutInvocationSnapshot, loadScoutFlight } = await import("../../lib/core/broker/service.ts");
    const url = resolveScoutBrokerUrl();
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
  const run = await preparePlay(playbookDirectory(ctx.env), name, inputs, {
    ...(values.project && { project: values.project }),
    ...(values.harness && { harness: values.harness }),
    ...(values.on && { host: values.on }),
  }, cwd);
  const { project, harness, host } = run.target;
  const ask = parseAskCommandOptions([
    `--project=${project}`, ...(host ? [`--on=${host}`] : []), ...(harness ? [`--harness=${harness}`] : []),
    ...(values["request-id"] ? [`--request-id=${values["request-id"]}`] : []), "--", run.body,
  ], cwd);
  if (values["dry-run"]) {
    return ctx.output.writeValue(run, () => [
      "Dry run. No ask sent.", `Project: ${project}`, ...(host ? [`Host: ${host}`] : []),
      ...(harness ? [`Harness: ${harness}`] : []), "", run.body,
    ].join("\n"));
  }
  const { runAskWithOptions } = await import("./ask.ts");
  await runAskWithOptions(ctx, ask);
}
