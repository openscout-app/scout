import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills } from "@openscout/runtime/skills";
import { createScoutCommandContext } from "../context.ts";
import { runNamedSkillCommand, runSkillsCommand } from "./skills.ts";

test("skills and run use the broker catalog, preserve the brief, and print the native receipt link", async () => {
  const calls: string[] = [], output: string[] = [];
  let input;
  const broker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/skills") return Response.json({ skills: [
      { name: "review", description: "Review a change.", source: "personal", directory: "/remote/.openscout/skills/review", path: "/remote/.openscout/skills/review/SKILL.md" },
    ] });
    input = await req.json();
    return Response.json({ receipt: { requestId: "run-1", flightId: "flt-test", targetAgentId: "reviewer" }, followUrl: "http://runtime.test/work/w" });
  } });
  try {
    const ctx = createScoutCommandContext({ cwd: "/project", env: { OPENSCOUT_BROKER_URL: broker.url.origin }, stdout: t => output.push(t), stderr: () => {} });
    await runSkillsCommand(ctx, ["--all", "--on", "worker"]);
    expect(output.pop()).toContain("review  Review a change.  [personal] /remote/.openscout/skills/review/SKILL.md");
    const brief = "Review a.md, not a=b.";
    await runNamedSkillCommand(ctx, ["review", brief, "--harness", "codex", "--on", "worker", "--project", "/code", "--request-id", "run-1"]);
    expect(input).toMatchObject({ name: "review", brief, currentDirectory: "/project", requestId: "run-1",
      target: { harness: "codex", host: "worker", project: "/code" } });
    expect(output.pop()).toContain("Follow the task: http://runtime.test/work/w");
    await expect(runNamedSkillCommand(ctx, ["review"])).rejects.toThrow("brief");
    expect(calls).toEqual(["GET /v1/skills?all=true&host=worker", "POST /v1/skills/run"]);
  } finally { await broker.stop(true); }
});

