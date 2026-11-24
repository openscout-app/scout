// `scout auth`: sign in to your Scout account from the terminal.
//
// `scout auth login` runs a device sign-in (RFC 8628) against the download
// host. It shows a short code, opens console.openscout.app/device in the
// browser, and waits while you sign in (or make an account) and approve.
// The approval comes back as a download key, saved where `scout web login`
// has always saved it. `--key` keeps the paste path for keys made by hand.
import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import {
  DIST_KEY_PREFIX,
  SCOUT_DIST_KEYS_URL,
  defaultDistKeyStores,
  distBaseUrl,
  resolveDistKey,
  type DistKeyStore,
} from "@openscout/runtime/routing";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/config";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export const CLI_DEVICE_CODE_PATH = "/v1/cli/device/code";
export const CLI_DEVICE_TOKEN_PATH = "/v1/cli/device/token";
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 600;
const SLOW_DOWN_STEP_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

type ScoutFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ScoutAuthDeps = {
  fetchImpl?: ScoutFetch;
  supportDirectory?: string;
  readStdin?: () => Promise<string>;
  keyStores?: DistKeyStore[];
  promptKey?: () => Promise<string>;
  /** Whether stdin is a terminal; defaults to process.stdin.isTTY. */
  stdinIsTty?: boolean;
  /** Opens a page in the browser; resolves false when it couldn't. */
  openBrowser?: (url: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  hostname?: () => string;
  /** Cancels a waiting sign-in; defaults to Ctrl-C. */
  signal?: AbortSignal;
};

export type SignedIn = { login: string | null; label: string | null; where: string };

export function renderAuthCommandHelp(): string {
  return [
    "scout auth — sign in to your Scout account",
    "",
    "Usage:",
    "  scout auth login                 Sign in through the browser and save the key it returns",
    "  scout auth login --no-browser    Print the sign-in page instead of opening it",
    "  scout auth login --key <key|->   Save a download key you already have (- reads stdin)",
    "  scout auth status                Show the signed-in account and where its key is saved",
    "  scout auth logout                Forget the saved key on this machine",
    "",
    "Signing in opens console.openscout.app, where you sign in or make an account and",
    "approve this terminal with the code it shows. The download key that comes back is",
    "saved in the macOS Keychain (the Secret Service on Linux, otherwise a private file).",
    "SCOUT_DIST_KEY overrides the saved key (handy for VMs and CI). OPENSCOUT_DIST_URL",
    "points at another host.",
  ].join("\n");
}

/* ── shared with `scout web` ───────────────────────────────────────────── */

export function supportDirectoryOf(deps: ScoutAuthDeps): string {
  return deps.supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
}

export async function distKeyStores(deps: ScoutAuthDeps, env: NodeJS.ProcessEnv): Promise<DistKeyStore[]> {
  return deps.keyStores ?? await defaultDistKeyStores(supportDirectoryOf(deps), env);
}

export function stdinIsTty(deps: ScoutAuthDeps): boolean {
  return deps.stdinIsTty ?? Boolean(process.stdin.isTTY);
}

/** Both ends are a terminal, so Scout can ask and a person can answer. */
export function isInteractive(context: ScoutCommandContext, deps: ScoutAuthDeps): boolean {
  return context.isTty && stdinIsTty(deps);
}

export function readFlagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) {
      throw new ScoutCliError(`${name} needs a value`);
    }
    return value;
  }
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Asks for the key without echoing it, so it stays out of shell history and
// off the screen.
async function promptHiddenKey(): Promise<string> {
  process.stderr.write("Download key: ");
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.once("line", resolve));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

export async function distRequest(
  context: ScoutCommandContext,
  deps: ScoutAuthDeps,
  key: string,
  path: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal = AbortSignal.timeout(timeoutMs),
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${distBaseUrl(context.env)}${path}`;
  try {
    return await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json, application/gzip" },
      signal,
    });
  } catch (error) {
    throw new ScoutCliError(`Couldn't reach ${distBaseUrl(context.env)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function explainFailure(status: number, body: { error?: string } | null): string {
  if (status === 401) return "The download key was not accepted. It may be revoked; sign in again: scout auth login";
  if (status === 403) return "This account doesn't have the full web app.";
  if (status === 404 && body?.error === "not_published") return "not_published";
  return `The download host answered ${status}${body?.error ? ` (${body.error})` : ""}.`;
}

