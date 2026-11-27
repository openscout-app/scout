import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const id = "scout-skills";
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

// Install only the catalog entry point. Never register it as a procedure or
// replace a different native skill when setup is repeated.
export async function installSkillEntry(home: string) {
  const source = await readFile(new URL(import.meta.resolve("#scout-skills-entry")), "utf8");
  const roots = [".agents", ".claude", ".codex", ".cursor"].map(h => join(home, h, "skills"));
  const catalog = join(home, ".scout", "skills");
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    const actual = await realpath(root);
    const privateRoot = await realpath(catalog).catch(error => { if (code(error) !== "ENOENT") throw error; });
    if (actual === privateRoot || (privateRoot && actual.startsWith(privateRoot + sep))) {
      throw new Error(`Keep the harness folder ${root} separate from the Scout catalog.`);
    }
    resolvedRoots.push(actual);
  }
  const dir = join(roots[0]!, id), path = join(dir, "SKILL.md"), canonical = join(resolvedRoots[0]!, id);
  if (await mkdir(dir, { recursive: true })) {
    await writeFile(path, source, { flag: "wx" });
  } else if (!(await lstat(dir)).isDirectory() || !(await lstat(path).catch(() => null))?.isFile()
    || await readFile(path, "utf8") !== source) {
    throw new Error(`Another entry exists at ${dir}. Compare it before installing; it was not replaced.`);
  }

  const links = roots.slice(1).map(root => join(root, id));
  for (const [index, link] of links.entries()) {
    try { await symlink(relative(resolvedRoots[index + 1]!, canonical), link, "dir"); }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      if (await realpath(link).catch(() => null) !== canonical) {
        throw new Error(`Another entry exists at ${link}. It was not replaced. Resolve the conflict and rerun scout skills setup.`);
      }
    }
  }
  return { path, links };
}