test("new, edit and path stay in Scout; no harness directory is created or changed", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills user "));
  const name = "daily-notes", dir = join(home, ".openscout", "skills", name), file = join(dir, "SKILL.md");
  const conflict = join(home, ".claude", "skills", name);
  const stdout: string[] = [], stderr: string[] = [];
  try {
    await mkdir(conflict, { recursive: true });
    await writeFile(join(conflict, "SKILL.md"), "---\nname: daily-notes\ndescription: Vendor copy.\n---\nKeep me.");
    const editor = join(home, "my editor.ts");
    await writeFile(editor, `if (Bun.argv[2] !== "--wait") process.exit(23);
      const f = Bun.argv[3]; const text = await Bun.file(f).text();
      await Bun.write(f, text.replace("Use this skill for daily notes.", "Summarize today."));`);
    const ctx = createScoutCommandContext({ env: { HOME: home, EDITOR: `"${process.execPath}" "${editor}" --wait` },
      stdout: t => stdout.push(t), stderr: t => stderr.push(t) });
    await expect(runSkillsCommand(ctx, ["new", "../outside"])).rejects.toThrow("folder name");
    await runSkillsCommand(ctx, ["new", name]);
    expect(stdout.pop()).toBe(file);
    expect(stderr).toEqual([]);
    for (const root of [".agents", ".codex", ".cursor"]) await expect(readdir(join(home, root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(home, ".claude", "skills"))).toEqual([name]);
    await runSkillsCommand(ctx, ["edit", name]);
    await runSkillsCommand(ctx, ["path", name]);
    expect(stdout.pop()).toBe(await realpath(file));
    const skills = await listSkills(home);
    expect(skills.map(s => [s.description, s.source])).toEqual([["Summarize today.", "personal"]]);
    expect(await readFile(join(conflict, "SKILL.md"), "utf8")).toContain("Keep me.");
    await expect(runSkillsCommand(ctx, ["new", name])).rejects.toThrow("Already exists");
    expect(await readFile(file, "utf8")).toContain("Summarize today.");
    ctx.env.EDITOR = "/usr/bin/false";
    await expect(runSkillsCommand(ctx, ["edit", name])).rejects.toThrow("/usr/bin/false exited");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("add registers an alias without touching the source; fork makes its editable personal copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-fork-"));
  const source = join(home, ".agents", "skills", "native"), own = join(home, ".openscout", "skills", "review");
  const file = "SKILL.md", text = "---\nname: review\ndescription: Standard copy.\n---\nCheck the file.";
  const ctx = createScoutCommandContext({ cwd: home, env: { HOME: home }, stdout: () => {}, stderr: () => {} });
  try {
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, file), text);
    await writeFile(join(source, "scripts", "check"), "original");
    await runSkillsCommand(ctx, ["add", source, "--as", "review"]);
    expect(await realpath(own)).toBe(await realpath(source));
    await expect(runSkillsCommand(ctx, ["edit", "review"])).rejects.toThrow("scout skills fork review");
    // A fork must not silently carry links that write outside the copied folder.
    const external = join(home, "outside");
    await writeFile(external, "unchanged"); await symlink(external, join(source, "other"));
    await expect(runSkillsCommand(ctx, ["fork", "review"])).rejects.toThrow("external resource link");
    expect(await realpath(own)).toBe(await realpath(source));
    await rm(join(source, "other"));
    await runSkillsCommand(ctx, ["fork", "review"]);
    expect(await realpath(own)).not.toBe(await realpath(source));
    await writeFile(join(own, "scripts", "check"), "personal");
    expect(await readFile(join(source, "scripts", "check"), "utf8")).toBe("original");
    expect(await readdir(join(home, ".agents", "skills"))).toEqual(["native"]);
    for (const root of [".claude", ".codex", ".cursor"]) await expect(readdir(join(home, root))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runSkillsCommand(ctx, ["add", source, "--as", "review"])).rejects.toThrow("Already exists");
    expect((await listSkills(home)).map(s => s.name)).toEqual(["review"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("add clones one standard skill from Git without modifying its source or overwriting a folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-git-"));
  const source = join(home, "one-skill"), file = "SKILL.md";
  const env = { HOME: home, PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1" };
  const ctx = createScoutCommandContext({ cwd: home, env, stdout: () => {}, stderr: () => {} });
  try {
    await mkdir(source);
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "-C", source, ...args], { env, stdout: "ignore", stderr: "pipe" });
      if (await child.exited) throw new Error(await new Response(child.stderr).text());
    };
    await git("init", "--quiet");
    await git("commit", "-q", "--allow-empty", "-m", "Create the fixture");
    const url = pathToFileURL(source).href, destination = join(home, ".openscout", "skills", "one-skill");
    await expect(runSkillsCommand(ctx, ["add", url])).rejects.toThrow("Expected a SKILL.md");
    await expect(realpath(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(source, file), "---\nname: one-skill\ndescription: Check a file.\n---\nRead one file.");
    await git("add", file); await git("commit", "-q", "-m", "Add a skill");
    await runSkillsCommand(ctx, ["add", url]);
    expect(await readFile(join(destination, file), "utf8")).toBe(await readFile(join(source, file), "utf8"));
    await expect(runSkillsCommand(ctx, ["add", url])).rejects.toThrow("Already exists");
    await writeFile(join(destination, file), "personal");
    expect(await readFile(join(source, file), "utf8")).toContain("Read one file.");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a linked Scout root cannot redirect creation into a harness", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-root-")), harness = join(home, ".claude", "skills");
  try {
    await mkdir(harness, { recursive: true }); await mkdir(join(home, ".openscout"));
    await symlink(harness, join(home, ".openscout", "skills"));
    const ctx = createScoutCommandContext({ env: { HOME: home } });
    await expect(runSkillsCommand(ctx, ["new", "notes"])).rejects.toThrow("plain directory");
    expect(await readdir(harness)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("setup installs one shared entry point and never registers or exposes individual skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "scout-entry-"));
  const ctx = createScoutCommandContext({ env: { HOME: home }, stdout: () => {} });
  const native = [".claude", ".codex", ".cursor"].map(root => join(home, root, "skills"));
  try {
    await runSkillsCommand(ctx, ["new", "notes"]);
    await runSkillsCommand(ctx, ["setup"]);
    await runSkillsCommand(ctx, ["setup"]); // Safe to repeat.
    const entry = join(home, ".agents", "skills", "scout-skills", "SKILL.md");
    const installed = await readFile(entry, "utf8");
    expect(installed).toMatch(/^---\nname: scout-skills\n/);
    expect(installed).toContain("scout skills --json");
    for (const root of native) {
      expect(await readdir(root)).toEqual(["scout-skills"]);
      expect(await realpath(join(root, "scout-skills", "SKILL.md"))).toBe(await realpath(entry));
    }
    expect((await listSkills(home)).map(s => s.name)).toEqual(["notes"]);
    await rm(join(native[0]!, "scout-skills"));
    await mkdir(join(native[0]!, "scout-skills"));
    await expect(runSkillsCommand(ctx, ["setup"])).rejects.toThrow("not replaced");
    expect(await readdir(join(native[0]!, "scout-skills"))).toEqual([]);
    await rm(native[0]!, { recursive: true });
    await symlink(join(home, ".openscout", "skills"), native[0]!);
    await expect(runSkillsCommand(ctx, ["setup"])).rejects.toThrow("separate");
    expect(await readdir(join(home, ".openscout", "skills"))).toEqual(["notes"]);
    await rm(native[0]!);
    await writeFile(entry, installed + "\nMy instructions.\n");
    await expect(runSkillsCommand(ctx, ["setup"])).rejects.toThrow("Compare it");
    expect(await readFile(entry, "utf8")).toEndWith("My instructions.\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});
