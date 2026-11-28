/**
 * Reading shell commands for the permission rules and signals: a quote-aware
 * split into simple commands, wrappers and assignments unwrapped, and the
 * paths a command reads or writes. This is a reader, not a shell: it errs
 * toward finding more segments, never fewer.
 */
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

/** A simple command inside a compound one. */
export type ShellSegment = {
  /** The command's words with leading assignments and wrappers (`env`, `sudo`, `nohup`…) removed. */
  words: string[];
  /** The words as written, with only leading assignments removed. */
  raw: string[];
  text: string;
  /** The words of the command piped into this one, if any. */
  pipedFrom: string[] | null;
  /** Files output is redirected into. */
  redirects: string[];
};

/**
 * Split a shell command into simple commands: `;`, `&&`, `||`, `&`,
 * newlines and pipes, plus the bodies of `$(…)`, backticks, `<(…)`,
 * `bash -c '…'` and `eval '…'`. Quotes are honoured, so
 * `git commit -m "x; rm -rf y"` is one command.
 */
export function shellSegments(command: string, depth = 0): ShellSegment[] {
  if (depth > 3) return [];
  const out: Array<Omit<ShellSegment, "raw">> = [];
  const nested: string[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let text = "";
  let quote: "'" | '"' | null = null;
  let previous: Omit<ShellSegment, "raw"> | null = null;
  let piped = false;
  let redirects: string[] = [];
  let redirectNext = false;
  const endWord = () => {
    if (!started) return;
    if (redirectNext) { redirects.push(word); redirectNext = false; } else words.push(word);
    word = "";
    started = false;
  };
  const endSegment = (pipe: boolean) => {
    endWord();
    if (words.length) {
      const segment = { words, text: text.trim(), pipedFrom: piped && previous ? previous.words : null, redirects };
      out.push(segment);
      previous = segment;
    } else if (!pipe) previous = null;
    piped = pipe;
    words = [];
    text = "";
    redirects = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "$" && next === "(") {
        const body = balanced(command, index + 1);
        nested.push(body.inner);
        word += command.slice(index, body.end + 1);
        text += command.slice(index, body.end + 1);
        index = body.end;
        continue;
      } else if (quote === '"' && char === "`") {
        const end = command.indexOf("`", index + 1);
        const close = end < 0 ? command.length : end;
        nested.push(command.slice(index + 1, close));
        word += command.slice(index, close + 1);
        text += command.slice(index, close + 1);
        index = close;
        continue;
      } else if (quote === '"' && char === "\\" && next !== undefined) { word += next; text += char + next; index++; continue; }
      else word += char;
      text += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; text += char; continue; }
    if (char === "\\" && next !== undefined) {
      if (next === "\n") { index++; continue; }
      word += next; started = true; text += char + next; index++; continue;
    }
    if ((char === "$" || char === "<" || char === ">") && next === "(") {
      const body = balanced(command, index + 1);
      nested.push(body.inner);
      word += command.slice(index, body.end + 1);
      started = true;
      text += command.slice(index, body.end + 1);
      index = body.end;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      const close = end < 0 ? command.length : end;
      nested.push(command.slice(index + 1, close));
      index = close;
      continue;
    }
    if (char === "(" || char === ")" || char === "{" && /\s/.test(next ?? " ") || char === "}" && !started) { endSegment(false); continue; }
    if (char === ";" || char === "\n") { endSegment(false); continue; }
    if (char === "&" && next === "&") { endSegment(false); index++; continue; }
    if (char === "|" && next === "|") { endSegment(false); index++; continue; }
    if (char === "|") { endSegment(true); if (next === "&") index++; continue; }
    if (char === "&" && next !== ">") { endSegment(false); continue; }
    if (char === ">" || char === "&" || (char === "<" && next !== "<")) {
      if (char === ">" && /^\d$/.test(word)) { word = ""; started = false; }
      endWord();
      if (char === "&") index++;
      if (char === ">" || char === "&") {
        if (command[index + 1] === ">") index++;
        if (command[index + 1] === "&") { index++; while (/[\d-]/.test(command[index + 1] ?? "")) index++; continue; }
        redirectNext = true;
      }
      text += char;
      continue;
    }
    if (/\s/.test(char)) { endWord(); text += char; continue; }
    word += char;
    started = true;
    text += char;
  }
  endSegment(false);
  const expanded: ShellSegment[] = [];
  for (const segment of out) {
    const unwrapped = unwrap(segment.words);
    expanded.push({ ...segment, raw: unwrapped.raw, words: unwrapped.words });
    const [head, ...rest] = unwrapped.words;
    if (head && /^(?:ba|z|da|k|fi|c|tc)?sh$/.test(head)) {
      const at = rest.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
      if (at >= 0 && rest[at + 1] !== undefined) expanded.push(...shellSegments(rest[at + 1]!, depth + 1));
    }
    if (head === "eval" && rest.length) expanded.push(...shellSegments(rest.join(" "), depth + 1));
  }
  for (const body of nested) expanded.push(...shellSegments(body, depth + 1));
  return expanded;
}

