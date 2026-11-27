import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeScoutLaunchableHarness, type ScoutSkillRunRequest, type ScoutSkillSummary } from "@openscout/protocol";

const harnessRoots: Record<string, string> = { claude: ".claude", codex: ".codex", cursor: ".cursor" };
const headerLimit = 64 * 1024;

export function skillHarness(value?: string) {
  if (value === undefined) return undefined;
  const harness = normalizeScoutLaunchableHarness(value);
  if (!harness) throw new Error(`Unknown harness: ${value}. See scout runtimes.`);
  return harness;
}

// Parse only a bounded frontmatter prefix. Neither a listing nor an ask
// imports the skill body or sends its scripts to the caller.
async function readMetadata(file: string): Promise<Pick<ScoutSkillSummary, "name" | "description"> | undefined> {
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
    const name = header.name.trim(), description = header.description.trim();
    if (name && description && !/[\/\r\n]/.test(name)) return { name, description };
  } finally { await handle.close(); }
}

function absent(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export async function listSkills(home: string, harnessName?: string): Promise<ScoutSkillSummary[]> {
  const harness = skillHarness(harnessName);
  const specific = harness && harnessRoots[harness];
  const roots = harness ? (specific ? [".agents", specific] : [".agents"]) : [".agents", ...Object.values(harnessRoots)];
  const files = new Map<string, ScoutSkillSummary>();
  for (const root of roots) {
    const dir = join(home, root, "skills");
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (absent(error)) continue; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const path = join(dir, entry.name, "SKILL.md");
      try {
        const physical = await realpath(path);
        if (files.has(physical)) continue;
        const metadata = await readMetadata(physical);
        if (metadata) files.set(physical, { ...metadata, path: `~/${root}/skills/${entry.name}/SKILL.md` });
      } catch (error) { if (!absent(error)) throw error; }
    }
  }
  return [...files.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export class SkillLookupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly candidates?: string[]) { super(message); }
}

/** Resolve only from the catalog. Never open an arbitrary caller-supplied path. */
export function prepareSkill(skills: ScoutSkillSummary[], input: ScoutSkillRunRequest, home: string) {
  const { name, brief } = input;
  if (!brief?.trim()) throw new Error("A skill needs a brief.");
  const target = input.target ?? {};
  const harness = skillHarness(target.harness);
  const selector = !target.host && name.startsWith(home + "/") ? "~/" + name.slice(home.length + 1) : name;
  const matches = skills.filter(s => s.name === selector || s.path === selector);
  if (matches.length === 0) throw new SkillLookupError(404, "skill_not_found", `No skill named ${name} in the selected roots. List them with scout skills.`);
  if (matches.length > 1) {
    const paths = matches.map(s => s.path);
    throw new SkillLookupError(409, "ambiguous_skill", `More than one skill named ${name}. Use one of these paths:\n${paths.join("\n")}`, paths);
  }
  if (target.host && !target.project) throw new Error(`Specify --project for host ${target.host}.`);
  if (!target.host && !isAbsolute(target.project ?? "") && !isAbsolute(input.currentDirectory ?? "")) {
    throw new Error("Specify an absolute target project or the caller's absolute currentDirectory.");
  }
  const project = target.host || isAbsolute(target.project ?? "") ? target.project! : resolve(input.currentDirectory!, target.project ?? ".");
  const skill = matches[0]!;
  const body = `Use the ${skill.name} skill. Read ${JSON.stringify(skill.path)} on this machine, with its bundled resources. If it is unavailable, ask rather than substituting another skill.\n\nBrief:\n${brief}`;
  return { skill, target: { ...target, harness, project }, body };
}
