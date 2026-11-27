import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
      { name: "review", description: "Review a change.", status: "active", path: "~/.agents/skills/review/SKILL.md" },
    ] });
    input = await req.json();
    return Response.json({ receipt: { requestId: "run-1", flightId: "flt-test", targetAgentId: "reviewer" }, followUrl: "http://runtime.test/work/w" });
  } });
  try {
    const ctx = createScoutCommandContext({ cwd: "/project", env: { OPENSCOUT_BROKER_URL: broker.url.origin }, stdout: t => output.push(t), stderr: () => {} });
    await runSkillsCommand(ctx, ["--harness", "codex", "--on", "worker"]);
    expect(output.pop()).toContain("review  Review a change.  [active] ~/.agents/skills/review/SKILL.md");
    const brief = "Review a.md, not a=b.";
    await runNamedSkillCommand(ctx, ["review", brief, "--harness", "codex", "--on", "worker", "--project", "/code", "--request-id", "run-1"]);
    expect(input).toMatchObject({ name: "review", brief, currentDirectory: "/project", requestId: "run-1",
      target: { harness: "codex", host: "worker", project: "/code" } });
    expect(output.pop()).toContain("Follow the task: http://runtime.test/work/w");
    await expect(runNamedSkillCommand(ctx, ["review"])).rejects.toThrow("brief");
    expect(calls).toEqual(["GET /v1/skills?harness=codex&host=worker", "POST /v1/skills/run"]);
  } finally { await broker.stop(true); }
});

test("new, edit and path operate on one user file; existing files and harness links are never replaced", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills user "));
  const name = "daily-notes", dir = join(home, ".agents", "skills", name), file = join(dir, "SKILL.md");
  const conflict = join(home, ".claude", "skills", name);
  const stdout: string[] = [], stderr: string[] = [];
  try {
    await mkdir(conflict, { recursive: true });
    await writeFile(join(conflict, "SKILL.md"), "---\nname: daily-notes\ndescription: Vendor copy.\n---\nKeep me.");
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await symlink(join(home, ".agents", "skills"), join(home, ".codex", "skills"));
    const editor = join(home, "my editor.ts");
    await writeFile(editor, `if (Bun.argv[2] !== "--wait") process.exit(23);
      const f = Bun.argv[3]; const text = await Bun.file(f).text();
      await Bun.write(f, text.replace("Use this skill for daily notes.", "Summarize today."));`);
    const ctx = createScoutCommandContext({ env: { HOME: home, EDITOR: `"${process.execPath}" "${editor}" --wait` },
      stdout: t => stdout.push(t), stderr: t => stderr.push(t) });
    await expect(runSkillsCommand(ctx, ["new", "../outside"])).rejects.toThrow("folder name");
    await runSkillsCommand(ctx, ["new", name]);
    expect(stdout.pop()).toBe(file);
    expect(stderr.join("\n")).toContain("claude: conflict; left unchanged");
    expect(stderr.join("\n")).toContain("codex: already linked");
    expect(stderr.join("\n")).toContain("cursor: linked");
    expect(await realpath(join(home, ".cursor", "skills", name))).toBe(await realpath(dir));
    await runSkillsCommand(ctx, ["edit", name]);
    await runSkillsCommand(ctx, ["path", name]);
    expect(stdout.pop()).toBe(file);
    const skills = await listSkills(home);
    expect(skills.map(s => [s.description, s.status])).toEqual([["Summarize today.", "active"], ["Vendor copy.", "shadowed"]]);
    await expect(runSkillsCommand(ctx, ["new", name])).rejects.toThrow("Already exists");
    expect(await readFile(file, "utf8")).toContain("Summarize today.");
    ctx.env.EDITOR = "/usr/bin/false";
    await expect(runSkillsCommand(ctx, ["edit", name])).rejects.toThrow("/usr/bin/false exited");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("add links a local folder; fork detaches its files and keeps harnesses on the personal copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "skills-fork-"));
  const source = join(home, "sources", "review"), own = join(home, ".agents", "skills", "review");
  const file = "SKILL.md", text = "---\nname: review\ndescription: Standard copy.\n---\nCheck the file.";
  const ctx = createScoutCommandContext({ cwd: home, env: { HOME: home }, stdout: () => {}, stderr: () => {} });
  try {
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(join(source, file), text);
    await writeFile(join(source, "scripts", "check"), "original");
    await runSkillsCommand(ctx, ["add", "./sources/review"]);
    expect(await realpath(own)).toBe(await realpath(source));
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
    for (const root of [".claude", ".codex", ".cursor"]) {
      expect(await readFile(join(home, root, "skills", "review", "scripts", "check"), "utf8")).toBe("personal");
    }
    await expect(runSkillsCommand(ctx, ["add", source])).rejects.toThrow("Already exists");
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
      if (await child.exited) throw new Error(await child.stderr.text());
    };
    await git("init", "--quiet");
    await git("commit", "-q", "--allow-empty", "-m", "Create the fixture");
    const url = pathToFileURL(source).href, destination = join(home, ".agents", "skills", "one-skill");
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
