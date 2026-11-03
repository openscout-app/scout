import { assessScoutSetupCompletion } from "../../lib/core/setup/readiness.ts";
import { SETUP_HELP } from "../../../bin/lifecycle-preflight.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { parseSetupCommandOptions } from "../options.ts";
import { runScoutSetup } from "../../lib/core/setup/service.ts";
import { renderScoutSetupReport } from "../../lib/ui/terminal/setup.ts";
import { readOpenScoutSettings } from "@openscout/runtime/setup";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import { scoutTuiNeedsDownload, SCOUT_TUI_INSTALL_OFFER } from "./tui.ts";

type SourceRootPrompt = (suggestedRoot: string, additionalRootCount: number) => Promise<string>;

function findGitRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function suggestProjectSourceRoot(
  currentDirectory: string,
  homeDirectory = homedir(),
): string {
  const gitRoot = findGitRoot(currentDirectory);
  // A dotfiles repo at ~/.git would otherwise suggest the parent of home
  // (`/Users`), which is never where anyone keeps projects.
  if (gitRoot && resolve(gitRoot) !== resolve(homeDirectory)) return dirname(gitRoot);

  for (const candidate of [
    join(homeDirectory, "dev"),
    join(homeDirectory, "Developer"),
    join(homeDirectory, "Projects"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(currentDirectory);
}

function expandHome(value: string, homeDirectory = homedir()): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return join(homeDirectory, value.slice(2));
  return value;
}

async function promptForSourceRoot(
  suggestedRoot: string,
  additionalRootCount: number,
): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existingSuffix = additionalRootCount > 0
      ? ` + ${additionalRootCount} more existing ${additionalRootCount === 1 ? "root" : "roots"}`
      : "";
    const answer = await prompt.question(
      `Where do you keep your projects? [${suggestedRoot}${existingSuffix}] `,
    );
    return answer.trim();
  } finally {
    prompt.close();
  }
}

/** What settings already record about project roots, for the rerun guard. */
export type ExistingSourceRootState = {
  /** `discovery.workspaceRoots` — seeded on read, so never reliably empty. */
  roots: string[];
  /** `onboarding.sourceRootsAnsweredAt` — null until the operator answers. */
  answeredAt: number | null;
};

export async function resolveSetupSourceRoots(
  context: Pick<ScoutCommandContext, "isTty" | "output">,
  currentDirectory: string,
  sourceRoots: string[],
  existing: ExistingSourceRootState,
  ask: SourceRootPrompt = promptForSourceRoot,
): Promise<string[]> {
  if (sourceRoots.length > 0 || !context.isTty || context.output.mode === "json") {
    return sourceRoots;
  }
  // Guard on the answer, not on the array. `discovery.workspaceRoots` is seeded
  // with a plausible default whenever it reads back empty, so a non-empty array
  // proves nothing about whether the operator was ever asked — gating on it made
  // this prompt unreachable on any machine that had ever written settings.
  if (existing.answeredAt !== null) return [];

  const suggestedRoot = existing.roots[0] ?? suggestProjectSourceRoot(currentDirectory);
  const selectedRoot = (await ask(suggestedRoot, Math.max(0, existing.roots.length - 1))).trim();
  // Legacy/migrated settings can contain several curated roots without the
  // newer answer timestamp. Accepting the displayed default means "keep what
  // I have", not "replace the list with only its first display value".
  if (!selectedRoot && existing.roots.length > 0) return existing.roots;
  // Resolve against the setup context directory, not process.cwd(), so a
  // relative answer means the same thing under OPENSCOUT_SETUP_CWD.
  return [resolve(currentDirectory, expandHome(selectedRoot || suggestedRoot))];
}

const AGENTS_MD_HELP = `scout setup agents-md — add Scout's pointer block to this project's AGENTS.md

  scout setup agents-md            add (or refresh) the block, between <!-- scout:begin/end --> markers
  scout setup agents-md --dry-run  print what the file would become
  scout setup agents-md --remove   take the block out; nothing else in the file changes

The block is three lines that point at Scout's help, so every harness that reads
AGENTS.md knows to use Scout for other agents and other machines. Project files
only: it refuses a home-level AGENTS.md.`;

