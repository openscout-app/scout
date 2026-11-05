import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  DEFAULT_OPENSCOUT_APP_PATH,
  findAppDmgAsset,
  loadInstallCandidate,
  OPENSCOUT_APP_BUNDLE_ID,
  OPENSCOUT_APP_NAME,
  OPENSCOUT_RELEASE_OWNER,
  OPENSCOUT_RELEASE_REPOSITORY,
  OPENSCOUT_SIGNING_TEAM_ID,
  parseGithubAssetDigest,
  parseInstallArgs,
  processIdsForInstalledApp,
  processIdsForMenuOutsideApp,
  renderInstallCommandHelp,
  runInstallCommand,
  verifyDownloadedAsset,
  verifyDownloadedDmg,
  verifyStagedOpenScoutApp,
  type GithubRelease,
  type GithubReleaseAsset,
  type ScoutInstallCommandResult,
  type ScoutInstallDependencies,
  type ScoutInstallResult,
} from "./install.ts";

const testDirectories = new Set<string>();

afterEach(() => {
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scout-install-test-"));
  testDirectories.add(root);
  return root;
}

function sha256(buffer: Uint8Array): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function releaseAsset(
  name: string,
  extra: Partial<GithubReleaseAsset> = {},
): GithubReleaseAsset {
  return {
    name,
    browser_download_url: `https://example.test/${name}`,
    size: extra.size ?? 1,
    ...extra,
  };
}

function ok(stdout = "", stderr = ""): ScoutInstallCommandResult {
  return { status: 0, stdout, stderr };
}

function failed(stderr: string, status = 1): ScoutInstallCommandResult {
  return { status, stdout: "", stderr };
}

function captureContext(mode: "json" | "plain" = "json") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context = createScoutCommandContext({
    outputMode: mode,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { context, stdout, stderr };
}

function parseJsonOutput(stdout: string[]): ScoutInstallResult {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]!) as ScoutInstallResult;
}

function codesignDetails(overrides: { teamId?: string; identifier?: string; authority?: string } = {}) {
  return [
    `Identifier=${overrides.identifier ?? OPENSCOUT_APP_BUNDLE_ID}`,
    `TeamIdentifier=${overrides.teamId ?? OPENSCOUT_SIGNING_TEAM_ID}`,
    overrides.authority ?? `Authority=Developer ID Application: OpenScout (${OPENSCOUT_SIGNING_TEAM_ID})`,
  ].join("\n");
}

type World = {
  root: string;
  workDir: string;
  appPath: string;
  /** `<Applications>/OpenScout.app` — the bundle shipped before the rename. */
  legacyAppPath: string;
  calls: Array<{ command: string; args: string[] }>;
  body: Buffer;
  release: GithubRelease;
};

