/**
 * Escalation signals: deterministic detectors that put a call the watcher
 * would otherwise approve on the operator's phone.
 *
 * A signal never denies. It turns an automatic `continue` into an ask, and
 * it names itself on an ask that was coming anyway, so the record shows how
 * often each one fires and how often the operator says yes. Only the rules
 * refuse anything.
 *
 * The eight come from the research on agent injection and escalation
 * defenses: each matches a documented incident and fits in one plain line on
 * a phone. Session state (fetched files, secret reads, untrusted inputs,
 * hosts, pushes, denials) lives in memory and is seeded from the audit log.
 */
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { absolutePath, agentConfigTarget, secretTarget, shellSegments, writtenFiles, type ShellSegment } from "./shell.js";

export { agentConfigTarget, secretTarget, shellSegments, type ShellSegment };

export const PERMISSION_SIGNALS = [
  "download-execute",
  "agent-config",
  "secret-egress",
  "trifecta",
  "encoded-egress",
  "push-scope",
  "denial-burst",
  "hijack-text",
] as const;
export type PermissionSignalName = (typeof PERMISSION_SIGNALS)[number];

/** Per signal: off, or off inside the listed project roots. */
export type PermissionSignalSetting = boolean | { except?: string[] };
export type PermissionSignalSettings = Partial<Record<PermissionSignalName, PermissionSignalSetting>>;

/** One tool call, as the signals read it. */
export type SignalCall = {
  /** Claude Code's tool name: Bash, Read, Edit, Write, WebFetch, mcp__server__tool. */
  tool: string;
  command?: string | null;
  path?: string | null;
  url?: string | null;
  /** The project the call belongs to. */
  project: string;
  /** Where relative paths resolve. */
  cwd: string;
};

export type PermissionSignalHit = {
  signal: PermissionSignalName;
  /** One plain line for the phone. */
  line: string;
  /** Where the untrusted input came from, when the signal depends on one. */
  source?: string;
  /** download-execute only: the download is part of this same command, not an earlier call. */
  inCall?: boolean;
};

type Stamp = { at: number; what: string };

type SessionState = {
  project: string;
  fetched: Map<string, string>;
  secrets: Stamp[];
  untrusted: Stamp[];
  hosts: Set<string>;
  pushes: Set<string>;
  denials: Array<{ at: number; call: number; target: string; form: string }>;
  calls: number;
  suspicion: Stamp[];
};

/** Hosts any project may use without being "new". */
const COMMON_HOSTS = [
  "localhost", "127.0.0.1", "::1", "0.0.0.0",
  "github.com", "api.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "codeload.github.com",
  "registry.npmjs.org", "npmjs.com", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io",
  "bun.sh", "deno.land", "jsr.io", "nodejs.org",
];

const SESSION_LIMIT = 500;
const SESSION_TTL_MS = 24 * 3_600_000;

/* ── shell reading: one parser for the rules and the signals (./shell.ts) ── */

const SHELLS = /^(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|node|perl|ruby|bun|deno|php)$/;
const FETCHERS = /^(?:curl|wget|aria2c|http|https|xh|fetch)$/;

/* ── paths and hosts ───────────────────────────────────────────────────── */

const URL_IN_TEXT = /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>|;)]+/gi;

/** Every host a URL in the text names. */
export function hostsInText(text: string): string[] {
  const hosts: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    try { hosts.push(new URL(match[0]).hostname.toLowerCase().replace(/^\[|\]$/g, "")); } catch { /* not a URL */ }
  }
  return hosts;
}

/** Hosts an outbound command reaches: URLs, `ssh`/`scp`/`rsync`/`nc` targets, `dig`/`nslookup` names. */
function outboundHosts(segment: ShellSegment): string[] {
  const [head, ...args] = segment.words;
  if (!head) return [];
  const hosts = hostsInText(segment.text);
  const plain = args.filter((arg) => !arg.startsWith("-"));
  if (/^(?:ssh|mosh)$/.test(head) && plain[0]) hosts.push(hostOf(plain[0]));
  if (/^(?:scp|rsync|sftp)$/.test(head)) for (const arg of plain) if (/^[^/]*:/.test(arg) && !/^[a-z]+:\/\//i.test(arg)) hosts.push(hostOf(arg.split(":")[0]!));
  if (/^(?:nc|ncat|netcat|telnet|socat)$/.test(head) && plain[0]) hosts.push(plain[0].toLowerCase());
  if (/^(?:dig|nslookup|host|ping|drill)$/.test(head)) for (const arg of plain) if (arg.includes(".")) hosts.push(arg.toLowerCase().replace(/^@/, ""));
  if (FETCHERS.test(head)) for (const arg of plain) if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/i.test(arg)) hosts.push(arg.split(/[/:]/)[0]!.toLowerCase());
  return [...new Set(hosts.filter(Boolean))];
}

