import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, registeredSkill, skillBrief } from "./skills.js";

test("only named Scout registrations can run; optional discovery is read-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-skills-"));
  async function put(root: string, name: string) {
    const dir = join(home, root, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\r\nname: portable-name\r\ndescription: >\r\n  Inspect the\r\n  selected file.\r\n---\r\nPRIVATE-BODY\n");
    return dir;
  }
  try {
    const shared = await put(".agents", "review");
    expect(await listSkills(home)).toEqual([]);
    const own = await put(".openscout", "review"), root = join(home, ".openscout", "skills");
    await symlink(shared, join(root, "alias"));
    await symlink(shared, join(root, "other-alias"));
    await symlink(join(home, "absent"), join(root, "dangling"));
    const legacy = await put(".scout", "legacy-only");
    const shadowed = await put(".scout", "review");
    const native = await put(".claude", "native-only");
    await mkdir(join(home, ".cursor", "skills"), { recursive: true });
    await symlink(native, join(home, ".cursor", "skills", "native-only"));
    expect((await listSkills(home)).map(s => [s.name, s.source])).toEqual([
      ["alias", "linked"],
      ["legacy-only", "personal"],
      ["other-alias", "linked"],
      ["review", "personal"],
    ]);
    expect((await listSkills(home, true)).filter(s => s.source === "unregistered").map(s => s.name)).toEqual(["native-only"]);
    await expect(registeredSkill(home, "native-only")).rejects.toThrow("No skill named native-only");
    await expect(registeredSkill(home, "../review")).rejects.toThrow("not a path");
    expect((await registeredSkill(home, "review")).directory).toBe(await realpath(own));
    expect((await registeredSkill(home, "review")).directory).not.toBe(await realpath(shadowed));
    expect((await registeredSkill(home, "legacy-only")).directory).toBe(await realpath(legacy));
    const skill = await registeredSkill(home, "alias");
    expect(skill).toEqual({ name: "alias", description: "Inspect the selected file.", source: "linked",
      directory: await realpath(shared), path: await realpath(join(shared, "SKILL.md")) });
    const brief = 'Review "notes.md" as written: {{text}}', ask = skillBrief(skill, brief);
    expect(ask).toContain(JSON.stringify(skill.path)); expect(ask).toContain(JSON.stringify(skill.directory));
    expect(ask).toEndWith(brief); expect(ask).not.toContain("PRIVATE-BODY"); expect(ask).not.toContain("native-only");
  } finally { await rm(home, { recursive: true, force: true }); }
});
