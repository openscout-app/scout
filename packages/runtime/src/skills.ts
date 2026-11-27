import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { isSkillFolderName, normalizeScoutLaunchableHarness, type ScoutSkillRunRequest, type ScoutSkillSummary } from "@openscout/protocol";

export const harnessRoots: Record<string, string> = { claude: ".claude", codex: ".codex", cursor: ".cursor" };
const headerLimit = 64 * 1024;

export function skillHarness(value?: string) {
  if (value === undefined) return undefined;
  const harness = normalizeScoutLaunchableHarness(value);
  if (!harness) throw new Error(`Unknown harness: ${value}. See scout runtimes.`);
  return harness;
}

// Parse only a bounded frontmatter prefix. Neither a listing nor an ask
// imports the skill body or sends its scripts to the caller.
export async function readSkillDescription(file: string): Promise<string | undefined> {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) return;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, headerLimit));
    const { bytesRead } = await handle.read(buffer);
    const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(buffer.toString("utf8", 0, bytesRead));
    if (!match) return;
    let header: unknown;
    try { header = parseYaml(match[1]!, { logLevel: "silent" }); } catch { return; }
    if (!header || typeof header !== "object" || !("name" in header) || !("description" in header)
      || typeof header.name !== "string" || typeof header.description !== "string") return;
    // Frontmatter remains portable; the enclosing folder is the stable reference.
    if (header.name.trim()) return header.description.trim().replace(/\s+/g, " ") || undefined;
  } finally { await handle.close(); }
}

function absent(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export async function listSkills(home: string, harnessName?: string): Promise<ScoutSkillSummary[]> {
  const harness = skillHarness(harnessName);
  const specific = harness && harnessRoots[harness];
  const roots = harness ? (specific ? [".agents", specific] : [".agents"]) : [".agents", ...Object.values(harnessRoots)];
  const folders = new Map<string, Omit<ScoutSkillSummary, "status">>();
  for (const root of roots) {
    const dir = join(home, root, "skills");
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (absent(error)) continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!isSkillFolderName(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      try {
        const physical = await realpath(join(dir, entry.name));
        if (folders.has(physical)) continue;
        const description = await readSkillDescription(join(physical, "SKILL.md"));
        if (description) folders.set(physical, { name: entry.name, description, path: `~/${root}/skills/${entry.name}/SKILL.md` });
      } catch (error) { if (!absent(error)) throw error; }
    }
  }
  const groups = new Map<string, Omit<ScoutSkillSummary, "status">[]>();
  for (const s of folders.values()) {
    const group = groups.get(s.name);
    if (group) group.push(s); else groups.set(s.name, [s]);
  }
  return [...groups.values()].flatMap(copies => {
    const personal = copies.find(s => s.path.startsWith("~/.agents/skills/"));
    return copies.map((s): ScoutSkillSummary => ({ ...s, status: personal
      ? (s === personal ? "active" : "shadowed") : copies.length === 1 ? "active" : "ambiguous" }));
  }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export class SkillLookupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly candidates?: string[]) { super(message); }
}

/** Resolve only from the catalog. Never open an arbitrary caller-supplied path. */
export function selectSkill(skills: ScoutSkillSummary[], selector: string): ScoutSkillSummary {
  const exact = skills.find(s => s.path === selector);
  if (exact) return exact;
  const copies = skills.filter(s => s.name === selector);
  if (!copies.length) throw new SkillLookupError(404, "skill_not_found", `No skill named ${selector} in the selected roots. List them with scout skills.`);
  const active = copies.filter(s => s.status === "active");
  if (active.length === 1) return active[0]!;
  const paths = copies.map(s => s.path);
  throw new SkillLookupError(409, "ambiguous_skill", `More than one skill named ${selector}. Use one of these paths:\n${paths.join("\n")}`, paths);
}

export function skillBrief(skill: ScoutSkillSummary, brief: string): string {
  return `Use the ${skill.name} skill. Read ${JSON.stringify(skill.path)} on this machine, with its bundled resources. If it is unavailable, ask rather than substituting another skill.\n\nBrief:\n${brief}`;
}

/** Normalize the route and selector without consulting a catalog. Receipt retries
 * must not depend on a file that may have been renamed after acceptance. */
export function skillRunInput(input: ScoutSkillRunRequest, home: string) {
  const { name, brief } = input;
  if (!brief?.trim()) throw new Error("A skill needs a brief.");
  const target = input.target ?? {};
  const harness = skillHarness(target.harness);
  const selector = !target.host && name.startsWith(home + "/") ? "~/" + name.slice(home.length + 1) : name;
  if (target.host && !target.project) throw new Error(`Specify --project for host ${target.host}.`);
  if (!target.host && !isAbsolute(target.project ?? "") && !isAbsolute(input.currentDirectory ?? "")) {
    throw new Error("Specify an absolute target project or the caller's absolute currentDirectory.");
  }
  const project = target.host || isAbsolute(target.project ?? "") ? target.project! : resolve(input.currentDirectory!, target.project ?? ".");
  return { selector, target: { ...target, harness, project } };
}

export function prepareSkill(skills: ScoutSkillSummary[], input: ScoutSkillRunRequest, home: string) {
  const { selector, target } = skillRunInput(input, home);
  const skill = selectSkill(skills, selector);
  return { skill, target, body: skillBrief(skill, input.brief) };
}