const PERMISSIONS_HELP = `scout setup permissions — print a narrow allow list for Scout's read-only MCP tools

  scout setup permissions [--server <name>]   (default server name: scout)

Prints only; it never edits settings. Paste the entries into permissions.allow in
the settings file you choose. Tools that send or start work (ask, reply)
are not on it and keep the harness's normal approval.`;

async function runSetupSubcommand(context: ScoutCommandContext, args: string[]): Promise<boolean> {
  const sub = args[0];
  if (sub !== "agents-md" && sub !== "permissions") return false;
  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    context.output.writeText(sub === "agents-md" ? AGENTS_MD_HELP : PERMISSIONS_HELP);
    return true;
  }
  const { runAgentGuide, claudeAllowList, SCOUT_READ_ONLY_TOOLS } = await import("../../lib/core/setup/agent-guide.ts");
  if (sub === "agents-md") {
    const unknown = rest.filter((arg) => arg !== "--remove" && arg !== "--dry-run");
    if (unknown.length > 0) throw new Error(`unexpected argument for setup agents-md: ${unknown[0]}`);
    const result = runAgentGuide({
      directory: defaultScoutContextDirectory(context),
      remove: rest.includes("--remove"),
      dryRun: rest.includes("--dry-run"),
    });
    context.output.writeValue(result, (value) => {
      const verb = {
        added: "Added the Scout block to",
        updated: "Refreshed the Scout block in",
        unchanged: "The Scout block is already current in",
        removed: "Removed the Scout block from",
        absent: "No Scout block in",
      }[value.change];
      return value.dryRun ? `${value.path} would become:\n\n${value.preview}` : `${verb} ${value.path}`;
    });
    return true;
  }
  const serverIndex = rest.indexOf("--server");
  const server = serverIndex >= 0 ? rest[serverIndex + 1]?.trim() : undefined;
  if (serverIndex >= 0 && !server) throw new Error("missing value for --server");
  const allow = claudeAllowList(server || "scout");
  context.output.writeValue({ readOnlyTools: [...SCOUT_READ_ONLY_TOOLS], claude: { permissions: { allow } } }, () => [
    "Read-only Scout tools a harness can allow without a prompt (printed only; nothing was changed):",
    "",
    JSON.stringify({ permissions: { allow } }, null, 2),
    "",
    "Claude Code: merge into permissions.allow in the settings file you choose.",
    "Codex and others: allow the same tool names in that client's MCP approval settings.",
  ].join("\n"));
  return true;
}

export async function runSetupCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (await runSetupSubcommand(context, args)) return;
  if (args.includes("--help") || args.includes("-h")) {
    context.output.writeText(SETUP_HELP);
    return;
  }
  const options = parseSetupCommandOptions(args, defaultScoutContextDirectory(context));
  const settings = await readOpenScoutSettings({ currentDirectory: options.currentDirectory });
  const hasSavedSettings = existsSync(resolveOpenScoutSupportPaths().settingsPath);
  options.sourceRoots = await resolveSetupSourceRoots(
    // The prompt reads stdin, but context.isTty only describes stdout. Without
    // the stdin check, a piped stdin under a TTY stdout blocks on a question
    // nobody can answer.
    { ...context, isTty: context.isTty && Boolean(process.stdin.isTTY) && !context.env.SSH_CONNECTION && !context.env.SSH_TTY },
    options.currentDirectory,
    options.sourceRoots,
    {
      roots: hasSavedSettings ? settings.discovery.workspaceRoots : [],
      answeredAt: hasSavedSettings ? settings.onboarding.sourceRootsAnsweredAt : null,
    },
  );
  const report = await runScoutSetup(options);
  const completion = assessScoutSetupCompletion({ ...report,
    failures: [
      ...report.scoutSkill.entries.filter((entry) => entry.status === "error")
        .map((entry) => entry.error ?? `Skill install failed: ${entry.id}`),
      ...(report.claudeStatusline.status === "error"
        ? [report.claudeStatusline.error ?? "Claude statusline install failed"] : []),
    ],
  });
  context.output.writeValue({ schema: "scout.setup.v2", ...report, ...completion }, (value) => renderScoutSetupReport(value, completion));
  if (completion.outcome === "failed") process.exitCode = 1;
  // An offer only; setup never downloads it.
  if (context.output.mode !== "json" && scoutTuiNeedsDownload({ env: context.env, cwd: options.currentDirectory })) {
    context.output.writeText(SCOUT_TUI_INSTALL_OFFER);
  }
}