function hostOf(target: string): string {
  return (target.includes("@") ? target.slice(target.lastIndexOf("@") + 1) : target).toLowerCase();
}

/* ── call classification ───────────────────────────────────────────────── */

function bashOf(call: SignalCall): ShellSegment[] {
  return call.tool === "Bash" && typeof call.command === "string" ? shellSegments(call.command) : [];
}

/** Files a call fetches from the network: `curl -o f`, `curl -O url`, `wget url`, `curl url > f`. */
function fetchedFiles(segment: ShellSegment, cwd: string): string[] {
  const [head, ...args] = segment.words;
  if (!head || !FETCHERS.test(head)) return [];
  const files: string[] = [...segment.redirects];
  const urls = args.filter((arg) => /^[a-z]+:\/\//i.test(arg));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (head === "wget") {
      if (arg === "-O" || arg === "--output-document") { if (args[index + 1] && args[index + 1] !== "-") files.push(args[index + 1]!); index++; }
      else if (arg.startsWith("-O") && arg.length > 2) files.push(arg.slice(2));
    } else if (arg === "-o" || arg === "--output") { if (args[index + 1] && args[index + 1] !== "-") files.push(args[index + 1]!); index++; }
    else if (/^-[a-zA-Z]*O[a-zA-Z]*$/.test(arg) || arg === "--remote-name") files.push(...urls.map(urlFile));
  }
  if (head === "wget" && !args.some((arg) => arg === "-O" || arg.startsWith("-O") || arg === "--output-document" || arg === "-qO-")) files.push(...urls.map(urlFile));
  return files.filter(Boolean).map((file) => absolutePath(file, cwd));
}

function urlFile(url: string): string {
  try { return basename(new URL(url).pathname) || "index.html"; } catch { return ""; }
}

/** Files a command runs, sources or makes executable. */
function executedFiles(segment: ShellSegment, cwd: string): string[] {
  const [head, ...args] = segment.words;
  if (!head) return [];
  const plain = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
  if (head === "chmod" && args.some((arg) => /^(?:[ugoa]*\+[rw]*x|\d*[1357]\d*)$/.test(arg))) return plain.filter((arg) => !/^[ugoa]*[-+=]|^\d+$/.test(arg)).map((file) => absolutePath(file, cwd));
  if (head === "source" || head === ".") return plain.slice(0, 1).map((file) => absolutePath(file, cwd));
  if (SHELLS.test(basename(head)) && plain[0] && !args.includes("-c") && !args.includes("-e")) return [absolutePath(plain[0], cwd)];
  if (head.includes("/")) return [absolutePath(head, cwd)];
  return [];
}

/** Files a command writes: redirects, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln` destinations, `git config` writes. */
/** Secrets a call reads, by any tool. */
function secretReads(call: SignalCall): string[] {
  const found = new Set<string>();
  if ((call.tool === "Read" || call.tool === "Grep" || call.tool === "Glob") && call.path) {
    const secret = secretTarget(call.path, call.cwd);
    if (secret) found.add(secret);
  }
  if (call.url && /^https?:\/\/(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)\b/.test(call.url)) found.add("the cloud metadata endpoint");
  for (const segment of bashOf(call)) {
    const [head, ...args] = segment.words;
    if (head === "security" && /^find-(?:generic|internet)-password$|^dump-keychain$|^export$/.test(args[0] ?? "")) found.add("the keychain");
    if (head === "secret" || (head === "op" && args[0] === "read")) found.add("the keychain");
    if (/169\.254\.169\.254|metadata\.google\.internal/.test(segment.text)) found.add("the cloud metadata endpoint");
    for (const arg of args) {
      if (arg.startsWith("-") || arg.includes("://")) continue;
      const secret = secretTarget(arg.replace(/^[^=]+=/, ""), call.cwd);
      if (secret) found.add(secret);
    }
  }
  return [...found];
}