function balanced(text: string, open: number): { inner: string; end: number } {
  let level = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") level++;
    else if (text[index] === ")" && --level === 0) return { inner: text.slice(open + 1, index), end: index };
  }
  return { inner: text.slice(open + 1), end: text.length - 1 };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Commands that run the rest of their words as a command. */
const WRAPPERS = /^(?:sudo|doas|env|nohup|time|exec|command|builtin|nice|ionice|timeout|gtimeout|stdbuf|caffeinate|xargs|chronic|unbuffer)$/;
/** Wrapper options that take a value as the next word. */
const WRAPPER_VALUE_FLAGS = /^(?:-u|-g|-C|-p|-h|-r|-t|-n|-s|-k|-o|-e|-i|-I|-L|-P|-d|-a|--user|--group|--signal|--kill-after|--adjustment)$/;

/** Leading assignments and wrappers removed, and each command word reduced to its basename. */
function unwrap(input: string[]): { raw: string[]; words: string[] } {
  let start = 0;
  while (start < input.length - 1 && ASSIGNMENT.test(input[start]!)) start++;
  const raw = input.slice(start);
  if (raw[0]) raw[0] = commandName(raw[0]);
  let words = raw.slice();
  while (words.length > 1 && WRAPPERS.test(words[0]!)) {
    const wrapper = words[0]!;
    words = words.slice(1);
    while (words.length > 1) {
      const word = words[0]!;
      if (word === "--") { words = words.slice(1); break; }
      if (ASSIGNMENT.test(word)) { words = words.slice(1); continue; }
      if (word.startsWith("-")) {
        words = words.slice(WRAPPER_VALUE_FLAGS.test(word) && wrapper !== "env" && wrapper !== "time" ? 2 : 1);
        continue;
      }
      // `timeout 10 cmd`, `nice 5 cmd`
      if ((wrapper === "timeout" || wrapper === "gtimeout" || wrapper === "nice") && /^\d+(?:\.\d+)?[smhd]?$/.test(word)) { words = words.slice(1); continue; }
      break;
    }
    if (words[0]) words[0] = commandName(words[0]);
  }
  return { raw, words };
}

/** `/bin/rm` and `\rm` are `rm`. */
function commandName(word: string): string {
  const bare = word.replace(/^\\/, "");
  return bare.includes("/") && !bare.endsWith("/") && /^(?:\/|\.\.?\/|~\/)?(?:[\w.-]+\/)*(?:bin|sbin|libexec)\/[\w.+-]+$/.test(bare) ? basename(bare) : bare;
}

/* ── canonical forms for rule matching ─────────────────────────────────── */

const RECURSIVE = /^-[a-zA-Z]*[rR][a-zA-Z]*$/;
const FORCE = /^-[a-zA-Z]*f[a-zA-Z]*$/;
/** git's options that come before the subcommand, with whether each takes the next word. */
const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/**
 * The texts a segment is matched as: the command as written, and one with
 * flags and global options in a fixed spelling. `rm -r -f x`, `rm -Rf x` and
 * `rm --recursive --force x` all read `rm -rf x`; `git -C . reset --hard`
 * reads `git reset --hard`; `git push -f` reads `git push --force`.
 */