/** Saves to the first store that takes the key, then clears the rest so no stale copy outlives a logout. */
async function saveDistKey(stores: DistKeyStore[], key: string): Promise<DistKeyStore> {
  let saved: DistKeyStore | undefined;
  for (const store of stores) {
    if (await store.write(key)) {
      saved = store;
      break;
    }
  }
  if (!saved) throw new ScoutCliError("Couldn't save the download key.");
  for (const store of stores) if (store !== saved) await store.remove();
  return saved;
}

/* ── login ─────────────────────────────────────────────────────────────── */

export type AuthLoginOptions = {
  /** `scout web login` has always read a piped key when stdin isn't a terminal. */
  readPipedKey?: boolean;
  /** The line printed after signing in; null prints none. */
  next?: string | null;
};

export async function runAuthLogin(
  context: ScoutCommandContext,
  args: string[],
  deps: ScoutAuthDeps,
  options: AuthLoginOptions = {},
): Promise<SignedIn> {
  const next = options.next === undefined ? "scout web install" : options.next;
  const flag = readFlagValue(args, "--key");
  let pasted: string | undefined;
  if (flag === "-") {
    pasted = isInteractive(context, deps)
      ? await (deps.promptKey ?? promptHiddenKey)()
      : await (deps.readStdin ?? readAllStdin)();
    if (!pasted.trim()) throw new ScoutCliError("No key given. Sign in with: scout auth login");
  } else if (flag !== undefined) {
    pasted = flag;
  } else if (options.readPipedKey && !isInteractive(context, deps)) {
    // An empty pipe means nobody sent a key; sign in through the browser instead.
    pasted = (await (deps.readStdin ?? readAllStdin)()) || undefined;
  }

  const signedIn = pasted !== undefined
    ? await saveCheckedKey(context, deps, pasted.trim())
    : await deviceSignIn(context, args, deps);
  const who = signedIn.login ? ` as ${signedIn.login}` : "";
  // A pasted key was named by hand, so its name helps; a key from the browser is named after this host.
  const named = pasted !== undefined && signedIn.label ? ` (key "${signedIn.label}")` : "";
  context.output.writeValue(
    { signedIn: true, login: signedIn.login, label: signedIn.label, keyWhere: signedIn.where },
    () => [`Signed in${who}${named}. Key saved in ${signedIn.where}.`, ...(next ? [`Next: ${next}`] : [])].join("\n"),
  );
  return signedIn;
}

/** The paste path: the host must accept the key before it is saved. */
async function saveCheckedKey(context: ScoutCommandContext, deps: ScoutAuthDeps, key: string): Promise<SignedIn> {
  if (!key) throw new ScoutCliError("No key given. Sign in with: scout auth login");
  if (!key.startsWith(DIST_KEY_PREFIX)) throw new ScoutCliError(`That isn't a download key; they start with ${DIST_KEY_PREFIX}.`);
  const response = await distRequest(context, deps, key, "/v1/dist/whoami");
  const body = await response.json().catch(() => null) as { login?: string | null; label?: string | null; error?: string } | null;
  if (!response.ok) throw new ScoutCliError(explainFailure(response.status, body));
  const saved = await saveDistKey(await distKeyStores(deps, context.env), key);
  return { login: body?.login ?? null, label: body?.label ?? null, where: saved.where };
}

type DeviceGrant = {
  deviceCode: string;
  userCode: string;
  page: string;
  expiresIn: number;
  interval: number;
};

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The host may only send the browser to its own pages. */
function readGrant(body: unknown, base: string): DeviceGrant {
  const grant = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const deviceCode = typeof grant.device_code === "string" ? grant.device_code : "";
  const userCode = typeof grant.user_code === "string" ? grant.user_code : "";
  const page = typeof grant.verification_uri_complete === "string" ? grant.verification_uri_complete
    : typeof grant.verification_uri === "string" ? grant.verification_uri : "";
  if (!deviceCode || !userCode || !page) throw new ScoutCliError("The sign-in host sent an incomplete answer; try again in a moment.");
  let origin: string;
  try {
    origin = new URL(page).origin;
  } catch {
    throw new ScoutCliError("The sign-in host sent an incomplete answer; try again in a moment.");
  }
  if (origin !== new URL(base).origin) {
    throw new ScoutCliError(`The sign-in host sent a page on another site (${origin}); not opening it.`);
  }
  return {
    deviceCode,
    userCode,
    page,
    expiresIn: positiveSeconds(grant.expires_in, DEFAULT_EXPIRES_SECONDS),
    interval: positiveSeconds(grant.interval, DEFAULT_INTERVAL_SECONDS),
  };
}

