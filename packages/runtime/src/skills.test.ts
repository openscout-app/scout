import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, prepareSkill } from "./skills.js";

test("discover existing SKILL.md files by harness; collapse links, not distinct same-name skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-skills-"));
  async function put(root: string, folder: string, name = folder) {
    const dir = join(home, root, "skills", folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\r\nname: ${name}\r\ndescription: >\r\n  Inspect the\r\n  selected file.\r\n---\r\nPRIVATE-BODY\n`);
    return dir;
  }
  try {
    const shared = await put(".agents", "review");
    await put(".claude", "review-local", "review");
    await put(".codex", "audit");
    const cursor = await put(".cursor", "capture");
    await symlink(shared, join(cursor, "..", "review"), "dir");
    await symlink(join(home, "absent"), join(cursor, "..", "dangling"), "dir");
    await writeFile(join(await put(".agents", "invalid"), "SKILL.md"), "No frontmatter.");
    const all = await listSkills(home);
    expect(all.map(s => s.name)).toEqual(["audit", "capture", "review", "review"]);
    const request = { name: "review", brief: 'Review "notes.md" as written: {{text}}', currentDirectory: "/project" };
    const paths = all.filter(s => s.name === "review").map(s => s.path);
    expect(paths).toEqual(["~/.agents/skills/review/SKILL.md", "~/.claude/skills/review-local/SKILL.md"]);
    expect(() => prepareSkill(all, request, home)).toThrow(paths.join("\n"));
    const run = prepareSkill(all, { ...request, name: paths[1]! }, home);
    expect(run.body).toContain(paths[1]!);
    expect(run.body).toEndWith(request.brief);
    expect(run.body).not.toContain("PRIVATE-BODY");
    expect(await listSkills(home, "codex")).toEqual(all.filter(s => s.name === "audit" || s.path === paths[0]));
    expect((await listSkills(home, "cursor")).map(s => s.name)).toEqual(["capture", "review"]);
    expect(() => prepareSkill(all, { ...request, name: "/some/other/SKILL.md" }, home)).toThrow("No skill named");
    expect(() => prepareSkill(all, { ...request, brief: " " }, home)).toThrow("brief");
    await expect(listSkills(home, "typo")).rejects.toThrow("Unknown harness");
  } finally { await rm(home, { recursive: true, force: true }); }
});