const SINK_COMMANDS: Array<[RegExp, string]> = [
  [/^git push\b/, "pushes"],
  [/^(?:npm|pnpm|yarn|bun) publish\b/, "publishes a package"],
  [/^cargo publish\b|^gem push\b|^twine upload\b|^poetry publish\b|^uv publish\b/, "publishes a package"],
  [/^gh (?:release create|pr create|pr comment|issue create|issue comment|gist create|api\b.*(?:-X|--method) ?(?:POST|PUT|PATCH|DELETE))/, "posts to GitHub"],
  [/^(?:vercel|netlify|fly|flyctl|wrangler|firebase|railway|heroku)\b.*\b(?:deploy|publish|--prod)\b|^vercel(?: --prod)?$/, "deploys"],
  [/^(?:kubectl (?:apply|create|delete|rollout)|terraform apply|pulumi up|helm (?:install|upgrade))\b/, "deploys"],
  [/^docker push\b/, "pushes an image"],
  [/^(?:scp|rsync|sftp)\b.*\s[^\s/]+:/, "copies files to another machine"],
  [/^(?:mail|sendmail|mutt)\b/, "sends mail"],
];

/** What a call does that carries data out: push, publish, deploy, send. */
function sinkOf(call: SignalCall): string | null {
  if (call.tool.startsWith("mcp__") && /(?:^|_)(?:send|post|publish|reply|create_(?:issue|pull_request|comment|message)|upload|share)/i.test(call.tool.split("__").pop() ?? "")) {
    return "sends through an MCP tool";
  }
  for (const segment of bashOf(call)) {
    const text = segment.words.join(" ");
    for (const [pattern, label] of SINK_COMMANDS) if (pattern.test(text)) return label;
    const [head, ...args] = segment.words;
    if (head && FETCHERS.test(head) && args.some((arg) => /^(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|--json)$/.test(arg) || /^-X(?:POST|PUT|PATCH)$/.test(arg))) return "sends data";
    if (head && FETCHERS.test(head) && args.some((arg, index) => arg === "-X" && /^(?:POST|PUT|PATCH)$/i.test(args[index + 1] ?? ""))) return "sends data";
  }
  return null;
}

/** Hosts a call reaches. */
function callHosts(call: SignalCall): string[] {
  const hosts = new Set<string>();
  if (call.url) for (const host of hostsInText(call.url)) hosts.add(host);
  for (const segment of bashOf(call)) for (const host of outboundHosts(segment)) hosts.add(host);
  return [...hosts];
}

/** Content that comes from outside the operator's control. */
function untrustedInputs(call: SignalCall, known: (host: string) => boolean): string[] {
  const sources: string[] = [];
  if (call.tool === "WebFetch" && call.url) sources.push(`a fetched page (${hostsInText(call.url)[0] ?? call.url})`);
  for (const segment of bashOf(call)) {
    const [head, ...args] = segment.words;
    if (head && FETCHERS.test(head) && !sinkOf({ ...call, command: segment.words.join(" ") })) {
      for (const host of outboundHosts(segment)) if (!known(host)) sources.push(`a download from ${host}`);
    }
    if (head === "git" && args[0] === "clone") sources.push(`a newly cloned repo (${args.filter((arg) => !arg.startsWith("-"))[1] ?? "unknown"})`);
    if (head === "gh" && args[0] === "repo" && args[1] === "clone") sources.push(`a newly cloned repo (${args[2] ?? "unknown"})`);
  }
  return sources;
}

/* ── encoded data ──────────────────────────────────────────────────────── */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, "an API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
];

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

/** A long base64, hex or percent-encoded run, or an encoded-looking DNS label. */
export function encodedBlob(text: string): string | null {
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{48,}={0,2}/g)) {
    const run = match[0];
    if (/^[0-9a-f]+$/i.test(run)) { if (run.length >= 72) return "a long hex string"; continue; }
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && entropy(run) >= 4.5) return "a long encoded string";
  }
  if (/(?:%[0-9A-Fa-f]{2}){16,}/.test(text)) return "a long URL-encoded string";
  const bareHosts = [...text.matchAll(/(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w.-])/gi)].map((match) => match[0]);
  for (const host of [...hostsInText(text), ...bareHosts]) {
    if (host.split(".").some((label) => label.length >= 32 && /^[a-z0-9]+$/i.test(label) && entropy(label) >= 3.8)) return "an encoded DNS name";
  }
  return null;
}

