import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { HarnessHooks } from "../../../../runtime/src/harness-hooks.ts";
import { createScoutCommandContext } from "../context.ts";
import { planZedScoutContextServerRemoval } from "./zed-settings.ts";
import {
  buildUninstallPlan,
  detectGlobalPackageManager,
  executeUninstallPlan,
  looksLikeScoutMcpEntry,
  parseUninstallArgs,
  runUninstallCommand,
  type UninstallDependencies,
  type UninstallStepResult,
} from "./uninstall.ts";

const SCOUT_SKILL = "---\nname: scout\ndescription: Use Scout\n---\n\n# Scout\n";
const CLAUDE_MCP_GET = [
  "scout:",
  "  Scope: User config (available in all your projects)",
  "  Type: stdio",
  "  Command: /home/.bun/bin/bun",
  "  Args: /home/.bun/install/global/node_modules/@openscout/scout/bin/scout.mjs mcp",
  "",
  "To remove this server, run: claude mcp remove scout -s user",
].join("\n");
const CODEX_MCP_GET = "scout\n  enabled: true\n  transport: stdio\n  command: /home/.bun/bin/scout\n  args: mcp\n  remove: codex mcp remove scout\n";

let home: string;
let savedSupport: string | undefined;
let support: string;
let calls: string[][];
let failCodexRemove: boolean;
let serviceCalls: number;