export function canonicalCommands(segment: ShellSegment): string[] {
  const forms = new Set<string>([segment.raw.join(" "), segment.words.join(" ")]);
  const [head, ...args] = segment.words;
  if (head === "rm") {
    const recursive = args.some((arg) => RECURSIVE.test(arg) || arg === "--recursive");
    const force = args.some((arg) => FORCE.test(arg) || arg === "--force");
    const operands = args.filter((arg) => !arg.startsWith("-") || arg === "-");
    const flags = recursive && force ? ["-rf"] : [recursive ? "-r" : "", force ? "-f" : ""].filter(Boolean);
    forms.add(["rm", ...flags, ...operands].join(" "));
  }
  if (head === "git") {
    let at = 0;
    while (at < args.length && args[at]!.startsWith("-")) {
      const option = args[at]!;
      at += GIT_GLOBAL_VALUE.has(option) ? 2 : 1;
    }
    const rest = args.slice(at);
    forms.add(["git", ...rest].join(" "));
    if (rest[0] === "push") {
      const pushArgs = rest.slice(1);
      const forced = pushArgs.some((arg) => arg === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) || arg.startsWith("--force") || (arg.startsWith("+") && arg.length > 1));
      if (forced) forms.add(["git", "push", "--force", ...pushArgs.filter((arg) => !(arg === "-f" || arg.startsWith("--force")))].join(" "));
    }
  }
  return [...forms];
}

/** Commands whose file operands are read. */
const READERS = /^(?:cat|less|more|head|tail|bat|batcat|xxd|od|hexdump|strings|nl|tac|base64|source|\.|grep|egrep|fgrep|rg|ag|awk|sed|cut|sort|uniq|wc|diff|cmp|cp|scp|rsync|tar|zip|gzip|openssl|jq|yq|vim|vi|nano|view|code|open)$/;

/** Files a segment reads as operands: `cat .env`, `grep KEY .env.local`, `cp ~/.ssh/id_rsa x`. */
export function readFiles(segment: ShellSegment): string[] {
  const [head, ...args] = segment.words;
  if (!head || !READERS.test(head)) return [];
  return args.filter((arg) => !arg.startsWith("-") && !arg.includes("://") && arg.length > 0).map((arg) => arg.replace(/^[^=/]+=/, ""));
}

/** Files a segment writes: redirects, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln` destinations, `git config` writes. */
export function writtenFiles(segment: ShellSegment, cwd: string): string[] {
  const [head, ...args] = segment.words;
  const files = [...segment.redirects];
  const plain = args.filter((arg) => !arg.startsWith("-"));
  if (head === "tee") files.push(...plain);
  if ((head === "sed" || head === "perl") && args.some((arg) => /^-[a-zA-Z]*i/.test(arg)) && plain.length) files.push(plain[plain.length - 1]!);
  if (head && /^(?:cp|mv|install|ln|rsync|touch|chmod|chown|truncate|dd)$/.test(head) && plain.length) {
    files.push(head === "touch" || head === "truncate" ? plain[0]! : head === "dd" ? (plain.find((arg) => arg.startsWith("of=")) ?? "").slice(3) : plain[plain.length - 1]!);
  }
  if (head === "git") {
    let at = 0;
    let dir = cwd;
    while (at < args.length && args[at]!.startsWith("-")) {
      if (args[at] === "-C" && args[at + 1]) dir = absolutePath(args[at + 1]!, dir);
      at += GIT_GLOBAL_VALUE.has(args[at]!) ? 2 : 1;
    }
    const sub = args.slice(at);
    if (sub[0] === "config" && !sub.some((arg) => /^--(?:get|get-all|get-regexp|list|show-origin|show-scope|global|system)$|^-l$/.test(arg))
      && sub.filter((arg) => !arg.startsWith("-")).length >= 3) files.push(resolve(dir, ".git/config"));
    if (sub[0] === "config" && sub.includes("--global") && !sub.some((arg) => /^--(?:get|get-all|get-regexp|list)$|^-l$/.test(arg))
      && sub.filter((arg) => !arg.startsWith("-")).length >= 3) files.push(`${homedir()}/.gitconfig`);
  }
  return files.filter(Boolean).map((file) => absolutePath(file, cwd));
}

/* ── paths ─────────────────────────────────────────────────────────────── */

export function absolutePath(path: string, cwd: string): string {
  const home = homedir();
  const value = path.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, "~");
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/**
 * Agent and tool configuration: a write here changes what an agent may do
 * next, so it never passes unseen. Scout's own policy file is the strictest.
 */
