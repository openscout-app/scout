import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSkillFolderName } from "@openscout/protocol";
import { harnessRoots, listSkills, readSkillDescription, selectSkill } from "@openscout/runtime/skills";

function checkName(name: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Use a folder name of up to 64 lowercase letters, numbers and single hyphens.");
  }
}

const personalRoot = (home: string) => join(home, ".agents", "skills");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
async function existing(path: string) {
  try { return await lstat(path); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}
async function reserve(dir: string) {
  try { await mkdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Already exists: ${dir}. No files changed.`);
    throw error;
  }
}

export async function newSkill(home: string, name: string) {
  checkName(name);
  const root = personalRoot(home), dir = join(root, name), path = join(dir, "SKILL.md");
  await mkdir(root, { recursive: true });
  await reserve(dir);
  const title = name.replaceAll("-", " ");
  await writeFile(path, `---\nname: "${name}"\ndescription: "Use this skill for ${title}."\n---\n\n## Steps\n\n1. Read the brief.\n2. Describe the work to do here.\n3. Report the result.\n`, { flag: "wx" });

  return linkHarnesses(home, name);
}

async function linkHarnesses(home: string, name: string) {
  const dir = join(personalRoot(home), name);
  const path = join(dir, "SKILL.md");
  // Point at the user's folder, not through it: a later fork can replace a
  // linked skill with a personal copy without invalidating the harness links.
  const canonical = join(await realpath(dirname(dir)), name);
  const links = [];
  for (const [harness, folder] of Object.entries(harnessRoots)) {
    const dest = join(home, folder, "skills", name);
    let status: string;
    try {
      await mkdir(dirname(dest), { recursive: true });
      // A harness root may itself be a link. Make the target relative to its real parent.
      const parent = await realpath(dirname(dest)), source = await realpath(dir);
      try { await symlink(relative(parent, canonical), dest, "dir"); status = "linked"; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        status = await realpath(dest).catch(() => null) === source ? "already linked" : "conflict; left unchanged";
      }
    } catch (error) { status = `not linked: ${(error as NodeJS.ErrnoException).code ?? "unavailable"}`; }
    links.push({ harness, path: dest, status });
  }
  return { path, links };
}

async function chooseLocalSkill(home: string, selector: string) {
  const name = selector.startsWith(home + "/") ? "~/" + selector.slice(home.length + 1) : selector;
  return selectSkill(await listSkills(home), name);
}

export async function localSkillPath(home: string, name: string) {
  return join(home, (await chooseLocalSkill(home, name)).path.slice(2));
}

// $EDITOR can include arguments such as --wait or a quoted executable path.
// Split words without invoking a shell or expanding the skill path.
function editorWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && quote !== "'") {
      if (++i === command.length) throw new Error("Trailing escape in $EDITOR.");
      word += command[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = ""; else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = ""; started = false;
    } else { word += c; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in $EDITOR.");
  if (started) words.push(word);
  return words;
}

export async function editSkill(path: string, command: string, env: NodeJS.ProcessEnv) {
  const [program, ...args] = editorWords(command);
  if (!program) throw new Error("Set $EDITOR to an editor command.");
  await runProgram(program, [...args, path], env);
}

async function runProgram(program: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} exited with ${signal ?? code}.`)));
  });
}

async function requireSkill(dir: string) {
  const file = join(dir, "SKILL.md");
  if (!await readSkillDescription(file).catch(error => { if (errorCode(error) !== "ENOENT") throw error; })) {
    throw new Error(`Expected a SKILL.md with a name and description at ${file}.`);
  }
}

// Publish only a complete folder. An exclusive reservation protects an existing
// directory (even an empty one); rename refuses a concurrent nonempty one.
async function installDirectory(staged: string, dest: string) {
  await reserve(dest);
  try { await rename(staged, dest); }
  catch (error) { await rmdir(dest).catch(() => {}); throw error; }
}

function gitSource(input: string) {
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(input);
  if (scp) return { protocol: "ssh", name: basename(scp[1]!).replace(/\.git$/, "") };
  if (!/^[\w+-]+:\/\//.test(input)) return;
  const url = new URL(input), protocol = url.protocol.slice(0, -1);
  if (!["https", "ssh", "file"].includes(protocol) || url.password || (protocol === "https" && url.username)) {
    throw new Error("Use an HTTPS or SSH Git URL without embedded credentials, or a local folder.");
  }
  return { protocol, name: basename(decodeURIComponent(url.pathname)).replace(/\.git$/, "") };
}

export async function addSkill(home: string, input: string, cwd: string, env: NodeJS.ProcessEnv) {
  const git = gitSource(input);
  const local = resolve(cwd, input.startsWith("~/") ? join(home, input.slice(2)) : input);
  const name = git?.name ?? basename(local);
  if (!isSkillFolderName(name)) throw new Error("Use a source with a visible skill folder name.");
  const root = personalRoot(home), dest = join(root, name);
  await mkdir(root, { recursive: true });
  if (git) {
    if (await existing(dest)) throw new Error(`Already exists: ${dest}. No files changed.`);
    const tmp = await mkdtemp(join(root, ".install-"));
    try {
      const staged = join(tmp, name);
      // No submodules, checkout hooks or shell. Clone one root skill.
      await runProgram("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth=1", "--no-recurse-submodules", "--", input, staged],
        { ...env, GIT_ALLOW_PROTOCOL: git.protocol });
      await requireSkill(staged);
      await installDirectory(staged, dest);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  } else {
    const source = await realpath(local);
    await requireSkill(source);
    try { await symlink(relative(await realpath(root), source), dest, "dir"); }
    catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await realpath(dest).catch(() => null) !== source) throw new Error(`Already exists: ${dest}. No files changed.`);
    }
  }
  return linkHarnesses(home, name);
}

export async function forkSkill(home: string, selector: string) {
  const skill = await chooseLocalSkill(home, selector);
  const source = await realpath(dirname(join(home, skill.path.slice(2))));
  const root = personalRoot(home), dest = join(root, skill.name);
  const old = await existing(dest);
  if (old && await realpath(dest).catch(() => null) !== source) throw new Error(`Already exists: ${dest}. No files changed.`);
  if (old?.isDirectory()) return linkHarnesses(home, skill.name); // Already a personal folder.
  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(join(root, ".fork-")), staged = join(tmp, "copy"), backup = join(tmp, "original");
  let keepBackup = false;
  try {
    await cp(source, staged, { recursive: true, verbatimSymlinks: true, filter: async file => {
      if (basename(file) === ".git") return false;
      // Leave relative links inside the folder intact. Refuse links that would
      // let editing the copy change the original or an unrelated external file.
      if ((await lstat(file)).isSymbolicLink()) {
        const to = await readlink(file), resolved = await realpath(file);
        let depth = relative(source, dirname(file)).split(sep).filter(Boolean).length;
        const escapes = to.split(sep).some(part => {
          if (part === "..") return --depth < 0;
          if (part && part !== ".") depth++;
          return false;
        });
        if (escapes || isAbsolute(to) || (resolved !== source && !resolved.startsWith(source + sep))) {
          throw new Error(`Cannot fork an external resource link: ${file}`);
        }
      }
      return true;
    } });
    await requireSkill(staged);
    if (old) {
      await rename(dest, backup);
      keepBackup = true;
      const moved = await lstat(backup);
      if (moved.dev !== old.dev || moved.ino !== old.ino) throw new Error("The source changed during the copy.");
    }
    await installDirectory(staged, dest);
    keepBackup = false;
  } catch (error) {
    if (keepBackup) {
      // Restore the old link without replacing a new file made by the user.
      if ((await lstat(backup)).isSymbolicLink()) {
        try { await symlink(await readlink(backup), dest, "dir"); keepBackup = false; } catch { /* Report retained original below. */ }
      }
      if (keepBackup) throw new Error(`Could not restore ${dest}; the original is preserved at ${backup}.`, { cause: error });
    }
    throw error;
  } finally { if (!keepBackup) await rm(tmp, { recursive: true, force: true }); }
  return linkHarnesses(home, skill.name);
}