function write(path: string, text = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function deps(overrides: Partial<UninstallDependencies> = {}): UninstallDependencies {
  const app = join(home, "Applications", "Scout.app");
  return {
    env: { HOME: home, OPENSCOUT_INSTANCE: "prod", OPENSCOUT_SUPPORT_DIRECTORY: support },
    home,
    platform: "darwin",
    run: (command, args) => {
      calls.push([command, ...args]);
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (command === "plutil") return ok("app.openscout.scout\n");
      if (command === "ps") return ok("");
      if (command.endsWith("claude") && args[1] === "get") return ok(CLAUDE_MCP_GET);
      if (command.endsWith("codex") && args[1] === "get") return ok(CODEX_MCP_GET);
      if (command.endsWith("codex") && args[1] === "remove" && failCodexRemove) return { status: 1, stdout: "", stderr: "codex config locked" };
      return ok();
    },
    findExecutable: (name) => `/fake/bin/${name}`,
    uninstallService: async () => {
      serviceCalls += 1;
      rmSync(join(home, "Library", "LaunchAgents", "app.openscout.plist"), { force: true });
    },
    removeClaudeHooks: ({ settingsPath, wrapperPath }) =>
      new HarnessHooks({ settingsPath, wrapperPath, instance: "prod", managedInstalls: false }).remove(),
    scriptPath: join(home, ".bun", "install", "global", "node_modules", "@openscout", "scout", "bin", "scout.mjs"),
    appCandidates: [app],
    sleep: () => undefined,
    ...overrides,
  };
}

function seedInstall(): void {
  const oh = join(home, ".openscout");
  const sh = join(home, ".scout");
  const wrapper = join(support, "runtime", "statusline", "claude-statusline.sh");
  const hookWrapper = join(support, "runtime", "hooks", "openscout-claude-permission-request.sh");
  // ~/.openscout
  write(join(oh, "control-plane", "messages.sqlite"));
  write(join(oh, "chat", "thread.jsonl"));
  write(join(oh, "work-archives", "a.jsonl.gz"));
  write(join(oh, "config.json"), "{}");
  write(join(oh, "user.json"), "{}");
  write(join(oh, "bin", "tailscale"));
  write(join(oh, "extensions", "mesh", "index.js"));
  write(join(oh, "run", "scout-app.sock"));
  // ~/.scout
  write(join(sh, "pairing", "identity.json"));
  write(join(sh, "pairing", "trusted-peers.json"));
  write(join(sh, "pairing", "attachments", "photo.png"));
  write(join(sh, "work", "item.json"));
  write(join(sh, "cli-mtime"));
  write(join(sh, "local-edge", "Caddyfile"));
  // support directory
  write(join(support, "settings.json"), "{}");
  write(join(support, "node-identity.json"), "{}");
  write(join(support, "mesh-bind.json.123.tmp"));
  write(join(support, "blobs", "b1"));
  write(join(support, "tools", "scout-tui", "scout-tui"));
  write(join(support, "runtime", "scoutd"));
  write(join(support, "runtime", "broker.sock"));
  write(join(support, "runtime", "codex-background-home", "history.jsonl"));
  write(wrapper, "#!/bin/sh\n");
  write(join(support, "runtime", "statusline", "claude-history.jsonl"));
  write(hookWrapper, "#!/bin/sh\n");
  write(join(support, "managed-installs.json"), JSON.stringify({
    version: 1,
    updatedAt: 1,
    installs: [
      { id: "s1", kind: "statusline", owner: "openscout", name: "claude-statusline", title: "statusline", status: "active", installedAt: 1, updatedAt: 1, metadata: { previousCommand: "~/bin/my-statusline" }, uninstall: { strategy: "manual" } },
      { id: "k1", kind: "skill", owner: "openscout", name: "scout-skill", title: "skill", status: "active", installedAt: 1, updatedAt: 1, targetPath: join(home, ".claude", "skills", "scout", "SKILL.md"), uninstall: { strategy: "delete-target" } },
      { id: "o1", kind: "config", owner: "hudsonkit", name: "theirs", title: "theirs", status: "active", installedAt: 1, updatedAt: 1, targetPath: join(home, "theirs.txt"), uninstall: { strategy: "delete-target" } },
    ],
  }));
  write(join(home, "theirs.txt"));
  // harness settings
  write(join(home, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    statusLine: { type: "command", command: `'${wrapper}'`, padding: 0 },
    hooks: {
      PermissionRequest: [{ hooks: [{ type: "command", command: `'${hookWrapper}'` }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  }, null, 2));
  write(join(home, ".claude", "skills", "scout", "SKILL.md"), SCOUT_SKILL);
  write(join(home, ".agents", "skills", "scout", "SKILL.md"), SCOUT_SKILL);
  write(join(home, ".agents", "skills", "scout", "notes.md"), "mine");
  write(join(home, ".grok", "skills", "scout", "SKILL.md"), "---\nname: scout-other\n---\nnot ours\n");
  write(join(home, ".config", "zed", "settings.json"), [
    "// my zed settings",
    "{",
    "  \"theme\": \"One Dark\",",
    "  \"context_servers\": {",
    "    \"other\": { \"command\": \"other-mcp\", \"args\": [] },",
    "    \"scout\": { \"command\": \"/home/.bun/bin/scout\", \"args\": [\"mcp\"] }",
    "  },",
    "}",
    "",
  ].join("\n"));
  // service and app
  write(join(home, "Library", "LaunchAgents", "app.openscout.plist"));
  write(join(home, "Applications", "Scout.app", "Contents", "Info.plist"));
}

function byId(results: UninstallStepResult[], id: string): UninstallStepResult | undefined {
  return results.find((row) => row.id === id);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scout-uninstall-"));
  support = join(home, "Library", "Application Support", "OpenScout");
  savedSupport = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = support;
  calls = [];
  failCodexRemove = false;
  serviceCalls = 0;
});

afterEach(() => {
  if (savedSupport === undefined) delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  else process.env.OPENSCOUT_SUPPORT_DIRECTORY = savedSupport;
  rmSync(home, { recursive: true, force: true });
});

describe("scout uninstall", () => {
  test("removes code, config and integrations, and keeps collected data", async () => {
    seedInstall();
    const d = deps();
    const results = await executeUninstallPlan(buildUninstallPlan(d, { deleteData: false }), d);
    expect(results.filter((row) => row.status === "failed")).toEqual([]);

    // service, app, package
    expect(serviceCalls).toBe(1);
    expect(existsSync(join(home, "Applications", "Scout.app"))).toBe(false);
    expect(calls).toContainEqual(["/fake/bin/bun", "remove", "-g", "@openscout/scout"]);
    expect(results.filter((row) => row.status !== "missing").at(-1)!.id).toBe("package");

    // code and config
    for (const gone of [
      ".openscout/config.json", ".openscout/user.json", ".openscout/bin", ".openscout/extensions", ".openscout/run",
      ".scout/pairing/identity.json", ".scout/pairing/trusted-peers.json", ".scout/cli-mtime", ".scout/local-edge",
      "Library/Application Support/OpenScout/settings.json", "Library/Application Support/OpenScout/node-identity.json",
      "Library/Application Support/OpenScout/mesh-bind.json.123.tmp", "Library/Application Support/OpenScout/tools",
      "Library/Application Support/OpenScout/runtime/scoutd", "Library/Application Support/OpenScout/runtime/broker.sock",
      "Library/Application Support/OpenScout/runtime/hooks",
      "Library/Application Support/OpenScout/runtime/statusline/claude-statusline.sh",
      "Library/Application Support/OpenScout/managed-installs.json",
    ]) expect(existsSync(join(home, gone))).toBe(false);

    // collected data stays, and is reported
    const kept = [
      ".openscout/control-plane/messages.sqlite", ".openscout/chat/thread.jsonl", ".openscout/work-archives/a.jsonl.gz",
      ".scout/pairing/attachments/photo.png", ".scout/work/item.json",
      "Library/Application Support/OpenScout/blobs/b1",
      "Library/Application Support/OpenScout/runtime/codex-background-home/history.jsonl",
      "Library/Application Support/OpenScout/runtime/statusline/claude-history.jsonl",
    ];
    for (const path of kept) expect(existsSync(join(home, path))).toBe(true);
    const keptRows = results.filter((row) => row.status === "kept").map((row) => row.path);
    expect(keptRows).toContain(join(home, ".openscout", "control-plane"));
    expect(keptRows).toContain(join(home, ".scout", "pairing", "attachments"));

    // Claude settings: statusline restored, Scout hook gone, the rest untouched
    const claude = readJson(join(home, ".claude", "settings.json"));
    expect(claude.statusLine).toEqual({ type: "command", command: "~/bin/my-statusline" });
    expect(claude.model).toBe("opus");
    expect(claude.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(byId(results, "integration:claude-statusline")?.status).toBe("restored");

    // skills: Scout's go, a folder with other files stays, someone else's skill stays
    expect(existsSync(join(home, ".claude", "skills", "scout"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "scout", "SKILL.md"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "scout", "notes.md"))).toBe(true);
    expect(readFileSync(join(home, ".grok", "skills", "scout", "SKILL.md"), "utf8")).toContain("not ours");

    // MCP registrations
    expect(calls).toContainEqual(["/fake/bin/claude", "mcp", "remove", "--scope", "user", "scout"]);
    expect(calls).toContainEqual(["/fake/bin/codex", "mcp", "remove", "scout"]);
    const zed = readFileSync(join(home, ".config", "zed", "settings.json"), "utf8");
    expect(zed).toContain("// my zed settings");
    expect(zed).toContain("\"other\"");
    expect(zed).not.toContain("\"scout\"");

    // another owner's ledger entry is not Scout's to remove
    expect(existsSync(join(home, "theirs.txt"))).toBe(true);
  });

  test("running it again changes nothing and fails nothing", async () => {
    seedInstall();
    const d = deps();
    await executeUninstallPlan(buildUninstallPlan(d, { deleteData: false }), d);
    calls = [];
    const again = await executeUninstallPlan(buildUninstallPlan(deps({
      run: (command, args) => {
        calls.push([command, ...args]);
        return args[1] === "get" ? { status: 1, stdout: "", stderr: "No MCP server named scout" } : { status: 0, stdout: "", stderr: "" };
      },
      scriptPath: "/nowhere/scout.mjs",
    }), { deleteData: false }), d);
    expect(again.filter((row) => row.status === "failed")).toEqual([]);
    expect(again.filter((row) => ["removed", "restored"].includes(row.status))).toEqual([]);
    expect(serviceCalls).toBe(1);
    expect(calls.filter((call) => call[2] === "remove")).toEqual([]);
  });

  test("--delete-data removes the Scout folders", async () => {
    seedInstall();
    const d = deps();
    const results = await executeUninstallPlan(buildUninstallPlan(d, { deleteData: true }), d);
    expect(results.filter((row) => row.status === "failed")).toEqual([]);
    expect(existsSync(join(home, ".openscout"))).toBe(false);
    expect(existsSync(join(home, ".scout"))).toBe(false);
    expect(existsSync(support)).toBe(false);
    expect(results.some((row) => row.status === "kept")).toBe(false);
    expect(existsSync(join(home, "theirs.txt"))).toBe(true);
  });

  test("one failed step does not stop the rest, and the command exits nonzero", async () => {
    seedInstall();
    failCodexRemove = true;
    const lines: string[] = [];
    const context = createScoutCommandContext({ outputMode: "json", stdout: (line) => lines.push(line), env: { HOME: home } });
    const previousExit = process.exitCode;
    try {
      await runUninstallCommand(context, ["--yes"], deps());
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExit;
    }
    const output = JSON.parse(lines.join("\n")) as { failed: number; steps: UninstallStepResult[] };
    expect(output.failed).toBe(1);
    expect(byId(output.steps, "integration:mcp:codex")).toMatchObject({ status: "failed", detail: "codex config locked" });
    expect(byId(output.steps, "package")?.status).toBe("removed");
    expect(existsSync(join(home, ".openscout", "config.json"))).toBe(false);
  });

  test("--dry-run prints the plan and changes nothing", async () => {
    seedInstall();
    const lines: string[] = [];
    const context = createScoutCommandContext({ outputMode: "json", stdout: (line) => lines.push(line), env: { HOME: home } });
    await runUninstallCommand(context, ["--dry-run"], deps());
    const output = JSON.parse(lines.join("\n")) as { dryRun: boolean; steps: UninstallStepResult[] };
    expect(output.dryRun).toBe(true);
    expect(byId(output.steps, "service")?.status).toBe("planned");
    expect(serviceCalls).toBe(0);
    expect(calls.filter((call) => call[2] === "remove" || call[1] === "remove")).toEqual([]);
    expect(existsSync(join(home, ".openscout", "config.json"))).toBe(true);
    expect(existsSync(join(home, "Applications", "Scout.app"))).toBe(true);
  });

  test("refuses to start without --yes when it cannot ask", async () => {
    seedInstall();
    const context = createScoutCommandContext({ outputMode: "plain", stdout: () => undefined, env: { HOME: home }, isTty: false });
    await expect(runUninstallCommand(context, [], deps())).rejects.toThrow("--dry-run");
    expect(existsSync(join(home, ".openscout", "config.json"))).toBe(true);
  });

  test("leaves entries that are not Scout's", async () => {
    seedInstall();
    write(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "my-statusline" } }));
    const d = deps({
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === "plutil") return { status: 0, stdout: "com.example.other\n", stderr: "" };
        if (args[1] === "get") return { status: 0, stdout: "scout\n  command: /usr/bin/other-tool\n  args: serve\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const results = await executeUninstallPlan(buildUninstallPlan(d, { deleteData: false }), d);
    expect(existsSync(join(home, "Applications", "Scout.app"))).toBe(true);
    expect(byId(results, `app:${join(home, "Applications", "Scout.app")}`)?.status).toBe("skipped");
    expect(byId(results, "integration:mcp:claude")?.status).toBe("skipped");
    expect(calls.filter((call) => call[2] === "remove")).toEqual([]);
    expect(readJson(join(home, ".claude", "settings.json")).statusLine).toEqual({ type: "command", command: "my-statusline" });
  });

  test("an older capture-script statusline is restored from its ledger entry", async () => {
    seedInstall();
    const capture = join(support, "runtime", "statusline", "claude-statusline-capture.sh");
    write(capture, "#!/bin/sh\n");
    write(join(home, ".claude", "settings.json"), JSON.stringify({
      statusLine: { type: "command", command: `OPENSCOUT_CLAUDE_STATUSLINE_DELEGATE='bash ~/.claude/line.sh' bash '${capture}'` },
    }));
    write(join(support, "managed-installs.json"), JSON.stringify({ version: 1, updatedAt: 1, installs: [
      { id: "c1", kind: "config", owner: "openscout", name: "claude-statusline-settings", title: "t", status: "active", installedAt: 1, updatedAt: 1, metadata: { previousCommand: "bash ~/.claude/line.sh" }, uninstall: { strategy: "manual" } },
    ] }));
    const d = deps();
    const results = await executeUninstallPlan(buildUninstallPlan(d, { deleteData: false }), d);
    expect(readJson(join(home, ".claude", "settings.json")).statusLine).toEqual({ type: "command", command: "bash ~/.claude/line.sh" });
    expect(results.some((row) => row.status === "manual")).toBe(false);
    expect(existsSync(capture)).toBe(false);
  });

  test("a dev instance leaves the per-login integrations to the main instance", () => {
    const root = join(home, ".openscout", "instances", "dev");
    write(join(root, "config.json"));
    write(join(root, "control-plane", "m.sqlite"));
    seedInstall();
    const d = deps({ env: { HOME: home, OPENSCOUT_INSTANCE: "dev", OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support") } });
    const plan = buildUninstallPlan(d, { deleteData: false });
    expect(plan.isProd).toBe(false);
    const ids = plan.steps.map((step) => step.id);
    expect(ids.some((id) => id.startsWith("integration:") || id.startsWith("app") || id === "package")).toBe(false);
    expect(plan.steps.every((step) => !step.path || step.path.startsWith(root) || step.id === "service")).toBe(true);
  });
});

describe("uninstall helpers", () => {
  test("options", () => {
    expect(parseUninstallArgs(["--dry-run", "-y", "--delete-data"])).toEqual({ dryRun: true, yes: true, deleteData: true, help: false });
    expect(() => parseUninstallArgs(["--purge"])).toThrow("unknown option");
  });

  test("Scout MCP entries are recognised by launcher and args", () => {
    expect(looksLikeScoutMcpEntry(CLAUDE_MCP_GET)).toBe(true);
    expect(looksLikeScoutMcpEntry(CODEX_MCP_GET)).toBe(true);
    expect(looksLikeScoutMcpEntry("scout:\n  Command: /usr/bin/scout-other\n  Args: mcp\n")).toBe(false);
    expect(looksLikeScoutMcpEntry("scout:\n  Command: /usr/bin/scout\n  Args: serve\nclaude mcp remove scout")).toBe(false);
  });

  test("global package manager comes from the install path", () => {
    expect(detectGlobalPackageManager("/u/.bun/install/global/node_modules/@openscout/scout/bin/scout.mjs")?.manager).toBe("bun");
    expect(detectGlobalPackageManager("/usr/local/lib/node_modules/@openscout/scout/bin/scout.mjs")).toEqual({ manager: "npm", root: "/usr/local/lib/node_modules/@openscout/scout" });
    expect(detectGlobalPackageManager("/repo/packages/cli/bin/scout.mjs")).toBeNull();
    expect(detectGlobalPackageManager("/proj/node_modules/@openscout/scout/bin/scout.mjs")).toBeNull();
  });

  test("Zed removal keeps comments and the other servers", () => {
    const last = "{\n  // keep me\n  \"context_servers\": {\n    \"a\": {},\n    \"scout\": { \"command\": \"scout\", \"args\": [\"mcp\"] }\n  }\n}\n";
    const out = planZedScoutContextServerRemoval(last);
    expect(out).toEqual({ action: "write", text: "{\n  // keep me\n  \"context_servers\": {\n    \"a\": {}\n  }\n}\n" });
    const first = "{ \"context_servers\": { \"scout\": { \"command\": \"scout\" }, \"b\": {} } }";
    expect(planZedScoutContextServerRemoval(first)).toEqual({ action: "write", text: "{ \"context_servers\": { \"b\": {} } }" });
    expect(planZedScoutContextServerRemoval("{ \"theme\": \"x\" }")).toEqual({ action: "absent" });
  });
});
