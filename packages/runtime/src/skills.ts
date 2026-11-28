import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { isSkillFolderName, normalizeScoutLaunchableHarness, type ScoutSkillRunRequest, type ScoutSkillSummary } from "@openscout/protocol";

const harnessRoots = [".agents", ".claude", ".codex", ".cursor"] as const;
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

async function checkedSkillRoot(parent: string, create = false): Promise<string> {
  const root = join(parent, "skills");
  for (const dir of [parent, root]) {
    if (create) {
      try { await mkdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      if (!(await lstat(dir)).isDirectory()) throw new Error(`Scout needs a plain directory at ${dir}, not a link or file.`);
    } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  return root;
}

// Only individual registrations may be pointers. Refuse to mistake a symlink
// to a harness root for the user-owned Scout directory, even during authoring.
export async function scoutSkillRoot(home: string, create = false): Promise<string> {
  return checkedSkillRoot(join(home, ".openscout"), create);
}

/** Legacy ~/.scout/skills read fallback until `scout home migrate` runs. */
export async function legacyScoutSkillRoot(home: string): Promise<string> {
  return checkedSkillRoot(join(home, ".scout"), false);
}

export async function scoutSkillReadRoots(home: string): Promise<string[]> {
  return [await scoutSkillRoot(home), await legacyScoutSkillRoot(home)];
}

async function summarize(root: string, name: string, registered: boolean): Promise<ScoutSkillSummary | undefined> {
  const entry = join(root, name);
  try {
    const info = await lstat(entry);
    if (!info.isDirectory() && !info.isSymbolicLink()) return;
    const directory = await realpath(entry), path = await realpath(join(directory, "SKILL.md"));
    const description = await readSkillDescription(path);
    if (description) return { name, description, path, directory, source: !registered ? "unregistered" : info.isSymbolicLink() ? "linked" : "personal" };
  } catch (error) { if (!absent(error)) throw error; }
}

export class SkillLookupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function registeredSkill(home: string, name: string): Promise<ScoutSkillSummary> {
  if (!isSkillFolderName(name)) throw new SkillLookupError(400, "invalid_skill_name", "Use a registered skill folder name, not a path.");
  for (const root of await scoutSkillReadRoots(home)) {
    const skill = await summarize(root, name, true);
    if (skill) return skill;
  }
  throw new SkillLookupError(404, "skill_not_found", `No skill named ${name} is registered on this machine. Use scout skills or scout skills add <path>.`);
}

export async function listSkills(home: string, all = false): Promise<ScoutSkillSummary[]> {
  const out: ScoutSkillSummary[] = [], known = new Set<string>(), registeredNames = new Set<string>();
  const registeredRoots = await scoutSkillReadRoots(home);
  const roots = [...registeredRoots, ...(all ? harnessRoots.map(dir => join(home, dir, "skills")) : [])];
  for (const [index, root] of roots.entries()) {
    const isRegistered = index < registeredRoots.length;
    let names: string[];
    try { names = await readdir(root); } catch (error) { if (absent(error)) continue; throw error; }
    for (const name of names.sort()) {
      if (!isSkillFolderName(name)) continue;
      if (isRegistered && registeredNames.has(name)) continue;
      const skill = await summarize(root, name, isRegistered);
      // Two explicitly registered aliases remain usable by their own names;
      // primary ~/.openscout/skills wins over legacy ~/.scout/skills for the same name.
      // Suppress duplicate physical folders only in the read-only inventory.
      if (skill && (isRegistered || !known.has(skill.directory))) {
        out.push(skill);
        known.add(skill.directory);
        if (isRegistered) registeredNames.add(name);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillBrief(skill: ScoutSkillSummary, brief: string): string {
  return `For this ask only, use the Scout skill ${JSON.stringify(skill.name)}. Read ${JSON.stringify(skill.path)} on this machine. Resolve its scripts and assets relative to ${JSON.stringify(skill.directory)}. Do not install it for other sessions. If it is unavailable, ask rather than substituting another skill.\n\nBrief:\n${brief}`;
}

/** Normalize the route without consulting the filesystem; receipt retries can
 * still succeed after the skill is renamed. */
export function skillRunInput(input: ScoutSkillRunRequest) {
  const { name, brief } = input;
  if (!isSkillFolderName(name)) throw new SkillLookupError(400, "invalid_skill_name", "Use a registered skill folder name, not a path.");
  if (!brief?.trim()) throw new Error("A skill needs a brief.");
  const target = input.target ?? {};
  const harness = skillHarness(target.harness);
  if (target.host && !target.project) throw new Error(`Specify --project for host ${target.host}.`);
  if (!target.host && !isAbsolute(target.project ?? "") && !isAbsolute(input.currentDirectory ?? "")) {
    throw new Error("Specify an absolute target project or the caller's absolute currentDirectory.");
  }
  const project = target.host || isAbsolute(target.project ?? "") ? target.project! : resolve(input.currentDirectory!, target.project ?? ".");
  return { name, target: { ...target, harness, project } };
}
