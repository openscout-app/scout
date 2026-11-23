import { describe, expect, test } from "bun:test";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHarnessResumeCommand,
  createBuiltInHarnessCatalog,
  evaluateHarnessReadiness,
  findHarnessEntry,
  loadHarnessCatalogSnapshot,
  mergeHarnessCatalogEntries,
  resolveHarnessSessionDefaults,
  writeHarnessCatalogOverrides,
} from "./harness-catalog.js";

describe("harness catalog", () => {
  test("built-in catalog contains the current supported external harnesses", () => {
    const entries = createBuiltInHarnessCatalog();

    expect(entries.map((entry) => entry.name)).toEqual(["claude", "grok", "codex", "grok-acp", "kimi", "opencode", "cursor", "antigravity", "devin", "flue", "pi"]);
    expect(entries.find((entry) => entry.name === "claude")?.support.collaboration).toBe(true);
    expect(entries.find((entry) => entry.name === "codex")?.support.workspace).toBe(true);
    expect(entries.find((entry) => entry.name === "claude")?.sessionDefaults).toEqual({
      defaultTransport: "tmux",
      fallbackTransports: ["claude_stream_json"],
    });
    expect(entries.find((entry) => entry.name === "grok-acp")?.metadata?.adapterType).toBe("grok-acp");
    expect(entries.find((entry) => entry.name === "kimi")?.metadata?.adapterType).toBe("kimi-acp");
    expect(entries.find((entry) => entry.name === "cursor")?.metadata?.adapterType).toBe("cursor-acp");
    expect(entries.find((entry) => entry.name === "opencode")?.metadata?.adapterType).toBe("opencode-acp");
    expect(entries.find((entry) => entry.name === "opencode")?.sessionDefaults).toEqual({
      defaultTransport: "opencode_acp",
    });
    expect(findHarnessEntry("agy")).toMatchObject({
      harness: "antigravity",
      install: { binary: "agy" },
      sessionDefaults: { defaultTransport: "antigravity_acp" },
      readiness: { healthcheckCommand: "agy models", loginCommand: "agy acp --login" },
    });
    expect(entries.find((entry) => entry.name === "devin")?.metadata?.adapterType).toBe("devin-acp");
    expect(entries.find((entry) => entry.name === "devin")?.sessionDefaults).toEqual({
      defaultTransport: "devin_acp",
    });
    expect(entries.find((entry) => entry.name === "pi")?.install?.macos).toBe(
      "npm install -g @earendil-works/pi-coding-agent",
    );
  });

  test("keeps `oc` as an OpenCode alias but not the product-V2 `opencode2`", () => {
    expect(findHarnessEntry("oc")?.harness).toBe("opencode");
    expect(findHarnessEntry("opencode")?.harness).toBe("opencode");
    // `opencode2` is the product-V2 integration, not an `opencode` alias.
    expect(findHarnessEntry("opencode2")).toBeNull();
    expect(resolveHarnessSessionDefaults("opencode2")).toBeNull();
  });

  test("declaratively resolves default harnesses and transports for new sessions", () => {
    expect(resolveHarnessSessionDefaults("claude")).toEqual({
      harness: "claude",
      transport: "tmux",
      fallbackTransports: ["claude_stream_json"],
    });
    expect(resolveHarnessSessionDefaults("claude", { transportOverride: "claude_stream_json" })?.transport)
      .toBe("claude_stream_json");
    expect(resolveHarnessSessionDefaults("grok")).toEqual({
      harness: "grok-acp",
      transport: "grok_acp",
      fallbackTransports: [],
    });
    expect(resolveHarnessSessionDefaults("kimi")).toEqual({
      harness: "kimi",
      transport: "kimi_acp",
      fallbackTransports: [],
    });
    expect(resolveHarnessSessionDefaults("cursor")).toEqual({
      harness: "cursor",
      transport: "cursor_acp",
      fallbackTransports: [],
    });
  });

  test("merge applies local overrides without discarding nested builtin fields", () => {
    const [claude] = mergeHarnessCatalogEntries(createBuiltInHarnessCatalog(), {
      claude: {
        support: {
          browser: true,
        },
        install: {
          verify: "claude --version >/dev/null 2>&1",
        },
        sessionDefaults: {
          fallbackTransports: ["claude_stream_json", "local_socket"],
        },
      },
    });

    expect(claude?.support.browser).toBe(true);
    expect(claude?.support.collaboration).toBe(true);
    expect(claude?.install?.binary).toBe("claude");
    expect(claude?.install?.verify).toBe("claude --version >/dev/null 2>&1");
    expect(claude?.sessionDefaults).toEqual({
      defaultTransport: "tmux",
      fallbackTransports: ["claude_stream_json", "local_socket"],
    });
  });

  test("readiness reports installed when binary exists but auth is still missing", () => {
    const codex = createBuiltInHarnessCatalog().find((entry) => entry.name === "codex");
    expect(codex).toBeTruthy();

    const report = evaluateHarnessReadiness(codex!, {
      env: {},
      whichBinary: () => "/usr/local/bin/codex",
      requirementExists: () => false,
    });

    expect(report.state).toBe("installed");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(false);
    expect(report.missing).toEqual(["one of: OPENAI_API_KEY, ~/.codex/auth.json"]);
  });

  test("readiness reports ready when binary and any auth source are present", () => {
    const claude = createBuiltInHarnessCatalog().find((entry) => entry.name === "claude");
    expect(claude).toBeTruthy();

    const report = evaluateHarnessReadiness(claude!, {
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
      whichBinary: () => "/usr/local/bin/claude",
      requirementExists: () => false,
    });

    expect(report.state).toBe("ready");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(true);
    expect(report.ready).toBe(true);
  });

  test("local-only readiness never runs a command, and a skipped healthcheck is not a pass", () => {
    // Cursor's readiness is only `cursor-agent status` (it asks Cursor); there
    // is no local credential signal, so local-only can't call it signed in.
    const cursor = createBuiltInHarnessCatalog().find((entry) => entry.name === "cursor");
    expect(cursor?.readiness?.healthcheckCommand).toBeTruthy();
    expect(cursor?.readiness?.allOf ?? []).toEqual([]);
    expect(cursor?.readiness?.anyOf ?? []).toEqual([]);
    const ran: string[] = [];
    const binaryOnly = {
      env: {},
      whichBinary: () => "/usr/local/bin/cursor-agent",
      requirementExists: () => false,
      runCommand: (command: string) => {
        ran.push(command);
        return true;
      },
    };

    const local = evaluateHarnessReadiness(cursor!, { ...binaryOnly, localOnly: true });
    expect(ran).toEqual([]);
    expect(local.installed).toBe(true);
    expect(local.ready).toBe(false);
    expect(local.state).toBe("configured");
    expect(local.detail).toContain("Sign-in isn't checked here");

    // The full check is still the authority: it verifies, then asks `cursor-agent status`.
    const full = evaluateHarnessReadiness(cursor!, binaryOnly);
    expect(ran).toEqual(["cursor-agent --version >/dev/null 2>&1", "cursor-agent status >/dev/null 2>&1"]);
    expect(full.ready).toBe(true);
  });

  test("local-only readiness still reports ready on real local evidence", () => {
    const claude = createBuiltInHarnessCatalog().find((entry) => entry.name === "claude");
    const report = evaluateHarnessReadiness(claude!, {
      env: { ANTHROPIC_API_KEY: "test-key" },
      whichBinary: () => "/usr/local/bin/claude",
      requirementExists: () => false,
      runCommand: () => {
        throw new Error("local-only readiness ran a command");
      },
      localOnly: true,
    });
    expect(report.ready).toBe(true);
    expect(report.state).toBe("ready");
  });

  test("local presence requires an executable file, without executing it", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-harness-presence-"));
    try {
      const binary = "scout-readiness-fixture";
      const path = join(home, binary);
      const sentinel = join(home, "must-not-run");
      const entry = { ...createBuiltInHarnessCatalog()[0]!, install: { binary } };
      const options = { localOnly: true, env: { HOME: home, PATH: home, ANTHROPIC_API_KEY: "test" } };
      mkdirSync(path);
      expect(evaluateHarnessReadiness(entry, options).installed).toBe(false);
      rmSync(path, { recursive: true });
      writeFileSync(path, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o600 });
      expect(evaluateHarnessReadiness(entry, options).installed).toBe(false);
      chmodSync(path, 0o700);
      const report = evaluateHarnessReadiness(entry, options);
      expect(report).toMatchObject({ installed: true, ready: true, binaryPath: path, binaryVersion: null });
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Codex fallback and auth markers alone are not installed evidence", () => {
    const codex = findHarnessEntry("codex")!;
    const inspected: string[] = [];
    const report = evaluateHarnessReadiness(codex, {
      localOnly: true, env: { HOME: "/not-a-real-home", PATH: "", OPENAI_API_KEY: "test" },
      executableExists: (path) => { inspected.push(path); return false; },
      requirementExists: () => true,
    });
    expect(inspected).not.toContain("codex");
    expect(report).toMatchObject({ state: "missing", installed: false, ready: false, binaryPath: null });
  });

  test("local Codex presence honors a real explicit binary without version selection", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-codex-presence-"));
    try {
      const binary = join(home, "codex-explicit");
      writeFileSync(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const report = evaluateHarnessReadiness(findHarnessEntry("codex")!, {
        localOnly: true, env: { HOME: home, PATH: "", OPENSCOUT_CODEX_BIN: binary, OPENAI_API_KEY: "test" },
      });
      expect(report).toMatchObject({ installed: true, ready: true, binaryPath: binary,
        binarySource: "env:OPENSCOUT_CODEX_BIN", binaryVersion: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("macOS system path fragments preserve custom GUI install prefixes without a login shell", () => {
    const home = mkdtempSync(join(tmpdir(), "scout-system-path-"));
    try {
      const prefix = join(home, "custom-npm-prefix", "bin");
      mkdirSync(prefix, { recursive: true });
      for (const binary of ["codex", "claude"]) writeFileSync(join(prefix, binary), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const options = { localOnly: true, platform: "darwin" as const, env: { HOME: home, PATH: "", OPENAI_API_KEY: "test" },
        systemPathDirectories: () => [prefix], executableExists: (path: string) => path.startsWith(`${prefix}/`) && existsSync(path),
        requirementExists: () => true,
      };
      // The filesystem check is separately tested; isolate global installations here.
      expect(evaluateHarnessReadiness(findHarnessEntry("claude")!, options).binaryPath).toBe(join(prefix, "claude"));
      expect(evaluateHarnessReadiness(findHarnessEntry("codex")!, options).binaryPath).toBe(join(prefix, "codex"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("local Codex presence includes Windows executable extensions without starting where", () => {
    const report = evaluateHarnessReadiness(findHarnessEntry("codex")!, {
      localOnly: true, platform: "win32", env: { HOME: "/fixture-home", PATH: "/fixture-bin", PATHEXT: ".EXE;.CMD", OPENAI_API_KEY: "test" },
      executableExists: (path) => path === "/fixture-bin/codex.EXE", requirementExists: () => false,
    });
    expect(report).toMatchObject({ installed: true, ready: true, binaryPath: "/fixture-bin/codex.EXE", binaryVersion: null });
  });

  test("readiness reports pi ready when binary and auth file are present", () => {
    const pi = createBuiltInHarnessCatalog().find((entry) => entry.name === "pi");
    expect(pi).toBeTruthy();

    const report = evaluateHarnessReadiness(pi!, {
      env: {},
      whichBinary: () => "/usr/local/bin/pi",
      requirementExists: (requirement) => requirement.path === "~/.pi/agent/auth.json",
    });

    expect(report.state).toBe("ready");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(true);
    expect(report.ready).toBe(true);
  });

  test("readiness reports pi ready with Scout xAI credentials", () => {
    const pi = createBuiltInHarnessCatalog().find((entry) => entry.name === "pi");
    expect(pi).toBeTruthy();

    const report = evaluateHarnessReadiness(pi!, {
      env: {
        SCOUT_XAI_API_KEY: "test-key",
      },
      whichBinary: () => "/usr/local/bin/pi",
      requirementExists: () => false,
    });

    expect(report.state).toBe("ready");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(true);
    expect(report.ready).toBe(true);
  });

  test("readiness reports Grok ACP ready with Scout xAI credentials", () => {
    const grokAcp = createBuiltInHarnessCatalog().find((entry) => entry.name === "grok-acp");
    expect(grokAcp).toBeTruthy();

    const report = evaluateHarnessReadiness(grokAcp!, {
      env: {
        SCOUT_XAI_API_KEY: "test-key",
      },
      whichBinary: () => "/usr/local/bin/grok",
      requirementExists: () => false,
    });

    expect(report.state).toBe("ready");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(true);
    expect(report.ready).toBe(true);
  });

  test("readiness reports Kimi Code ready with cached login credentials", () => {
    const kimi = createBuiltInHarnessCatalog().find((entry) => entry.name === "kimi");
    expect(kimi).toBeTruthy();

    const report = evaluateHarnessReadiness(kimi!, {
      env: {},
      whichBinary: () => "/Users/me/.local/bin/kimi",
      requirementExists: (requirement) => requirement.path === "~/.kimi-code/credentials",
    });

    expect(report.state).toBe("ready");
    expect(report.installed).toBe(true);
    expect(report.configured).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.loginCommand).toBe("kimi login");
  });

  test("builds current shell-safe resume commands", () => {
    const entries = createBuiltInHarnessCatalog();
    const claude = entries.find((entry) => entry.name === "claude");
    const codex = entries.find((entry) => entry.name === "codex");
    const pi = entries.find((entry) => entry.name === "pi");

    expect(claude).toBeTruthy();
    expect(codex).toBeTruthy();
    expect(pi).toBeTruthy();
    expect(buildHarnessResumeCommand(claude!, "claude-session", "/Users/me/dev/app")).toBe(
      "claude --resume claude-session",
    );
    expect(buildHarnessResumeCommand(codex!, "codex-session", "/Users/me/dev/app")).toBe(
      "codex resume -C /Users/me/dev/app codex-session",
    );
    expect(buildHarnessResumeCommand(codex!, "codex-session", "/Users/me/dev/my app")).toBe(
      "codex resume -C '/Users/me/dev/my app' codex-session",
    );
    expect(buildHarnessResumeCommand(codex!, "codex-session", "~/dev/amplink")).toContain(
      `${homedir()}/dev/amplink`,
    );
    expect(buildHarnessResumeCommand(codex!, "codex-session", "~/dev/amplink")).not.toContain(
      "'~/dev/amplink'",
    );
    expect(buildHarnessResumeCommand(pi!, "pi-session", "/Users/me/dev/app")).toBe(
      "pi --resume pi-session",
    );
  });

  test("snapshot applies local override file and marks override source", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "openscout-harness-catalog-"));
    const overridePath = join(tempDirectory, "harness-catalog.json");

    try {
      await writeHarnessCatalogOverrides({
        codex: {
          support: {
            browser: true,
          },
        },
      }, overridePath);

      const snapshot = await loadHarnessCatalogSnapshot({
        overridePath,
        env: {},
        whichBinary: () => null,
        requirementExists: () => false,
      });

      const codex = snapshot.entries.find((entry) => entry.name === "codex");
      expect(codex?.source).toBe("local");
      expect(codex?.support.browser).toBe(true);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("readiness derived from the harness auth model", () => {
  const noFiles = () => false;
  const entry = (name: string) => {
    const found = createBuiltInHarnessCatalog().find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing catalog entry: ${name}`);
    return found;
  };
  // `configured` is `installed && no missing requirements`, and `installed`
  // resolves the harness binary on PATH — so on a machine without the CLI
  // every credential assertion collapses to false and passes vacuously.
  // Dropping `install` makes `installed` true, isolating the credential logic
  // these tests are actually about.
  const entryWithoutBinary = (name: string) => ({ ...entry(name), install: undefined });

  test("a setup-token OAuth credential counts as authenticated", () => {
    // The regression this derivation exists for: Claude Code reads
    // CLAUDE_CODE_OAUTH_TOKEN, but the hand-written block listed only
    // ANTHROPIC_API_KEY, so a machine authenticated via `claude setup-token`
    // reported as not authenticated.
    const report = evaluateHarnessReadiness(entryWithoutBinary("claude"), {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fake-token-value-for-tests" },
      requirementExists: noFiles,
    });
    expect(report.configured).toBe(true);
  });

  test("a refresh token alone does not count as authenticated", () => {
    // It proves a prior login happened but cannot authenticate a request.
    const report = evaluateHarnessReadiness(entryWithoutBinary("claude"), {
      env: { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "fake-token-value-for-tests" },
      requirementExists: noFiles,
    });
    expect(report.configured).toBe(false);
  });

  test("no credential at all is still unconfigured", () => {
    const report = evaluateHarnessReadiness(entryWithoutBinary("claude"), {
      env: {},
      requirementExists: noFiles,
    });
    expect(report.configured).toBe(false);
  });

  test("keeps OpenCode's auth.json ahead of its env key", () => {
    // Order is the contract: OpenCode reads auth.json first, so a seeded
    // image would ignore an injected OPENCODE_API_KEY.
    const requirements = entry("opencode").readiness?.anyOf ?? [];
    const keys = requirements.map((requirement) =>
      requirement.kind === "file" ? requirement.path : requirement.key);
    expect(keys[0]).toBe("~/.local/share/opencode/auth.json");
    expect(keys.indexOf("OPENCODE_API_KEY")).toBeGreaterThan(0);
  });

  test("grok and grok-acp resolve the same xAI credentials", () => {
    const keysFor = (name: string) => (entry(name).readiness?.anyOf ?? [])
      .filter((requirement) => requirement.kind === "env")
      .map((requirement) => (requirement.kind === "env" ? requirement.key : ""))
      .sort();
    expect(keysFor("grok")).toEqual(keysFor("grok-acp"));
  });
});