export function agentConfigTarget(path: string, cwd: string, policyPath?: string): string | null {
  const absolute = absolutePath(path, cwd);
  if (scoutPolicyTarget(absolute, policyPath)) return "Scout's permission rules";
  const parts = absolute.split(sep);
  const name = parts[parts.length - 1] ?? "";
  const home = homedir();
  // Antigravity keeps its plans and walkthroughs under ~/.gemini/antigravity/brain: notes, not config.
  if (absolute.startsWith(`${home}/.gemini/antigravity/brain/`)) return null;
  for (const dir of [".claude", ".codex", ".cursor", ".gemini", ".agents", ".vscode", ".windsurf", ".continue"]) {
    if (parts.includes(dir)) return dir === ".vscode" ? ".vscode settings" : `${dir}/`;
  }
  if (name === ".mcp.json" || name === "mcp.json") return name;
  const git = parts.lastIndexOf(".git");
  if (git >= 0 && (parts[git + 1] === "hooks" || (parts[git + 1] === "config" && git + 2 === parts.length))) return `.git/${parts[git + 1]}`;
  if (/^(?:\.?venv|env|virtualenv)$/.test(parts[parts.length - 3] ?? "") && parts[parts.length - 2] === "bin") return "a virtualenv interpreter";
  if (/^\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|kshrc|tcshrc|cshrc|inputrc)$/.test(name)) return `~/${name}`;
  if (absolute.startsWith(`${home}/.config/fish/`)) return "fish config";
  if (absolute.startsWith(`${home}/.config/git/`) || absolute === `${home}/.gitconfig`) return "git config";
  return null;
}

/** Scout's permission policy file, wherever it is. */
export function scoutPolicyTarget(absolute: string, policyPath?: string): boolean {
  if (policyPath && absolute === resolve(policyPath)) return true;
  return basename(absolute) === "continuation-policy.json";
}

/** A secret by path: `.env`, `~/.ssh`, `~/.aws`, cloud and package credentials, private keys. */
export function secretTarget(path: string, cwd: string): string | null {
  const absolute = absolutePath(path, cwd);
  const home = homedir();
  const name = basename(absolute);
  if (name === ".env" || (/^\.env\./.test(name) && !/\.(?:example|sample|template|dist|defaults?)$/.test(name))) return name;
  for (const [prefix, label] of [
    [`${home}/.ssh`, "~/.ssh"], [`${home}/.aws`, "~/.aws"], [`${home}/.config/gcloud`, "~/.config/gcloud"],
    [`${home}/.azure`, "~/.azure"], [`${home}/.kube`, "~/.kube"], [`${home}/.docker/config.json`, "~/.docker"],
    [`${home}/.netrc`, "~/.netrc"], [`${home}/.npmrc`, "~/.npmrc"], [`${home}/.pypirc`, "~/.pypirc"],
    [`${home}/.config/gh/hosts.yml`, "gh credentials"], [`${home}/Library/Keychains`, "the keychain"],
    [`${home}/.gnupg`, "~/.gnupg"], [`${home}/.openscout/keys`, "Scout's keys"],
  ] as const) {
    if (absolute === prefix || absolute.startsWith(`${prefix}/`)) return label;
  }
  if (/\.(?:pem|key|p12|pfx)$/.test(name) && !name.endsWith(".pub")) return name;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(name) || name === "credentials" || name === ".npmrc") return name;
  return null;
}

/**
 * A folder `defaultMode: "auto"` may take as a project when no grant covers it:
 * somewhere under the home folder, and not inside a dot folder (`~/.ssh`,
 * `~/.config`…) or `~/Library`. `/etc`, `/usr`, `~/Library/LaunchAgents` and
 * the home folder itself are never one.
 */
export function autoProjectRoot(path: string, cwd = "/"): boolean {
  const absolute = absolutePath(path, cwd);
  const home = resolve(homedir());
  if (!absolute.startsWith(`${home}${sep}`)) return false;
  const parts = absolute.slice(home.length + 1).split(sep).filter(Boolean);
  return parts.length > 0 && parts[0] !== "Library" && !parts.some((part) => part.startsWith("."));
}

/** `/`, the home folder, and the folders above it: never a project root, never a target a lift covers. */
export function broadRoot(path: string, cwd = "/"): boolean {
  const absolute = absolutePath(path, cwd);
  const home = resolve(homedir());
  return absolute === resolve(sep) || absolute === home || home.startsWith(`${absolute}${sep}`);
}
