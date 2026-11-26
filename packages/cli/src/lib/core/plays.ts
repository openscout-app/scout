import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeScoutLaunchableHarness } from "@openscout/protocol";
import { deriveOpenScoutInstanceLayout } from "@openscout/runtime/config";
import { z } from "zod";

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const inputPattern = /^[a-z][a-z0-9_-]*$/;
const nonempty = z.string().trim().min(1);
const targetFields = z.object({ project: nonempty.optional(), harness: nonempty.optional(), host: nonempty.optional() }).strict();
const header = z.object({
  name: z.string().regex(namePattern),
  description: nonempty,
  delivery: nonempty,
  inputs: z.record(z.string().regex(inputPattern), z.string().nullable()).default({}),
  target: targetFields.default({}),
});
type Play = z.infer<typeof header> & { procedure: string };
export type PlayTarget = Play["target"];

export function playbookDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.OPENSCOUT_SCOUT_HOME?.trim() ||
    deriveOpenScoutInstanceLayout({ env, home: env.HOME || homedir() }).scoutHome;
  return join(home, "plays");
}

function playPath(dir: string, name: string): string {
  if (!namePattern.test(name)) throw new Error("Invalid play name: use lowercase letters, digits and single hyphens.");
  return join(dir, name + ".md");
}

export function parsePlay(name: string, markdown: string): Play {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match || !match[2]!.trim()) throw new Error(`${name}.md needs YAML frontmatter and a procedure.`);
  try {
    const fields = header.parse(Bun.YAML.parse(match[1]!));
    if (fields.name !== name) throw new Error("name must match the filename");
    return { ...fields, procedure: match[2]!.trim() };
  } catch (error) {
    throw new Error(`Invalid ${name}.md: ${error instanceof Error ? error.message : error}`);
  }
}

export async function readPlayFile(dir: string, name: string): Promise<string> {
  const path = playPath(dir, name);
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No play named ${name} at ${path}.`);
    throw error;
  }
}

export async function listPlays(dir: string) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = entries.filter(e => e.isFile() && e.name.endsWith(".md")).map(e => e.name.slice(0, -3)).sort();
  return Promise.all(names.map(async name => {
    const { description, inputs } = parsePlay(name, await readPlayFile(dir, name));
    return { name, description, inputs };
  }));
}

export function renderPlay(play: Play, inputs: Record<string, string>, overrides: PlayTarget, cwd: string) {
  const values = new Map<string, string>();
  for (const key of Object.keys(inputs)) {
    if (!Object.hasOwn(play.inputs, key)) throw new Error(`Unknown input for ${play.name}: ${key}`);
  }
  for (const [key, fallback] of Object.entries(play.inputs)) {
    const value = Object.hasOwn(inputs, key) ? inputs[key] : fallback;
    if (value == null || (fallback === null && !value.trim())) throw new Error(`Missing required input for ${play.name}: ${key}`);
    values.set(key, value);
  }
  const fill = (s: string) => s.replace(/\{\{([a-z][a-z0-9_-]*)\}\}/g, (_, key: string) => {
    if (!values.has(key)) throw new Error(`Undeclared input in ${play.name}: ${key}`);
    return values.get(key)!;
  });
  const target = targetFields.parse({ ...play.target, ...overrides });
  if (target.harness) {
    const harness = normalizeScoutLaunchableHarness(target.harness);
    if (!harness) throw new Error(`Unsupported harness: ${target.harness}. See scout runtimes.`);
    target.harness = harness;
  }
  if (target.host && !target.project) throw new Error(`Specify --project for host ${target.host}.`);
  const project = target.host ? target.project! : resolve(cwd, target.project ?? ".");
  const body = [
    `Run the ${play.name} play. Ask when unsure.`,
    ...(values.size ? ["Inputs:\n" + [...values].map(([k, v]) => `${k}: ${v}`).join("\n")] : []),
    fill(play.procedure),
    "Delivery: " + fill(play.delivery),
  ].join("\n\n");
  return { target: { ...target, project }, body };
}

export async function preparePlay(dir: string, name: string, inputs: Record<string, string>, overrides: PlayTarget, cwd: string) {
  return renderPlay(parsePlay(name, await readPlayFile(dir, name)), inputs, overrides, cwd);
}

// Replace whole literals, not fragments of prose or shell commands. Repeated
// occurrences get the same input. Leave uncertain cases for the operator.
export function draftPlay(name: string, brief?: string): string {
  const names = new Map<string, string>();
  const counts = { path: 0, url: 0 };
  const procedure = brief?.replace(/(?<!\S)([`"'])([^\n]*?)\1(?=[.,;:]?(?:\s|$))|\S+/g, (token, quote?: string, quoted?: string) => {
    const value = quoted ?? token.replace(/[.,;:!?]+$/, "");
    const kind = /^https?:\/\/[^\s<>"'`]+$/.test(value) ? "url"
      : /^(?:(?:\.{0,2}\/|~\/|[\w.-]+\/)[\w ./~-]+|[\w-]+\.(?:md|txt|json|csv|pdf|ya?ml))$/u.test(value) ? "path"
      : null;
    if (!kind) return token;
    let input = names.get(value);
    if (!input) {
      const n = ++counts[kind];
      input = n === 1 ? kind : `${kind}${n}`;
      names.set(value, input);
    }
    return quote ? `${quote}{{${input}}}${quote}` : `{{${input}}}${token.slice(value.length)}`;
  }) ?? "Inspect {{path}}. Describe the steps for the agent here.";
  if (!brief) names.set("", "path");
  const inputs = [...names.values()].map(input => `  ${input}:`);
  const description = brief ? procedure.split("\n")[0]!.trim().slice(0, 160) : `Describe when to run ${name}.`;
  const delivery = procedure.match(/^delivery:[ \t]*(.+)$/im)?.[1]
    ?? (brief ? "Return the result requested in the procedure." : "Describe the result to return to the operator.");
  return [
    "---", `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description || name)}`,
    ...(inputs.length ? ["inputs:", ...inputs] : ["inputs: {}"]),
    `delivery: ${JSON.stringify(delivery)}`, "---", "", procedure, "",
  ].join("\n");
}

export async function writePlay(dir: string, name: string, markdown: string) {
  const path = playPath(dir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writeFile(path, markdown, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Play already exists: ${path}`);
    throw error;
  }
  return path;
}