async function postJson(
  fetchImpl: ScoutFetch,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ response: Response; body: { error?: string; error_description?: string } & Record<string, unknown> | null }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  return { response, body: await response.json().catch(() => null) };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ctrl-C ends the wait with a plain message instead of a stack. */
function cancellation(deps: ScoutAuthDeps): { signal: AbortSignal; release: () => void } {
  if (deps.signal) return { signal: deps.signal, release: () => undefined };
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  return { signal: controller.signal, release: () => process.off("SIGINT", onInterrupt) };
}

const CANCELLED = "Sign-in cancelled. Nothing was saved.";

function mayOpenBrowser(context: ScoutCommandContext, args: string[]): boolean {
  if (args.includes("--no-browser") || !context.isTty) return false;
  return !context.env.SSH_CONNECTION?.trim() && !context.env.SSH_TTY?.trim();
}

async function deviceSignIn(context: ScoutCommandContext, args: string[], deps: ScoutAuthDeps): Promise<SignedIn> {
  const base = distBaseUrl(context.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const label = `Scout CLI on ${(deps.hostname ?? osHostname)()}`.replace(/[^\x20-\x7e]/g, "").slice(0, 80);
  const { signal, release } = cancellation(deps);
  try {
    let start;
    try {
      start = await postJson(fetchImpl, `${base}${CLI_DEVICE_CODE_PATH}`, { label }, signal);
    } catch (error) {
      if (signal.aborted) throw new ScoutCliError(CANCELLED);
      throw new ScoutCliError(`Couldn't reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (start.response.status === 429) {
      throw new ScoutCliError("Too many sign-in attempts from this address. Wait a few minutes, then try again.");
    }
    if (!start.response.ok) {
      const reason = start.body?.error ? ` (${start.body.error})` : "";
      throw new ScoutCliError(`The sign-in host answered ${start.response.status}${reason}.`);
    }
    const grant = readGrant(start.body, base);

    // Prompts go to stderr so `--json` output stays one value.
    context.stderr("To sign in, open this page and confirm the code:");
    context.stderr(`  ${grant.page}`);
    context.stderr(`Code: ${grant.userCode}`);
    const opened = mayOpenBrowser(context, args)
      && await (deps.openBrowser ?? openInBrowser)(grant.page, context.env).catch(() => false);
    context.stderr(opened
      ? "Opened your browser. Sign in or make an account there, then approve this terminal."
      : "Open it on any device with a browser, sign in or make an account, then approve this terminal.");
    context.stderr("Waiting for approval…");

    const deadline = now() + grant.expiresIn * 1000;
    let interval = grant.interval;
    let lastProblem: string | null = null;
    for (;;) {
      try {
        await sleep(interval * 1000, signal);
      } catch {
        throw new ScoutCliError(CANCELLED);
      }
      if (now() >= deadline) {
        throw new ScoutCliError(`The sign-in code expired before it was approved${lastProblem ? ` (last answer: ${lastProblem})` : ""}. Run: scout auth login`);
      }
      let poll;
      try {
        poll = await postJson(fetchImpl, `${base}${CLI_DEVICE_TOKEN_PATH}`, { device_code: grant.deviceCode }, signal);
      } catch (error) {
        if (signal.aborted) throw new ScoutCliError(CANCELLED);
        // A dropped request is not an answer; keep waiting until the code expires.
        lastProblem = error instanceof Error ? error.message : String(error);
        continue;
      }
      // An answer clears an earlier dropped request, so an expiry names only a problem that lasted.
      lastProblem = null;
      if (poll.response.ok) {
        const key = typeof poll.body?.key === "string" ? poll.body.key : "";
        if (!key.startsWith(DIST_KEY_PREFIX)) throw new ScoutCliError("The sign-in host approved this terminal but sent no download key.");
        const saved = await saveDistKey(await distKeyStores(deps, context.env), key);
        return {
          login: typeof poll.body?.login === "string" ? poll.body.login : null,
          label: typeof poll.body?.label === "string" ? poll.body.label : null,
          where: saved.where,
        };
      }
      switch (poll.body?.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval += SLOW_DOWN_STEP_SECONDS;
          continue;
        case "access_denied":
          throw new ScoutCliError("Sign-in was denied in the browser. Nothing was saved.");
        case "expired_token":
          throw new ScoutCliError("The sign-in code expired before it was approved. Run: scout auth login");
        case "invalid_grant":
          throw new ScoutCliError("The host no longer knows this sign-in; it may already be used. Run: scout auth login");
        case "not_entitled":
          throw new ScoutCliError("This account can't download the full web app.");
        case "too_many_keys":
          throw new ScoutCliError(`This account has as many download keys as it can hold. Revoke one at ${SCOUT_DIST_KEYS_URL}, then run: scout auth login`);
      }
      if (poll.response.status === 429 || poll.response.status >= 500) {
        lastProblem = `${poll.response.status}${poll.body?.error ? ` ${poll.body.error}` : ""}`;
        continue;
      }
      const reason = poll.body?.error ? ` (${poll.body.error})` : "";
      throw new ScoutCliError(`The sign-in host answered ${poll.response.status}${reason}.`);
    }
  } finally {
    release();
  }
}

/** `open` on macOS; `xdg-open` on Linux when there is a display to open it on. */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "linux" && (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) ? "xdg-open"
    : null;
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/* ── status and logout ─────────────────────────────────────────────────── */

type AuthStatus = {
  signedIn: boolean;
  state: "signed_out" | "signed_in" | "key_rejected" | "not_entitled" | "unreachable";
  host: string;
  login: string | null;
  label: string | null;
  keyWhere: string | null;
  detail: string | null;
};

async function runAuthStatus(context: ScoutCommandContext, deps: ScoutAuthDeps): Promise<void> {
  const host = distBaseUrl(context.env);
  const resolved = await resolveDistKey(context.env, await distKeyStores(deps, context.env));
  let status: AuthStatus = { signedIn: false, state: "signed_out", host, login: null, label: null, keyWhere: null, detail: null };
  if (resolved) {
    status = { ...status, keyWhere: resolved.where };
    try {
      const response = await distRequest(context, deps, resolved.key, "/v1/dist/whoami");
      const body = await response.json().catch(() => null) as { login?: string | null; label?: string | null; error?: string } | null;
      if (response.ok) {
        status = { ...status, signedIn: true, state: "signed_in", login: body?.login ?? null, label: body?.label ?? null };
      } else if (response.status === 401) {
        status = { ...status, state: "key_rejected" };
      } else if (response.status === 403) {
        status = { ...status, signedIn: true, state: "not_entitled" };
      } else {
        status = { ...status, state: "unreachable", detail: `answered ${response.status}` };
      }
    } catch (error) {
      status = { ...status, state: "unreachable", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  context.output.writeValue(status, (value) => {
    const who = value.login ? ` as ${value.login}` : "";
    const key = value.label ? ` (key "${value.label}")` : "";
    switch (value.state) {
      case "signed_out":
        return "Not signed in. Run: scout auth login";
      case "signed_in":
        return `Signed in${who}${key}.\nKey saved in ${value.keyWhere}.`;
      case "key_rejected":
        return `The saved key in ${value.keyWhere} was not accepted; it may have been revoked.\nRun: scout auth login`;
      case "not_entitled":
        return `Signed in, but this account can't download the full web app.\nKey saved in ${value.keyWhere}.`;
      case "unreachable":
        return `Couldn't check the key with ${value.host}: ${value.detail}.\nKey saved in ${value.keyWhere}.`;
    }
  });
}

export async function runAuthLogout(context: ScoutCommandContext, deps: ScoutAuthDeps): Promise<void> {
  let removed = false;
  // Every store, in order, so no copy outlives a logout.
  for (const store of await distKeyStores(deps, context.env)) removed = (await store.remove()) || removed;
  const lines = [removed
    ? `Download key removed. To stop it working anywhere, revoke it at ${SCOUT_DIST_KEYS_URL}`
    : "No saved download key."];
  if (context.env.SCOUT_DIST_KEY?.trim()) lines.push("SCOUT_DIST_KEY is still set in this environment; unset it to sign out fully.");
  context.output.writeText(lines.join("\n"));
}

export async function runAuthCommand(
  context: ScoutCommandContext,
  args: string[],
  deps: ScoutAuthDeps = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h" || rest.includes("--help")) {
    context.output.writeText(renderAuthCommandHelp());
    return;
  }
  switch (subcommand) {
    case "login":
      await runAuthLogin(context, rest, deps);
      return;
    case "status":
      return runAuthStatus(context, deps);
    case "logout":
      return runAuthLogout(context, deps);
    default:
      throw new ScoutCliError(`unknown subcommand: scout auth ${subcommand}; see scout auth --help`);
  }
}