/* ── the tracker ───────────────────────────────────────────────────────── */

export type SignalSeedLine = {
  at: number;
  sessionId?: string;
  projectRoot?: string;
  tool?: string;
  command: string | null;
  decision?: string;
  answer?: string;
};

export type PermissionSignalsOptions = {
  now?: () => number;
  /** Scout's own policy file: a write to it is an agent-config signal. */
  policyPath?: string;
};

const HIJACK_TEXT: Array<[RegExp, string]> = [
  [/\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i, "ignore previous instructions"],
  [/\byou are now\b/i, "you are now"],
  [/\b(?:do not|don't|never) (?:tell|inform|alert|mention (?:this )?to) the user\b/i, "do not tell the user"],
  [/\bnew (?:system )?instructions?:/i, "new instructions"],
  [/<\/?(?:human_chat_interruption|system|im_start|im_end)>|\[\/?INST\]/i, "a fake turn marker"],
  [/[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u, "invisible Unicode"],
];

/** Hijack text in tool output: the phrase it found, or null. */
export function hijackText(output: string): string | null {
  for (const [pattern, label] of HIJACK_TEXT) if (pattern.test(output)) return label;
  return null;
}

export class PermissionSignals {
  private readonly sessions = new Map<string, SessionState>();
  private readonly projectHosts = new Map<string, Set<string>>();
  private readonly projectPushes = new Map<string, Set<string>>();
  private readonly projectPublished = new Set<string>();
  private readonly now: () => number;
  private readonly policyPath: string | undefined;

  constructor(options: PermissionSignalsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.policyPath = options.policyPath;
  }

  /**
   * Seed from the record: hosts each project has used, the remotes and
   * branches it has pushed, and the recent sessions' fetched files, secret
   * reads, untrusted inputs and denials, so a restart keeps its memory.
   */
  seed(lines: Iterable<SignalSeedLine>): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const line of [...lines].sort((a, b) => a.at - b.at)) {
      if (!line.projectRoot || !line.command) continue;
      const call = seedCall(line);
      if (!call) continue;
      if (line.sessionId && line.at >= cutoff) this.observe(line.sessionId, call, seedOutcome(line), line.at);
      else this.learnProject(call, seedOutcome(line));
    }
  }

  private session(id: string, project: string): SessionState {
    let state = this.sessions.get(id);
    if (!state) {
      if (this.sessions.size >= SESSION_LIMIT) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      state = { project, fetched: new Map(), secrets: [], untrusted: [], hosts: new Set(), pushes: new Set(), denials: [], calls: 0, suspicion: [] };
      this.sessions.set(id, state);
    }
    return state;
  }

  private knownHost(project: string, host: string, session?: SessionState, before?: number): boolean {
    if (COMMON_HOSTS.includes(host) || host.endsWith(".localhost") || /^(?:10|127|192\.168)\./.test(host)) return true;
    const known = this.projectHosts.get(project);
    if (known && [...known].some((entry) => entry === host || host.endsWith(`.${entry}`))) return true;
    return Boolean(session && before === undefined && session.hosts.has(host));
  }

  private learnProject(call: SignalCall, outcome: "approved" | "asked" | "denied"): void {
    if (outcome !== "approved") return;
    const hosts = this.projectHosts.get(call.project) ?? new Set<string>();
    for (const host of callHosts(call)) hosts.add(host);
    this.projectHosts.set(call.project, hosts);
    for (const push of pushTargets(call)) {
      const pushes = this.projectPushes.get(call.project) ?? new Set<string>();
      pushes.add(push.remote);
      this.projectPushes.set(call.project, pushes);
    }
    if (sinkOf(call) === "publishes a package") this.projectPublished.add(call.project);
  }

  /** Record what a call did, after the decision. A denied call fetched and read nothing. */
  observe(sessionId: string, call: SignalCall, outcome: "approved" | "asked" | "denied", at = this.now()): void {
    const state = this.session(sessionId, call.project);
    state.calls++;
    const known = (host: string) => this.knownHost(call.project, host);
    if (outcome === "denied") {
      const targets = intentTargets(call);
      for (const target of targets.length ? targets : [formOf(call)]) state.denials.push({ at, call: state.calls, target, form: formOf(call) });
      state.denials = state.denials.slice(-50);
      return;
    }
    for (const segment of bashOf(call)) for (const file of fetchedFiles(segment, call.cwd)) state.fetched.set(file, outboundHosts(segment)[0] ?? "the network");
    for (const secret of secretReads(call)) state.secrets.push({ at, what: secret });
    for (const source of untrustedInputs(call, known)) state.untrusted.push({ at, what: source });
    state.secrets = state.secrets.slice(-20);
    state.untrusted = state.untrusted.slice(-20);
    // An ask has not gone out yet: its hosts and pushes count once the operator approves it.
    if (outcome === "asked") return;
    for (const host of callHosts(call)) state.hosts.add(host);
    for (const push of pushTargets(call)) state.pushes.add(`${push.remote} ${push.branch ?? ""}`.trim());
    this.learnProject(call, outcome);
  }

  /** Tool output, where a post-tool hook exposes it. Hijack text only raises suspicion. */
  observeOutput(sessionId: string, project: string, output: string, source = "tool output"): string | null {
    const found = hijackText(output);
    if (!found) return null;
    const state = this.session(sessionId, project);
    state.suspicion.push({ at: this.now(), what: `${found} in ${source}` });
    state.untrusted.push({ at: this.now(), what: `${source} with “${found}”` });
    return found;
  }

  /**
   * The first signal that fires for this call, before it is decided. Reads
   * the session's history; changes nothing.
   */
  assess(sessionId: string | undefined, call: SignalCall, settings: PermissionSignalSettings = {}): PermissionSignalHit | null {
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    const on = (name: PermissionSignalName) => signalEnabled(settings, name, call.project);
    const segments = bashOf(call);
    const known = (host: string) => this.knownHost(call.project, host, state);
    const untrustedLine = () => state?.untrusted.at(-1)?.what;

    if (on("download-execute")) {
      for (const segment of segments) {
        const fetcher = segment.pipedFrom && FETCHERS.test(segment.pipedFrom[0] ?? "") ? segment.pipedFrom : null;
        if (fetcher && SHELLS.test(basename(segment.words[0] ?? ""))) {
          const host = hostsInText(fetcher.join(" "))[0];
          return { signal: "download-execute", line: `Pipes a download${host ? ` from ${host}` : ""} straight into ${basename(segment.words[0]!)}`, inCall: true };
        }
        const [head, flag] = segment.words;
        if (head && SHELLS.test(basename(head)) && (flag === "-c" || segment.words.includes("-c")) && /\$\(\s*(?:curl|wget)\b|`\s*(?:curl|wget)\b/.test(segment.text)) {
          return { signal: "download-execute", line: `Runs a download through ${basename(head)} -c`, inCall: true };
        }
        if (head === "eval" && /\$\(\s*(?:curl|wget)\b/.test(segment.text)) return { signal: "download-execute", line: "Evaluates a download", inCall: true };
        if (head && /^(?:source|\.|(?:ba|z)?sh)$/.test(head) && /<\(\s*(?:curl|wget)\b/.test(segment.text)) return { signal: "download-execute", line: `Runs a download through ${head}`, inCall: true };
      }
      // A file fetched earlier in the session, or earlier in this command.
      const fetched = new Map(state?.fetched ?? []);
      const fetchedHere = new Set<string>();
      for (const segment of segments) {
        for (const file of fetchedFiles(segment, call.cwd)) { fetched.set(file, outboundHosts(segment)[0] ?? "the network"); fetchedHere.add(file); }
        for (const file of executedFiles(segment, call.cwd)) {
          const from = fetched.get(file);
          if (from) {
            const verb = segment.words[0] === "chmod" ? "Makes executable" : segment.words[0] === "source" || segment.words[0] === "." ? "Sources" : "Runs";
            const inCall = fetchedHere.has(file);
            return { signal: "download-execute", line: `${verb} ${basename(file)}, downloaded from ${from} ${inCall ? "in this command" : "in this session"}`, source: `a download from ${from}`, inCall };
          }
        }
      }
    }

    if (on("agent-config")) {
      const targets = [
        ...((call.tool === "Edit" || call.tool === "Write" || call.tool === "MultiEdit" || call.tool === "NotebookEdit") && call.path ? [call.path] : []),
        ...segments.flatMap((segment) => writtenFiles(segment, call.cwd)),
      ];
      for (const target of targets) {
        const config = agentConfigTarget(target, call.cwd, this.policyPath);
        if (config) return { signal: "agent-config", line: `Changes ${config} (${shortPath(target, call.cwd)})` };
      }
    }

    const hosts = callHosts(call);
    const newHosts = hosts.filter((host) => !known(host));
    const sink = sinkOf(call);

    if (on("encoded-egress") && newHosts.length) {
      const text = call.url ?? call.command ?? "";
      const blob = encodedBlob(text);
      if (blob) return { signal: "encoded-egress", line: `Sends ${blob} to ${newHosts[0]}, a host this project hasn't used` };
    }

    if (on("secret-egress") && state?.secrets.length && newHosts.length) {
      const secret = state.secrets.at(-1)!.what;
      return { signal: "secret-egress", line: `Reads ${secret}, then sends to ${newHosts[0]}, a host this project hasn't used` };
    }

    if (on("trifecta") && sink && state?.untrusted.length && state.secrets.length) {
      const source = untrustedLine()!;
      return {
        signal: "trifecta",
        line: `${capital(sink)} after reading ${state.secrets.at(-1)!.what} and taking in ${source}`,
        source,
      };
    }

    if (on("push-scope")) {
      for (const push of pushTargets(call)) {
        const projectRemotes = this.projectPushes.get(call.project);
        const outside = push.repo && !within(push.repo, call.project);
        if (outside) return { signal: "push-scope", line: `Pushes from ${shortPath(push.repo!, call.cwd)}, outside this session's repo` };
        if (push.remote.includes("://") || push.remote.includes("@")) {
          const host = hostsInText(push.remote)[0] ?? hostOf(push.remote.split(":")[0]!);
          if (!known(host)) return { signal: "push-scope", line: `Pushes to ${push.remote}, a remote this project hasn't used` };
        } else if (push.remote !== "origin" && !projectRemotes?.has(push.remote) && !state?.pushes.has(push.remote)) {
          return { signal: "push-scope", line: `Pushes to remote ${push.remote}, which this project hasn't pushed to` };
        }
        if (push.mirror) return { signal: "push-scope", line: `Pushes every branch (${push.mirror})` };
        if (push.branch && /^(?:main|master|trunk|prod(?:uction)?|deploy(?:\/.*)?|gh-pages|live|stable)$/.test(push.branch)) {
          const before = state ? [...state.pushes].some((entry) => entry.endsWith(` ${push.branch}`)) : false;
          if (!before) return { signal: "push-scope", line: `Pushes straight to ${push.branch} on ${push.remote}` };
        }
      }
      if (sink === "publishes a package" && !this.projectPublished.has(call.project)) {
        return { signal: "push-scope", line: "Publishes a package from a project that hasn't published before" };
      }
    }

    if (on("denial-burst") && state) {
      const recent = state.denials.filter((denial) => denial.at >= this.now() - 10 * 60_000);
      const targets = intentTargets(call);
      const form = formOf(call);
      const retried = targets.find((target) => recent.some((denial) => denial.target === target && denial.form !== form));
      if (retried) return { signal: "denial-burst", line: `Retries ${shortPath(retried, call.cwd)} in a new form after it was denied` };
      // One denied call naming many files is one denial.
      const denied = new Set(recent.map((denial) => denial.call)).size;
      if (denied >= 3) return { signal: "denial-burst", line: `Follows ${denied} denials in the last 10 minutes` };
    }
    return null;
  }

  /** Raised suspicion for the session (hijack text seen): it never escalates alone. */
  suspicion(sessionId: string): string[] {
    return (this.sessions.get(sessionId)?.suspicion ?? []).map((stamp) => stamp.what);
  }
}

/** True unless the policy turns the signal off, everywhere or for this project. */
export function signalEnabled(settings: PermissionSignalSettings, name: PermissionSignalName, project: string): boolean {
  const setting = settings[name];
  if (setting === false) return false;
  if (setting && typeof setting === "object" && setting.except?.some((root) => within(project, root))) return false;
  return true;
}

export function parsePermissionSignalSettings(raw: unknown): PermissionSignalSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const settings: PermissionSignalSettings = {};
  for (const name of PERMISSION_SIGNALS) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value === "boolean") settings[name] = value;
    else if (value && typeof value === "object" && Array.isArray((value as { except?: unknown }).except)) {
      settings[name] = { except: ((value as { except: unknown[] }).except).filter((root): root is string => typeof root === "string" && isAbsolute(root)) };
    }
  }
  return Object.keys(settings).length ? settings : undefined;
}

type PushTarget = { remote: string; branch: string | null; repo: string | null; mirror: string | null };

function pushTargets(call: SignalCall): PushTarget[] {
  const pushes: PushTarget[] = [];
  for (const segment of bashOf(call)) {
    let words = segment.words;
    if (words[0] !== "git") continue;
    let repo: string | null = null;
    if (words[1] === "-C" && words[2]) { repo = absolutePath(words[2], call.cwd); words = ["git", ...words.slice(3)]; }
    if (words[1] !== "push") continue;
    const args = words.slice(2);
    // A dry run sends nothing.
    if (args.some((arg) => arg === "--dry-run" || arg === "-n")) continue;
    const mirror = args.find((arg) => arg === "--mirror" || arg === "--all") ?? null;
    const plain = args.filter((arg, index) => !arg.startsWith("-") && !/^(?:-o|--push-option|--repo)$/.test(args[index - 1] ?? ""));
    const remote = plain[0] ?? "origin";
    const refspec = plain[1] ?? null;
    const branch = refspec ? (refspec.includes(":") ? refspec.split(":").pop()! : refspec).replace(/^\+/, "").replace(/^refs\/heads\//, "") : null;
    pushes.push({ remote, branch: branch === "HEAD" ? null : branch, repo, mirror });
  }
  return pushes;
}

/** What a call is after: the files and secrets it names. A retry in another form names the same ones. */
function intentTargets(call: SignalCall): string[] {
  const targets = new Set<string>();
  if (call.path) targets.add(absolutePath(call.path, call.cwd));
  for (const segment of bashOf(call)) {
    // Changing directory names a place to work, not what the call is after.
    if (/^(?:cd|pushd|popd)$/.test(segment.words[0] ?? "")) continue;
    for (const word of segment.words.slice(1)) {
      // An interpreter one-liner names its file inside a quoted string: `python3 -c 'open(".env")'`.
      const quoted = [...word.matchAll(/["']([^"'\s]+)["']/g)].map((match) => match[1]!);
      for (const arg of quoted.length ? quoted : [word]) {
        if (arg.startsWith("-") || arg.includes("://") || !/[./]/.test(arg) || arg.length < 3 || /[()]/.test(arg)) continue;
        targets.add(absolutePath(arg, call.cwd));
      }
    }
  }
  return [...targets];
}

function formOf(call: SignalCall): string {
  if (call.tool !== "Bash") return call.tool;
  return bashOf(call).map((segment) => segment.words[0]).join("|") || "Bash";
}

/** The call a record line describes, as the signals read it. */
export function signalCallFor(line: Pick<SignalSeedLine, "projectRoot" | "tool" | "command">): SignalCall | null {
  return line.projectRoot && line.command ? seedCall(line as SignalSeedLine) : null;
}

function seedCall(line: SignalSeedLine): SignalCall | null {
  const project = line.projectRoot!;
  const tool = line.tool ?? "";
  const base = { project, cwd: project };
  if (/^(?:Bash|run_command|execute|shell)$/i.test(tool) || !tool) return { ...base, tool: "Bash", command: line.command };
  if (/^(?:Read|read_file|view_file|view|Grep|Glob)$/i.test(tool)) return { ...base, tool: "Read", path: line.command };
  if (/^(?:Edit|Write|MultiEdit|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i.test(tool)) return { ...base, tool: "Edit", path: line.command };
  if (/^(?:WebFetch|read_url_content|fetch)$/i.test(tool)) return { ...base, tool: "WebFetch", url: line.command };
  return null;
}

function seedOutcome(line: SignalSeedLine): "approved" | "asked" | "denied" {
  if (line.decision === "denied" || line.answer === "deny") return "denied";
  return line.decision === "asked" ? "asked" : "approved";
}

function within(path: string, root: string): boolean {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(`${base}${sep}`);
}

function shortPath(path: string, cwd: string): string {
  const absolute = absolutePath(path, cwd);
  const home = homedir();
  if (within(absolute, cwd)) return absolute.slice(resolve(cwd).length + 1) || ".";
  return absolute.startsWith(`${home}/`) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