function createWorld(input: {
  installed?: boolean;
  legacyInstalled?: boolean;
  running?: boolean;
  digest?: string | null;
  assets?: GithubReleaseAsset[];
} = {}): World {
  const root = tempRoot();
  const workDir = join(root, "work");
  const applications = join(root, "Applications");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(applications, { recursive: true });
  const appPath = join(applications, OPENSCOUT_APP_NAME);
  if (input.installed) {
    mkdirSync(join(appPath, "Contents"), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Info.plist"), "old");
  }
  const legacyAppPath = join(applications, "OpenScout.app");
  if (input.legacyInstalled) {
    mkdirSync(join(legacyAppPath, "Contents"), { recursive: true });
    writeFileSync(join(legacyAppPath, "Contents", "Info.plist"), "pre-rename");
  }

  const body = Buffer.from("signed-openscout-dmg");
  const digest = input.digest === undefined ? sha256(body) : input.digest;
  const assets = input.assets ?? [
    releaseAsset("OpenScoutMenu-0.2.70.dmg", { size: body.length, digest }),
    releaseAsset("OpenScout-0.2.70.dmg", { size: body.length, digest }),
    releaseAsset("OpenScout.dmg", { size: body.length, digest }),
  ];

  return {
    root,
    workDir,
    appPath,
    legacyAppPath,
    calls: [],
    body,
    release: {
      tag_name: "v0.2.70",
      name: "OpenScout v0.2.70",
      assets,
    },
  };
}

function createHarness(
  world: World,
  input: {
    running?: boolean;
    fetchRelease?: "ok" | "fail";
    downloadBody?: Buffer;
    attachAppName?: string;
    legacyRunning?: boolean;
    legacyKillFails?: boolean;
    mountedPlistBody?: string;
    codesignVerify?: ScoutInstallCommandResult;
    codesignDetails?: ScoutInstallCommandResult;
    dmgCodesign?: ScoutInstallCommandResult;
    dmgSpctl?: ScoutInstallCommandResult;
    spctl?: ScoutInstallCommandResult;
    failNthDeepVerify?: number;
    invalidBundlePaths?: string[];
    psFailuresAt?: number[];
    termStops?: boolean;
    staleMenuRunning?: boolean;
    lock?: ScoutInstallCommandResult;
    open?: ScoutInstallCommandResult;
    ditto?: (source: string, destination: string, count: number) => ScoutInstallCommandResult;
    renameSync?: ScoutInstallDependencies["renameSync"];
    rmSync?: ScoutInstallDependencies["rmSync"];
  } = {},
): ScoutInstallDependencies {
  let running = input.running ?? false;
  let staleMenuRunning = input.staleMenuRunning ?? false;
  let legacyRunning = input.legacyRunning ?? false;
  let dittoCount = 0;
  let deepVerifyCount = 0;
  let psCount = 0;
  const downloadBody = input.downloadBody ?? world.body;
  const termStops = input.termStops ?? true;

  return {
    platform: "darwin",
    appPath: world.appPath,
    tmpdir: () => world.root,
    mkdtempSync: () => world.workDir,
    sleep: () => undefined,
    fetch: async (url) => {
      const href = String(url);
      if (href.includes("/releases")) {
        if (input.fetchRelease === "fail") {
          return new Response("missing", { status: 404 });
        }
        return new Response(JSON.stringify(world.release), { status: 200 });
      }
      if (href.includes(".dmg")) {
        return new Response(Uint8Array.from(downloadBody), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
    renameSync: input.renameSync,
    rmSync: input.rmSync,
    run: (command, args) => {
      world.calls.push({ command, args: [...args] });
      if (command === "gh" && args[0] === "api") {
        return ok(JSON.stringify(world.release));
      }
      if (command === "/usr/bin/shlock") {
        if (input.lock) return input.lock;
        writeFileSync(args[1]!, `${process.pid}\n`);
        return ok();
      }
      if (command === "hdiutil" && args[0] === "attach") {
        expect(args).not.toContain("-noverify");
        const mountPoint = args[args.indexOf("-mountpoint") + 1]!;
        const appName = input.attachAppName ?? OPENSCOUT_APP_NAME;
        mkdirSync(join(mountPoint, appName, "Contents"), { recursive: true });
        writeFileSync(
          join(mountPoint, appName, "Contents", "Info.plist"),
          input.mountedPlistBody ?? "new",
        );
        return ok();
      }
      if (command === "hdiutil" && args[0] === "detach") return ok();
      if (command === "ditto") {
        dittoCount += 1;
        if (input.ditto) return input.ditto(args[0]!, args[1]!, dittoCount);
        cpSync(args[0]!, args[1]!, { recursive: true });
        return ok();
      }
      if (command === "codesign" && args[0] === "--verify") {
        if (args.includes("--deep")) {
          deepVerifyCount += 1;
          if (input.failNthDeepVerify === deepVerifyCount) {
            return failed("signature invalid");
          }
          if (input.invalidBundlePaths?.includes(args.at(-1)!)) {
            return failed("signature invalid");
          }
          return input.codesignVerify ?? ok();
        }
        return input.dmgCodesign ?? ok();
      }
      if (command === "codesign" && args[0] === "-dvv") {
        return input.codesignDetails ?? { status: 0, stdout: "", stderr: codesignDetails() };
      }
      if (command === "plutil" && args[0] === "-extract") {
        const key = args[1];
        const plistPath = args[5]!;
        if (!existsSync(plistPath)) return failed("missing plist");
        if (key === "CFBundleIdentifier") return ok(`${OPENSCOUT_APP_BUNDLE_ID}\n`);
        if (key === "CFBundleShortVersionString") {
          const body = readFileSync(plistPath, "utf8");
          if (body.includes("old")) return ok("0.2.69\n");
          if (body.includes("wrong-version")) return ok("0.2.71\n");
          return ok("0.2.70\n");
        }
        return failed(`unknown key ${key}`);
      }
      if (command === "spctl") {
        if (args.includes("open")) return input.dmgSpctl ?? ok("", "accepted");
        return input.spctl ?? ok("", "accepted");
      }
      if (command === "ps") {
        psCount += 1;
        if (input.psFailuresAt?.includes(psCount)) return failed("ps unavailable");
        const lines: string[] = [];
        if (running) {
          lines.push(`  123 ${world.appPath}/Contents/MacOS/Scout\n`);
        }
        if (staleMenuRunning) {
          lines.push(
            "  456 /Users/dev/openscout/apps/macos/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu\n",
          );
        }
        if (legacyRunning) {
          lines.push(`  789 ${world.legacyAppPath}/Contents/MacOS/Scout\n`);
        }
        if (lines.length === 0) return ok("");
        return ok(lines.join(""));
      }
      if (command === "kill") {
        if (input.legacyKillFails && args.includes("789")) return failed("operation not permitted");
        if (args[0] === "-9" || termStops) {
          if (args[0] === "-9") {
            if (args[1] === "123") running = false;
            if (args[1] === "456") staleMenuRunning = false;
            if (args[1] === "789") legacyRunning = false;
          } else {
            if (args[0] === "123") running = false;
            if (args[0] === "456") staleMenuRunning = false;
            if (args[0] === "789") legacyRunning = false;
          }
        }
        return ok();
      }
      if (command === "open") return input.open ?? ok();
      return failed(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

describe("install command helpers", () => {
  test("documents the hardened install flow without sudo or quarantine clearing", () => {
    const help = renderInstallCommandHelp();
    expect(help).toContain("scout install");
    expect(help).toContain("--check");
    expect(help).toContain("signed + notarized");
    expect(help).toContain("sha256 digest");
    expect(help).toContain("Gatekeeper-assess the DMG");
    expect(help).toContain("Quarantine attributes are not cleared");
    expect(help).toContain("bun add -g @openscout/scout");
    expect(help).not.toContain("sudo");
    expect(help).not.toContain("clears the Gatekeeper quarantine");
  });

  test("pins verified release identity and does not take a Team ID override", () => {
    expect(`${OPENSCOUT_RELEASE_OWNER}/${OPENSCOUT_RELEASE_REPOSITORY}`).toBe(
      "openscout-app/scout",
    );
    expect(DEFAULT_OPENSCOUT_APP_PATH).toBe("/Applications/Scout.app");
    expect(OPENSCOUT_APP_BUNDLE_ID).toBe("app.openscout.scout");
    expect(OPENSCOUT_SIGNING_TEAM_ID).toBe("2U83JFPW66");
    expect(() => parseInstallArgs(["--team-id", "ABCD123456"])).toThrow(/unknown option/);
    expect(() => parseInstallArgs(["--team-id=ABCD123456"])).toThrow(/unknown option/);
    expect(() => parseInstallArgs(["--bundle-id", "com.example.other"])).toThrow(/unknown option/);
  });

  test("defaults to a latest install that relaunches", () => {
    expect(parseInstallArgs([])).toEqual({
      check: false,
      force: false,
      version: null,
      restart: true,
    });
  });

  test("parses flags", () => {
    expect(parseInstallArgs(["--check"]).check).toBe(true);
    expect(parseInstallArgs(["check"]).check).toBe(true);
    expect(parseInstallArgs(["--force"]).force).toBe(true);
    expect(parseInstallArgs(["-f"]).force).toBe(true);
    expect(parseInstallArgs(["--no-restart"]).restart).toBe(false);
    expect(parseInstallArgs(["--version", "v0.2.70"]).version).toBe("v0.2.70");
    expect(parseInstallArgs(["--version=v0.2.70"]).version).toBe("v0.2.70");
    expect(parseInstallArgs(["--tag=v0.2.70"]).version).toBe("v0.2.70");
  });

  test("rejects a bare --version and unknown flags", () => {
    expect(() => parseInstallArgs(["--version"])).toThrow();
    expect(() => parseInstallArgs(["--version", "--force"])).toThrow();
    expect(() => parseInstallArgs(["--version="])).toThrow();
    expect(() => parseInstallArgs(["--tag="])).toThrow();
    expect(() => parseInstallArgs(["--nope"])).toThrow();
  });
});

describe("findAppDmgAsset", () => {
  test("prefers the versioned product DMG over the menu-only DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout v0.2.70",
      assets: [
        releaseAsset("OpenScoutMenu-0.2.70.dmg"),
        releaseAsset("OpenScout-0.2.70.dmg"),
        releaseAsset("OpenScout.dmg"),
      ],
    };
    expect(findAppDmgAsset(release).name).toBe("OpenScout-0.2.70.dmg");
  });

  test("falls back to the latest alias when no versioned asset exists", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout",
      assets: [releaseAsset("OpenScoutMenu-0.2.70.dmg"), releaseAsset("OpenScout.dmg")],
    };
    expect(findAppDmgAsset(release).name).toBe("OpenScout.dmg");
  });

  test("never selects the standalone menu DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout",
      assets: [releaseAsset("OpenScoutMenu-0.2.70.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow();
  });

  test("never accepts an arbitrary leftover DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout",
      assets: [
        releaseAsset("OpenScoutMenu-0.2.70.dmg"),
        releaseAsset("RandomApp.dmg"),
        releaseAsset("OpenScout-beta.dmg"),
      ],
    };
    expect(() => findAppDmgAsset(release)).toThrow(/no product DMG/);
  });

  test("does not regex-pick a different versioned OpenScout DMG", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout v0.2.70",
      assets: [
        releaseAsset("OpenScout-0.2.71.dmg"),
        releaseAsset("OpenScout-0.2.70-universal.dmg"),
        releaseAsset("OpenScoutMenu-0.2.70.dmg"),
      ],
    };
    expect(() => findAppDmgAsset(release)).toThrow(/no product DMG/);
  });

  test("requires exact publication casing", () => {
    const release = {
      tag_name: "v0.2.70",
      name: "OpenScout v0.2.70",
      assets: [releaseAsset("openscout-0.2.70.dmg"), releaseAsset("openscout.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow(/no product DMG/);
  });

  test("rejects a non-release tag instead of deriving an asset path", () => {
    const release = {
      tag_name: "../latest",
      name: "invalid",
      assets: [releaseAsset("OpenScout.dmg")],
    };
    expect(() => findAppDmgAsset(release)).toThrow(/unsupported Scout release tag/);
  });
});

describe("download asset verification", () => {
  const body = Buffer.from("signed-openscout-dmg");

  test("parses the GitHub sha256 digest form", () => {
    const digest = sha256(body);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseGithubAssetDigest(digest)).toEqual({
      algorithm: "sha256",
      hex: createHash("sha256").update(body).digest("hex"),
    });
  });

  test("rejects malformed or non-sha256 digests", () => {
    expect(() => parseGithubAssetDigest("sha256")).toThrow(ScoutCliError);
    expect(() => parseGithubAssetDigest("sha256:zzzz")).toThrow(ScoutCliError);
    expect(() => parseGithubAssetDigest(":abc")).toThrow(ScoutCliError);
    expect(() => parseGithubAssetDigest(`sha1:${"ab".repeat(20)}`)).toThrow(ScoutCliError);
    expect(() => parseGithubAssetDigest(`sha256:${"ab".repeat(31)}`)).toThrow(ScoutCliError);
  });

  test("requires the exact published byte size", () => {
    expect(() => verifyDownloadedAsset(body, { name: "OpenScout.dmg", size: body.length - 1 })).toThrow(
      /size mismatch/,
    );
    expect(() => verifyDownloadedAsset(body, { name: "OpenScout.dmg", size: Number.NaN })).toThrow(
      /exact byte size/,
    );
  });

  test("verifies the GitHub digest when present and skips it when absent", () => {
    expect(() => verifyDownloadedAsset(body, {
      name: "OpenScout.dmg",
      size: body.length,
      digest: sha256(body),
    })).not.toThrow();

    expect(() => verifyDownloadedAsset(body, {
      name: "OpenScout.dmg",
      size: body.length,
      digest: sha256(Buffer.from("other")),
    })).toThrow(/digest mismatch/);

    expect(() => verifyDownloadedAsset(body, {
      name: "OpenScout.dmg",
      size: body.length,
      digest: null,
    })).not.toThrow();
  });

  test("rejects an empty download even when the published size is zero", () => {
    expect(() => verifyDownloadedAsset(Buffer.alloc(0), { name: "OpenScout.dmg", size: 0 })).toThrow(
      /empty response body/,
    );
  });
});

describe("verifyStagedOpenScoutApp", () => {
  test("requires bundle id, Team ID, deep strict codesign, and Gatekeeper", () => {
    const root = tempRoot();
    const bundlePath = join(root, OPENSCOUT_APP_NAME);
    mkdirSync(join(bundlePath, "Contents"), { recursive: true });
    writeFileSync(join(bundlePath, "Contents", "Info.plist"), "plist");
    const calls: Array<{ command: string; args: string[] }> = [];

    verifyStagedOpenScoutApp(bundlePath, {
      run: (command, args) => {
        calls.push({ command, args: [...args] });
        if (command === "plutil") {
          return ok(args[1] === "CFBundleIdentifier" ? `${OPENSCOUT_APP_BUNDLE_ID}\n` : "0.2.70\n");
        }
        if (command === "codesign" && args[0] === "--verify") {
          expect(args).toEqual(["--verify", "--deep", "--strict", bundlePath]);
          return ok();
        }
        if (command === "codesign" && args[0] === "-dvv") {
          return { status: 0, stdout: "", stderr: codesignDetails() };
        }
        if (command === "spctl") {
          expect(args).toEqual(["--assess", "--type", "execute", "-vv", bundlePath]);
          return ok();
        }
        return failed(`unexpected ${command}`);
      },
    });

    expect(calls.map((call) => call.command)).toEqual([
      "plutil",
      "plutil",
      "codesign",
      "codesign",
      "spctl",
    ]);
    expect(calls[0]?.args).toEqual([
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      join(bundlePath, "Contents", "Info.plist"),
    ]);
  });

  test("rejects a mismatched Team ID before replacement", () => {
    const root = tempRoot();
    const bundlePath = join(root, OPENSCOUT_APP_NAME);
    mkdirSync(join(bundlePath, "Contents"), { recursive: true });
    writeFileSync(join(bundlePath, "Contents", "Info.plist"), "plist");

    expect(() => verifyStagedOpenScoutApp(bundlePath, {
      run: (command, args) => {
        if (command === "plutil") {
          return ok(args[1] === "CFBundleIdentifier" ? `${OPENSCOUT_APP_BUNDLE_ID}\n` : "0.2.70\n");
        }
        if (command === "codesign" && args[0] === "--verify") return ok();
        if (command === "codesign" && args[0] === "-dvv") {
          return { status: 0, stdout: "", stderr: codesignDetails({ teamId: "NOTATEAMID" }) };
        }
        return failed(`unexpected ${command}`);
      },
    })).toThrow(/Team ID/);
  });

  test("does not invoke stapler", () => {
    const root = tempRoot();
    const bundlePath = join(root, OPENSCOUT_APP_NAME);
    mkdirSync(join(bundlePath, "Contents"), { recursive: true });
    writeFileSync(join(bundlePath, "Contents", "Info.plist"), "plist");
    const commands: string[] = [];

    verifyStagedOpenScoutApp(bundlePath, {
      run: (command, args) => {
        commands.push(command);
        if (command === "plutil") {
          return ok(args[1] === "CFBundleIdentifier" ? `${OPENSCOUT_APP_BUNDLE_ID}\n` : "0.2.70\n");
        }
        if (command === "codesign" && args[0] === "--verify") return ok();
        if (command === "codesign" && args[0] === "-dvv") {
          return { status: 0, stdout: "", stderr: codesignDetails() };
        }
        if (command === "spctl") return ok();
        return failed(`unexpected ${command}`);
      },
    });

    expect(commands).not.toContain("xcrun");
  });

  test("fails closed when codesign details exits nonzero even if it prints a Team ID", () => {
    const root = tempRoot();
    const bundlePath = join(root, OPENSCOUT_APP_NAME);
    mkdirSync(join(bundlePath, "Contents"), { recursive: true });
    writeFileSync(join(bundlePath, "Contents", "Info.plist"), "plist");

    expect(() => verifyStagedOpenScoutApp(bundlePath, {
      run: (command, args) => {
        if (command === "plutil") {
          return ok(args[1] === "CFBundleIdentifier" ? `${OPENSCOUT_APP_BUNDLE_ID}\n` : "0.2.70\n");
        }
        if (command === "codesign" && args[0] === "--verify") return ok();
        if (command === "codesign" && args[0] === "-dvv") {
          return failed(codesignDetails());
        }
        return failed(`unexpected ${command}`);
      },
    })).toThrow(/could not read codesign details/);
  });

  test("binds the verified bundle version to the release version", () => {
    const root = tempRoot();
    const bundlePath = join(root, OPENSCOUT_APP_NAME);
    mkdirSync(join(bundlePath, "Contents"), { recursive: true });
    writeFileSync(join(bundlePath, "Contents", "Info.plist"), "plist");

    expect(() => verifyStagedOpenScoutApp(bundlePath, {
      run: (command, args) => {
        if (command === "plutil") {
          return ok(args[1] === "CFBundleIdentifier" ? `${OPENSCOUT_APP_BUNDLE_ID}\n` : "0.2.71\n");
        }
        return failed(`unexpected ${command}`);
      },
    }, "0.2.70")).toThrow(/version is 0\.2\.71; expected release 0\.2\.70/);
  });
});

describe("verifyDownloadedDmg", () => {
  test("requires built-in codesign and Gatekeeper on the DMG", () => {
    const dmgPath = "/tmp/OpenScout-0.2.70.dmg";
    const calls: Array<{ command: string; args: string[] }> = [];

    verifyDownloadedDmg(dmgPath, {
      run: (command, args) => {
        calls.push({ command, args: [...args] });
        return ok();
      },
    });

    expect(calls).toEqual([
      { command: "codesign", args: ["--verify", "--strict", dmgPath] },
      {
        command: "spctl",
        args: ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmgPath],
      },
    ]);
  });

  test("fails closed when Gatekeeper rejects the DMG", () => {
    expect(() => verifyDownloadedDmg("/tmp/OpenScout.dmg", {
      run: (command, args) => {
        if (command === "codesign") return ok();
        if (command === "spctl") return failed("rejected");
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
    })).toThrow(/Gatekeeper rejected/);
  });
});

describe("processIdsForInstalledApp", () => {
  test("matches only executables inside the installed app path", () => {
    const appPath = "/Applications/OpenScout.app";
    const output = [
      "  111 /Applications/OpenScout.app/Contents/MacOS/Scout",
      "  222 /Applications/OpenScout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu",
      "  333 /Users/dev/openscout/.build/release/Scout",
      "  444 /opt/homebrew/bin/Scout",
    ].join("\n");
    expect(processIdsForInstalledApp(output, appPath)).toEqual([111, 222]);
  });
});


describe("processIdsForMenuOutsideApp", () => {
  test("matches only ScoutMenu helpers outside the installed app path", () => {
    const appPath = "/Applications/OpenScout.app";
    const output = [
      "  111 /Applications/OpenScout.app/Contents/MacOS/Scout",
      "  222 /Applications/OpenScout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu",
      "  333 /Users/dev/openscout/apps/macos/dist/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu",
      "  444 /opt/homebrew/bin/Scout",
    ].join("\n");
    expect(processIdsForMenuOutsideApp(output, appPath)).toEqual([333]);
  });
});
describe("runInstallCommand", () => {
  test("a local candidate reuses verification and replacement without a network release", async () => {
    const world = createWorld({ installed: true });
    const dmg = join(world.root, "candidate.dmg");
    const receipt = join(world.root, "receipt.json");
    writeFileSync(dmg, world.body);
    const metadata = {
      schema: "openscout-native-candidate-v1", version: "0.2.70",
      source: { repository: "arach/openscout", commit: "a".repeat(40) },
      verification: { release: true, team: OPENSCOUT_SIGNING_TEAM_ID },
      artifact: { size: world.body.length, sha256: sha256(world.body).slice(7) },
    };
    writeFileSync(receipt, JSON.stringify(metadata));
    const deps = createHarness(world);
    deps.fetch = async () => { throw new Error("Candidate must not contact GitHub"); };
    const result = captureContext();
    await runInstallCommand(result.context, ["--candidate", receipt, "--dmg", dmg], deps);
    expect(parseJsonOutput(result.stdout).installed).toBe("0.2.70");
    expect(world.calls.some(c => c.command === "codesign")).toBe(true);
    expect(world.calls.some(c => c.command === "spctl")).toBe(true);
    // The current repository name is accepted alongside the former one; any other is not.
    writeFileSync(receipt, JSON.stringify({ ...metadata, source: { ...metadata.source, repository: "openscout-app/scout-apps" } }));
    expect(loadInstallCandidate(receipt, dmg).tag_name).toBe("v0.2.70");
    writeFileSync(receipt, JSON.stringify({ ...metadata, source: { ...metadata.source, repository: "someone/else" } }));
    expect(() => loadInstallCandidate(receipt, dmg)).toThrow(/Invalid/);
    writeFileSync(receipt, JSON.stringify(metadata));
    writeFileSync(dmg, "corrupted bytes");
    expect(() => loadInstallCandidate(receipt, dmg)).toThrow(/mismatch/);
    metadata.verification.team = "WRONG";
    writeFileSync(receipt, JSON.stringify(metadata));
    expect(() => loadInstallCandidate(receipt, dmg)).toThrow(/Invalid/);
    expect(() => parseInstallArgs(["--candidate", receipt])).toThrow(/together/);
    expect(() => parseInstallArgs(["--candidate", receipt, "--dmg", dmg, "--version", "v0.2.70"])).toThrow(/either/);
  });
  test("rejects non-macOS hosts", async () => {
    const { context } = captureContext();
    await expect(runInstallCommand(context, [], { platform: "linux" })).rejects.toThrow(
      /only supported on macOS/,
    );
  });

  test("prints help without contacting GitHub", async () => {
    const { context, stdout } = captureContext("plain");
    await runInstallCommand(context, ["--help"], {
      platform: "linux",
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(stdout.join("\n")).toContain("scout install");
  });

  test("reports check JSON for not installed, up to date, and update available", async () => {
    const world = createWorld();
    const deps = createHarness(world);

    const missing = captureContext();
    await runInstallCommand(missing.context, ["--check"], deps);
    expect(parseJsonOutput(missing.stdout)).toEqual({
      action: "check",
      status: "not-installed",
      installed: null,
      target: "0.2.70",
      bundlePath: world.appPath,
      message: "Scout is not installed — run `scout install`.",
    });

    mkdirSync(join(world.appPath, "Contents"), { recursive: true });
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "old");
    const update = captureContext();
    await runInstallCommand(update.context, ["--check"], deps);
    expect(parseJsonOutput(update.stdout).status).toBe("update-available");

    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "new");
    const current = captureContext();
    await runInstallCommand(current.context, ["--check"], deps);
    expect(parseJsonOutput(current.stdout)).toMatchObject({
      action: "check",
      status: "up-to-date",
      installed: "0.2.70",
      target: "0.2.70",
    });
  });

  test("reports repair-needed instead of trusting an invalid current-version bundle", async () => {
    const world = createWorld({ installed: true });
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "new");
    const { context, stdout } = captureContext();
    await runInstallCommand(context, ["--check"], createHarness(world, { failNthDeepVerify: 1 }));
    expect(parseJsonOutput(stdout)).toMatchObject({
      action: "check",
      status: "repair-needed",
      installed: "0.2.70",
      target: "0.2.70",
    });
  });

  test("skips download when the requested version is already installed", async () => {
    const world = createWorld({ installed: true });
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "new");
    const { context, stdout } = captureContext();
    await runInstallCommand(context, [], createHarness(world));
    expect(parseJsonOutput(stdout)).toMatchObject({
      action: "install",
      status: "up-to-date",
      installed: "0.2.70",
      target: "0.2.70",
    });
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
  });

  test("repairs rather than skipping an invalid current-version bundle", async () => {
    const world = createWorld({ installed: true });
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "new");
    const { context, stdout, stderr } = captureContext();
    await runInstallCommand(context, [], createHarness(world, { failNthDeepVerify: 1 }));
    expect(parseJsonOutput(stdout)).toMatchObject({
      action: "install",
      status: "updated",
      installed: "0.2.70",
    });
    expect(parseJsonOutput(stdout).message).toContain("Repaired Scout 0.2.70");
    expect(stderr.join("\n")).toContain("failed verification; repairing");
    expect(world.calls.some((call) => call.command === "hdiutil" && call.args[0] === "attach")).toBe(true);
  });

  test("holds an exclusive destination lock and fails cleanly on contention", async () => {
    const world = createWorld();
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { lock: failed("lock held") }),
    )).rejects.toThrow(/another scout install is already updating/);
    expect(world.calls.some((call) => (
      call.command === "/usr/bin/shlock"
      && call.args[0] === "-f"
      && call.args[1] === `${world.appPath}.openscout-install.lock`
      && call.args[2] === "-p"
    ))).toBe(true);
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
    expect(existsSync(world.appPath)).toBe(false);
  });

  test("installs a verified Scout.app transactionally and preserves JSON output", async () => {
    const world = createWorld();
    const { context, stdout } = captureContext();
    await runInstallCommand(context, [], createHarness(world));

    expect(parseJsonOutput(stdout)).toEqual({
      action: "install",
      status: "installed",
      installed: "0.2.70",
      target: "0.2.70",
      bundlePath: world.appPath,
      message: `Installed Scout 0.2.70 → ${world.appPath}`,
    });
    expect(existsSync(join(world.appPath, "Contents", "Info.plist"))).toBe(true);
    expect(existsSync(`${world.appPath}.openscout-install.lock`)).toBe(false);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("new");
    expect(world.calls.some((call) => call.command === "xattr")).toBe(false);
    expect(world.calls.some((call) => call.args.includes("-noverify"))).toBe(false);
    expect(world.calls.some((call) => call.command === "xcrun")).toBe(false);
    expect(world.calls.some((call) => call.command === "pgrep" || call.command === "pkill")).toBe(false);
    const dmgVerifyIndex = world.calls.findIndex((call) => (
      call.command === "codesign" && call.args[0] === "--verify" && !call.args.includes("--deep")
    ));
    const dmgSpctlIndex = world.calls.findIndex((call) => (
      call.command === "spctl" && call.args.includes("open")
    ));
    const attachIndex = world.calls.findIndex((call) => call.command === "hdiutil" && call.args[0] === "attach");
    expect(dmgVerifyIndex).toBeGreaterThanOrEqual(0);
    expect(dmgSpctlIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThan(dmgSpctlIndex);
    expect(attachIndex).toBeGreaterThan(dmgVerifyIndex);
  });

  test("falls back to gh when the GitHub API fetch fails", async () => {
    const world = createWorld();
    const { context, stdout } = captureContext();
    await runInstallCommand(context, [], createHarness(world, { fetchRelease: "fail" }));
    expect(world.calls.some((call) => call.command === "gh")).toBe(true);
    expect(parseJsonOutput(stdout).status).toBe("installed");
  });

  test("rejects a Gatekeeper-failed DMG before mounting", async () => {
    const world = createWorld();
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { dmgSpctl: failed("DMG rejected") }),
    )).rejects.toThrow(/Gatekeeper rejected/);
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
    expect(existsSync(world.appPath)).toBe(false);
  });

  test("rejects a digest mismatch before mounting", async () => {
    const world = createWorld();
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { downloadBody: Buffer.alloc(world.body.length, 7) }),
    )).rejects.toThrow(/digest mismatch/);
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
    expect(existsSync(world.appPath)).toBe(false);
  });

  test("installs a pre-rename DMG payload under the current bundle name", async () => {
    const world = createWorld();
    const { context } = captureContext();

    // Every release up to 0.2.105 ships `OpenScout.app`; `--version v0.2.103`
    // must still work, and must land as Scout.app like any other install.
    await runInstallCommand(context, [], createHarness(world, { attachAppName: "OpenScout.app" }));

    expect(world.appPath.endsWith("/Scout.app")).toBe(true);
    expect(existsSync(world.appPath)).toBe(true);
    expect(existsSync(world.legacyAppPath)).toBe(false);
  });

  test("retires the pre-rename bundle once the new one is installed", async () => {
    const world = createWorld({ legacyInstalled: true });
    const { context } = captureContext();

    await runInstallCommand(context, [], createHarness(world));

    expect(existsSync(world.appPath)).toBe(true);
    // Both carry app.openscout.scout, so leaving it behind gives
    // LaunchServices two candidates and the operator two menu helpers.
    expect(existsSync(world.legacyAppPath)).toBe(false);
  });

  test("stops and relaunches when the pre-rename bundle was the running copy", async () => {
    const world = createWorld({ legacyInstalled: true });
    const { context } = captureContext();

    // `stopRunningApp` only knows the new path, so without the retirement pass
    // this install would leave the old app running and never relaunch.
    await runInstallCommand(context, [], createHarness(world, { legacyRunning: true }));

    expect(world.calls.some((call) => call.command === "kill" && call.args.includes("789"))).toBe(true);
    expect(existsSync(world.legacyAppPath)).toBe(false);
    expect(world.calls.some((call) => call.command === "open" && call.args[0] === world.appPath)).toBe(true);
  });

  test("retains a legacy app that survives KILL and skips relaunch", async () => {
    const world = createWorld({ legacyInstalled: true });
    const { context, stdout, stderr } = captureContext();
    await runInstallCommand(context, [], createHarness(world, {
      legacyRunning: true, legacyKillFails: true,
    }));
    expect(existsSync(world.appPath)).toBe(true);
    expect(existsSync(world.legacyAppPath)).toBe(true);
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "-9" && call.args[1] === "789")).toBe(true);
    expect(world.calls.some((call) => call.command === "open")).toBe(false);
    expect(stderr.join("\n")).toContain("automatic relaunch skipped");
    expect(parseJsonOutput(stdout).message).toContain("cleanup incomplete");
  });

  test("keeps the pre-rename bundle when the install fails", async () => {
    const world = createWorld({ legacyInstalled: true });
    const { context } = captureContext();

    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { spctl: failed("Gatekeeper rejected") }),
    )).rejects.toThrow();

    // Retirement runs only after the replacement is staged, moved and
    // verified — a failed install must never cost the operator their app.
    expect(existsSync(world.legacyAppPath)).toBe(true);
  });

  test("still enforces exact size when GitHub omits the digest", async () => {
    const world = createWorld({ digest: null });
    world.release.assets = world.release.assets.map((asset) => ({
      ...asset,
      digest: null,
      size: world.body.length + 4,
    }));
    const { context } = captureContext();
    await expect(runInstallCommand(context, [], createHarness(world))).rejects.toThrow(/size mismatch/);
  });

  test("requires a Scout.app or legacy OpenScout.app in the mounted image", async () => {
    const world = createWorld();
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { attachAppName: "Other.app" }),
    )).rejects.toThrow(/no Scout\.app or OpenScout\.app found/);
    expect(existsSync(world.appPath)).toBe(false);
  });

  test("does not replace an installed app when verification fails", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, { codesignVerify: failed("signature invalid") }),
    )).rejects.toThrow(/codesign --verify --deep --strict/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
    expect(world.calls.some((call) => call.command === "osascript")).toBe(false);
  });

  test("rejects a signed bundle whose version does not match the release tag", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, { mountedPlistBody: "wrong-version" }),
    )).rejects.toThrow(/version is 0\.2\.71; expected release 0\.2\.70/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
    expect(world.calls.some((call) => call.command === "ps")).toBe(false);
  });

  test("stops a running app before replacing it and relaunches afterwards", async () => {
    const world = createWorld({ installed: true });
    let destMoved = false;
    const { context, stdout } = captureContext();
    await runInstallCommand(
      context,
      [],
      createHarness(world, {
        running: true,
        renameSync: (from, to) => {
          if (from === world.appPath) {
            expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "123")).toBe(true);
            expect(world.calls.some((call) => call.command === "codesign")).toBe(true);
            destMoved = true;
          }
          renameSync(from, to);
        },
      }),
    );
    expect(destMoved).toBe(true);
    expect(parseJsonOutput(stdout).message).toContain("(relaunched)");
    expect(world.calls.some((call) => call.command === "open" && call.args[0] === world.appPath)).toBe(true);
    expect(world.calls.some((call) => call.command === "osascript")).toBe(false);
    expect(world.calls.some((call) => call.command === "pgrep" || call.command === "pkill")).toBe(false);
    expect(world.calls.some((call) => call.command === "ps")).toBe(true);
    const verifyIndex = world.calls.findIndex((call) => (
      call.command === "codesign" && call.args.includes("--deep")
    ));
    const termIndex = world.calls.findIndex((call) => call.command === "kill");
    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(termIndex).toBeGreaterThan(verifyIndex);
  });

  test("stops stale menu helpers outside the installed app before replacing it", async () => {
    const world = createWorld({ installed: true });
    const { context, stdout } = captureContext();
    await runInstallCommand(
      context,
      [],
      createHarness(world, { staleMenuRunning: true }),
    );
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "456")).toBe(true);
    expect(world.calls.some((call) => call.command === "open")).toBe(false);
    expect(parseJsonOutput(stdout).message).not.toContain("(relaunched)");
  });

  test("stops stale menu helpers alongside a running installed app", async () => {
    const world = createWorld({ installed: true });
    const { context, stdout } = captureContext();
    await runInstallCommand(
      context,
      [],
      createHarness(world, { running: true, staleMenuRunning: true }),
    );
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "123")).toBe(true);
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "456")).toBe(true);
    expect(parseJsonOutput(stdout).message).toContain("(relaunched)");
  });



  test("force-stops remaining processes by installed-app pid, not process name", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await runInstallCommand(
      context,
      ["--no-restart"],
      createHarness(world, { running: true, termStops: false }),
    );
    expect(world.calls.some((call) => call.command === "pkill")).toBe(false);
    expect(world.calls.some((call) => call.command === "pgrep")).toBe(false);
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "123")).toBe(true);
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "-9")).toBe(true);
  });

  test("fails closed when initial process inspection fails", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, { running: true, psFailuresAt: [1] }),
    )).rejects.toThrow(/could not inspect running Scout processes/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
  });

  test("fails closed when process inspection fails after TERM", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, { running: true, psFailuresAt: [2] }),
    )).rejects.toThrow(/could not inspect running Scout processes/);
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "123")).toBe(true);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
  });

  test("leaves a running app stopped without relaunching when --no-restart is set", async () => {
    const world = createWorld({ installed: true });
    const { context, stdout } = captureContext();
    await runInstallCommand(context, ["--no-restart"], createHarness(world, { running: true }));
    expect(world.calls.some((call) => call.command === "kill" && call.args[0] === "123")).toBe(true);
    expect(world.calls.some((call) => call.command === "osascript")).toBe(false);
    expect(world.calls.some((call) => call.command === "open")).toBe(false);
    expect(parseJsonOutput(stdout).message).toContain("restart Scout");
  });

  test("opens only the installed path and reports no relaunch when open fails", async () => {
    const world = createWorld({ installed: true });
    const { context, stdout } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, { running: true, open: failed("LaunchServices failed") }),
    )).rejects.toThrow(/could not relaunch/);
    expect(stdout).toHaveLength(0);
    expect(world.calls.filter((call) => call.command === "open")).toEqual([
      { command: "open", args: [world.appPath] },
    ]);
    expect(world.calls.some((call) => call.command === "osascript" || call.args.includes("-b"))).toBe(false);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("new");
  });

  test("rolls back to the previous app when replacement fails", async () => {
    const world = createWorld({ installed: true });
    const stagedPath = join(world.workDir, OPENSCOUT_APP_NAME);
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, {
        renameSync: (from, to) => {
          if (from === stagedPath) {
            const error = new Error("cross-device link") as NodeJS.ErrnoException;
            error.code = "EXDEV";
            throw error;
          }
          renameSync(from, to);
        },
        ditto: (source, destination, count) => {
          if (count === 1) {
            cpSync(source, destination, { recursive: true });
            return ok();
          }
          return failed("ditto failed");
        },
      }),
    )).rejects.toThrow(/ditto failed/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
    expect(existsSync(`${world.appPath}.openscout-previous`)).toBe(false);
  });

  test("keeps a verified destination and removes a crash-left backup", async () => {
    const world = createWorld({ installed: true });
    const backupPath = `${world.appPath}.openscout-previous`;
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "new");
    mkdirSync(join(backupPath, "Contents"), { recursive: true });
    writeFileSync(join(backupPath, "Contents", "Info.plist"), "old");
    const { context, stdout } = captureContext();

    await runInstallCommand(context, [], createHarness(world));

    expect(parseJsonOutput(stdout).status).toBe("up-to-date");
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("new");
    expect(existsSync(backupPath)).toBe(false);
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
  });

  test("restores a verified backup when a crash-left destination is invalid", async () => {
    const world = createWorld({ installed: true });
    const backupPath = `${world.appPath}.openscout-previous`;
    writeFileSync(join(world.appPath, "Contents", "Info.plist"), "partial");
    mkdirSync(join(backupPath, "Contents"), { recursive: true });
    writeFileSync(join(backupPath, "Contents", "Info.plist"), "old");
    world.release = {
      tag_name: "v0.2.69",
      name: "OpenScout v0.2.69",
      assets: [releaseAsset("OpenScout-0.2.69.dmg", {
        size: world.body.length,
        digest: sha256(world.body),
      })],
    };
    const { context, stdout } = captureContext();

    await runInstallCommand(context, [], createHarness(world, { failNthDeepVerify: 1 }));

    expect(parseJsonOutput(stdout).status).toBe("up-to-date");
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
    expect(existsSync(backupPath)).toBe(false);
    expect(world.calls.some((call) => call.command === "hdiutil")).toBe(false);
  });

  test("removes a partial destination when there was no prior app", async () => {
    const world = createWorld();
    const stagedPath = join(world.workDir, OPENSCOUT_APP_NAME);
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      [],
      createHarness(world, {
        renameSync: (from, to) => {
          if (from === stagedPath) {
            const error = new Error("cross-device link") as NodeJS.ErrnoException;
            error.code = "EXDEV";
            throw error;
          }
          renameSync(from, to);
        },
        ditto: (source, destination, count) => {
          if (count === 1) {
            cpSync(source, destination, { recursive: true });
            return ok();
          }
          mkdirSync(join(destination, "Contents"), { recursive: true });
          writeFileSync(join(destination, "Contents", "Info.plist"), "partial");
          return failed("ditto failed");
        },
      }),
    )).rejects.toThrow(/ditto failed/);
    expect(existsSync(world.appPath)).toBe(false);
  });

  test("verifies the final copied app before deleting the previous backup", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, { failNthDeepVerify: 2 }),
    )).rejects.toThrow(/codesign --verify --deep --strict/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("old");
    expect(existsSync(`${world.appPath}.openscout-previous`)).toBe(false);
  });

  test("does not roll back a verified new app when post-commit backup cleanup fails", async () => {
    const world = createWorld({ installed: true });
    const backupPath = `${world.appPath}.openscout-previous`;
    const { context } = captureContext();
    await expect(runInstallCommand(
      context,
      ["--force"],
      createHarness(world, {
        rmSync: (path, options) => {
          if (path === backupPath) throw new Error("backup cleanup denied");
          rmSync(path, options);
        },
      }),
    )).rejects.toThrow(/backup cleanup denied/);
    expect(readFileSync(join(world.appPath, "Contents", "Info.plist"), "utf8")).toBe("new");
    expect(readFileSync(join(backupPath, "Contents", "Info.plist"), "utf8")).toBe("old");
  });

  test("does not suggest running the CLI with sudo on a permission error", async () => {
    const world = createWorld({ installed: true });
    const { context } = captureContext();
    try {
      await runInstallCommand(
        context,
        ["--force"],
        createHarness(world, {
          renameSync: (from, to) => {
            if (from === world.appPath) {
              const error = new Error("EACCES") as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }
            renameSync(from, to);
          },
        }),
      );
      throw new Error("expected permission failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ScoutCliError);
      expect((error as Error).message).toContain("permission denied");
      expect((error as Error).message).not.toContain("sudo");
    }
  });

  test("never clears quarantine attributes", async () => {
    const world = createWorld();
    const { context } = captureContext();
    await runInstallCommand(context, [], createHarness(world));
    expect(world.calls.map((call) => call.command)).not.toContain("xattr");
    expect(JSON.stringify(world.calls)).not.toContain("com.apple.quarantine");
    expect(JSON.stringify(world.calls)).not.toContain("stapler");
  });
});
