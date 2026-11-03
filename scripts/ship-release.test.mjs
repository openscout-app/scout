import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findFootprintFailures, findCorePackedFilesFailures, SCOUT_INSTALL_DEPENDENCIES } from "./check-packed-manifests.mjs";

const repoRoot = new URL("..", import.meta.url);
const currentVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .version;

test("TUI fallback releases leave GitHub Latest to the native installer", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-scout-tui.yml", import.meta.url), "utf8");
  const releaseCreates = workflow.match(/\bgh release create\b[^\n]*/g) ?? [];
  assert.ok(releaseCreates.length > 0, "the fallback release creation remains covered");
  for (const command of releaseCreates) {
    assert.match(command, /--latest=false(?:\s|$)/, "TUI-only releases must not take Latest from the Mac installer");
  }
});

function plan(...args) {
  return spawnSync(process.execPath, ["scripts/ship-release.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("public release plan is reviewed-source-only and complete-state idempotent", () => {
  const result = plan(currentVersion);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`@openscout/protocol@${currentVersion}`));
  assert.ok(result.stdout.includes(`@openscout/scout@${currentVersion}`));
  assert.ok(result.stdout.includes(`packages/cli/src/lib/shared/product.ts: ${currentVersion}`));
  assert.ok(result.stdout.includes(`docs.json: ${currentVersion}`));
  assert.ok(result.stdout.includes(`packages/cli/server.json: ${currentVersion}`));
  assert.match(result.stdout, /git fetch --no-tags origin refs\/heads\/main/);
  assert.match(result.stdout, /ship-npm\.sh --verify-state/);
  assert.match(result.stdout, /ship-npm\.sh --prepare/);
  assert.match(result.stdout, /ship-npm\.sh --publish-prepared/);
  assert.match(result.stdout, /no OIDC provenance/);
  assert.doesNotMatch(result.stdout, /gh workflow run/);
  assert.match(result.stdout, /git push --atomic origin HEAD:refs\/heads\/main/);
  assert.match(result.stdout, /ship-npm\.sh --verify-published/);
  assert.match(result.stdout, /GitHub release v[\d.]+ --generate-notes --latest=false/);
  assert.match(result.stdout, /GitHub Latest \(downloadable native installer\) unchanged/);
  assert.doesNotMatch(result.stdout, /bump-version|git commit|--follow-tags/);
  assert.doesNotMatch(result.stdout, /apps\/macos|appcast|include-ios|\.dmg/i);
});

test("ambiguous mutating and partial-release options are rejected", () => {
  for (const option of [
    "--allow-dirty",
    "--skip-bump",
    "--no-commit",
    "--skip-tag",
    "--skip-push",
    "--skip-npm",
    "--skip-github-release",
  ]) {
    const result = plan(currentVersion, option);
    assert.notEqual(result.status, 0, option);
    assert.match(result.stderr, /Unsupported release option/, option);
  }
});

test("local execution requires explicit confirmation before any mutation", () => {
  const result = plan(currentVersion, "--execute");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to publish without --yes/);
});

test("stable execution publishes from GitHub Actions unless --local-publish is explicit", () => {
  // CI sets GITHUB_ACTIONS, which this entry point refuses before the guard.
  const local = (...args) => spawnSync(process.execPath, ["scripts/ship-release.mjs", ...args], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" },
  });
  const result = local(currentVersion, "--execute", "--yes");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stable releases publish from GitHub Actions, so npm records provenance/);
  assert.ok(result.stderr.includes(`gh workflow run release-package-npm.yml --repo openscout-app/scout --ref main -f tag=v${currentVersion} -f npm_tag=latest`));
  assert.match(result.stderr, /--local-publish only when the hosted workflow cannot run/);
  assert.match(result.stderr, /tag the tip of public main/);
  assert.doesNotMatch(result.stderr, /no candidate hold/);
  const candidate = local(currentVersion, "--phase", "candidate", "--execute", "--yes");
  assert.notEqual(candidate.status, 0);
  assert.match(candidate.stderr, /Stable releases publish from GitHub Actions/);
  assert.match(candidate.stderr, /no candidate hold: it publishes straight to npm latest/);
  const hosted = spawnSync(process.execPath, ["scripts/ship-release.mjs", currentVersion, "--execute", "--yes"], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" },
  });
  assert.notEqual(hosted.status, 0);
  assert.match(hosted.stderr, /local-only; dispatch release-package-npm\.yml/);
  const dry = plan(currentVersion);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /local execution also needs --local-publish/);
  const dryLocal = plan(currentVersion, "--local-publish");
  assert.equal(dryLocal.status, 0, dryLocal.stderr);
  assert.match(dryLocal.stdout, /Re-run with --execute --yes --local-publish/);
  assert.doesNotMatch(dryLocal.stdout, /also needs --local-publish/);
});

for (const mode of [[], ["--publish-prepared"], ["--publish-candidate"]]) {
  test(`ship-npm.sh ${mode[0] ?? "publish"} refuses a local upload without --local-publish`, () => {
    const { fixture, stateDir } = createPublishFixture();
    try {
      const result = spawnSync("bash", ["scripts/ship-npm.sh", ...mode], {
        cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only", SCOUT_NPM_LOCAL_PUBLISH: "" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /stable releases publish from release-package-npm\.yml; a local upload needs .*--local-publish/);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("local npm-login authentication is an explicit plan option", () => {
  const result = plan(currentVersion, "--auth", "npm-login");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local npm-login authentication/);
  assert.doesNotMatch(result.stdout, /gh workflow run/);
  const invalid = plan(currentVersion, "--auth", "automatic");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--auth must be token or npm-login/);
});

test("0.2.89 GitHub publication refuses legacy npm token authentication", () => {
  const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "openscout-app/scout",
      GITHUB_WORKFLOW_REF: "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
      NPM_TOKEN: "legacy-token-must-not-be-used",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires npm trusted publishing; refusing token authentication/i);
});

test("GitHub npm dispatch is disabled for the authority cutover", () => {
  const result = plan("0.2.99", "--github-npm");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled[\s\S]*explicit workflow dispatch/i);
});

test("release versions are exact stable semver", () => {
  const result = plan("0.2.99oops");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid stable version/);
});

test("each npm write takes a fresh one-time code from SCOUT_NPM_OTP_COMMAND and never prints it", () => {
  const source = readFileSync(new URL("ship-npm.sh", import.meta.url), "utf8");
  const start = source.indexOf("run_npm_with_config() {");
  const functions = source.slice(start, source.indexOf("\n}\n", source.indexOf("run_npm_mutation() {")) + 3);
  const dir = mkdtempSync(join(tmpdir(), "scout-npm-otp-test."));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/npm"), '#!/bin/bash\nprintf "%s otp=%s\\n" "$*" "${npm_config_otp:-none}" >> "$NPM_LOG"\n');
    chmodSync(join(dir, "bin/npm"), 0o755);
    writeFileSync(join(dir, "otp.sh"), '#!/bin/bash\nn=$(( $(cat "$OTP_COUNTER" 2>/dev/null || echo 0) + 1 ))\necho "$n" > "$OTP_COUNTER"\nprintf "%06d\\n" $((100000 + n))\n');
    chmodSync(join(dir, "otp.sh"), 0o755);
    const log = join(dir, "npm.log");
    const run = (otpCommand, githubActions = "") => {
      rmSync(log, { force: true });
      const { npm_config_otp: _inherited, ...env } = process.env;
      return spawnSync("bash", ["-c", `set -euo pipefail; NPMRC=""\n${functions}\nrun_npm_mutation publish a.tgz --tag staging\nrun_npm_mutation dist-tag add a@1.0.0 latest`], {
        env: { ...env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, NPM_LOG: log, OTP_COUNTER: join(dir, "counter"), SCOUT_NPM_OTP_COMMAND: otpCommand, GITHUB_ACTIONS: githubActions },
        encoding: "utf8",
      });
    };

    let result = run(join(dir, "otp.sh"));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "publish a.tgz --tag staging otp=100001",
      "dist-tag add a@1.0.0 latest otp=100002",
    ]);
    assert.doesNotMatch(result.stdout + result.stderr, /10000[12]/);

    result = run("echo not-a-code");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not print a one-time code/);
    assert.equal(existsSync(log), false);

    result = run("exit 3");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCOUT_NPM_OTP_COMMAND failed/);
    assert.equal(existsSync(log), false);

    for (const [otpCommand, githubActions] of [["", ""], [join(dir, "otp.sh"), "true"]]) {
      result = run(otpCommand, githubActions);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
        "publish a.tgz --tag staging otp=none",
        "dist-tag add a@1.0.0 latest otp=none",
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SCOUT_APP_VERSION and the MCP Registry server version participate in release lockstep", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-release-source-test."));
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    copyFileSync(new URL("ship-release.mjs", import.meta.url), join(fixture, "scripts/ship-release.mjs"));

    const manifests = [
      ".",
      "packages/agent-sessions",
      "packages/cli",
      "packages/protocol",
      "packages/runtime",
      "packages/session-trace",
      "packages/pairing",
    ];
    for (const directory of manifests) {
      mkdirSync(join(fixture, directory), { recursive: true });
      let name = "fixture-" + directory.replaceAll("/", "-");
      if (directory === "packages/cli") name = "@openscout/scout";
      if (directory === "packages/protocol") name = "@openscout/protocol";
      writeFileSync(
        join(fixture, directory, "package.json"),
        JSON.stringify({ name, version: "0.2.99" }),
      );
    }
    const lockWorkspaces = manifests
      .filter((directory) => directory !== ".")
      .map((directory) => `    "${directory}": {\n      "version": "0.2.99",\n    },`)
      .join("\n");
    writeFileSync(
      join(fixture, "bun.lock"),
      `{\n  "lockfileVersion": 1,\n  "workspaces": {\n${lockWorkspaces}\n  },\n}\n`,
    );
    mkdirSync(join(fixture, "packages/cli/src/lib/shared"), { recursive: true });
    writeFileSync(
      join(fixture, "packages/cli/src/lib/shared/product.ts"),
      'export const SCOUT_APP_VERSION = process.env.SCOUT_APP_VERSION?.trim() || "0.2.87";\n',
    );
    writeFileSync(join(fixture, "docs.json"), JSON.stringify({ version: "0.2.99" }));
    writeFileSync(
      join(fixture, "packages/cli/server.json"),
      JSON.stringify({ version: "0.2.98", packages: [{ identifier: "@openscout/scout", version: "0.2.99" }] }),
    );

    const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99"], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /product\.ts=0\.2\.87/);
    assert.match(result.stderr, /server\.json=0\.2\.98/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createRegistryFixture({
  version = "0.2.99",
  authority = "local-signed",
  mismatchedGitHead = false,
  completeSet = false,
  receiptState = "matching",
  registryIntegrityMismatch = false,
  protocolLatest = "0.2.87",
  scoutLatest = "0.2.87",
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "scout-npm-state-test."));
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "packages/protocol"), { recursive: true });
  mkdirSync(join(fixture, "packages/cli"), { recursive: true });
  mkdirSync(join(fixture, "fake-bin"), { recursive: true });
  mkdirSync(join(fixture, "release-state"), { recursive: true });
  copyFileSync(new URL("ship-npm.sh", import.meta.url), join(fixture, "scripts/ship-npm.sh"));
  copyFileSync(
    new URL("npm-release-receipt.mjs", import.meta.url),
    join(fixture, "scripts/npm-release-receipt.mjs"),
  );
  chmodSync(join(fixture, "scripts/ship-npm.sh"), 0o755);
  writeFileSync(
    join(fixture, "packages/protocol/package.json"),
    JSON.stringify({ name: "@openscout/protocol", version }),
  );
  writeFileSync(
    join(fixture, "packages/cli/package.json"),
    JSON.stringify({ name: "@openscout/scout", version }),
  );

  writeFileSync(
    join(fixture, "fake-bin/git"),
    `#!/bin/bash
if [[ "$1" == "rev-parse" ]]; then
  echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  exit 0
fi
if [[ "$1" == "status" || "$1" == "fetch" ]]; then exit 0; fi
if [[ "$1" == "branch" ]]; then echo main; exit 0; fi
if [[ "$1" == "remote" && "$2" == "get-url" ]]; then
  echo https://github.com/openscout-app/scout.git
  exit 0
fi
if [[ "$1" == "ls-remote" ]]; then
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/tags/v${version}\\n'
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(fixture, "fake-bin/git"), 0o755);

  const protocolTarball = join(fixture, `release-state/openscout-protocol-${version}.tgz`);
  const scoutTarball = join(fixture, `release-state/openscout-scout-${version}.tgz`);
  writeFileSync(protocolTarball, "exact protocol candidate\n");
  writeFileSync(scoutTarball, "exact scout candidate\n");
  const integrity = (path) =>
    "sha512-" + createHash("sha512").update(readFileSync(path)).digest("base64");
  const protocolIntegrity = integrity(protocolTarball);
  const scoutIntegrity = integrity(scoutTarball);
  if (receiptState !== "missing") {
    const receipt = spawnSync(
      process.execPath,
      [
        "scripts/npm-release-receipt.mjs",
        "create",
        "release-state/receipt.json",
        "https://github.com/openscout-app/scout",
        version,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authority,
        "@openscout/protocol",
        version,
        protocolTarball,
        "@openscout/scout",
        version,
        scoutTarball,
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(receipt.status, 0, receipt.stderr);
    if (receiptState === "tampered") {
      writeFileSync(scoutTarball, "different rebuilt scout candidate\n");
    }
  }

  const observedSha = mismatchedGitHead
    ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(
    join(fixture, "fake-bin/npm"),
    `#!/bin/bash
if [[ "$1" != "view" ]]; then exit 9; fi
identity="$2"
field="$3"
if [[ "$identity" == "@openscout/scout@${version}" ]]; then
  if [[ "${completeSet}" != "true" ]]; then
    echo "npm error code E404" >&2
    exit 1
  fi
  case "$field" in
    version) echo ${version} ;;
    gitHead) echo ${observedSha} ;;
    repository.url) echo git+https://github.com/openscout-app/scout.git ;;
    dist.integrity) echo ${registryIntegrityMismatch ? "sha512-registrymismatch" : scoutIntegrity} ;;
    *) exit 8 ;;
  esac
  exit 0
fi
if [[ "$identity" == "@openscout/protocol@${version}" ]]; then
  case "$field" in
    version) echo ${version} ;;
    gitHead) echo ${observedSha} ;;
    repository.url) echo git+https://github.com/openscout-app/scout.git ;;
    dist.integrity) echo ${protocolIntegrity} ;;
    *) exit 8 ;;
  esac
  exit 0
fi
if [[ "$identity" == "@openscout/protocol" && "$field" == "dist-tags.latest" ]]; then
  echo ${protocolLatest}
  exit 0
fi
if [[ "$identity" == "@openscout/scout" && "$field" == "dist-tags.latest" ]]; then
  echo ${scoutLatest}
  exit 0
fi
exit 7
`,
  );
  chmodSync(join(fixture, "fake-bin/npm"), 0o755);
  return fixture;
}

function registryEnv(fixture) {
  return {
    ...process.env,
    PATH: join(fixture, "fake-bin") + ":" + process.env.PATH,
    GITHUB_ACTIONS: "false",
    NPM_TAG: "latest",
    SCOUT_NPM_RELEASE_STATE_DIR: join(fixture, "release-state"),
    SCOUT_NPM_LOCAL_PUBLISH: "1",
  };
}

function createPublishFixture({
  version = "0.2.99",
  authority = "local-signed",
  completeSet = false,
  firstUploadIntegrityMismatch = false,
  protocolLatest = completeSet ? version : "0.2.87",
  scoutLatest = completeSet ? version : "0.2.87",
} = {}) {
  const fixture = createRegistryFixture({ version, authority });
  const stateDir = join(fixture, "registry-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "protocol-latest"), protocolLatest);
  writeFileSync(join(stateDir, "scout-latest"), scoutLatest);
  writeFileSync(join(stateDir, "mutations.log"), "");
  if (completeSet) {
    writeFileSync(join(stateDir, "protocol-exists"), "");
    writeFileSync(join(stateDir, "scout-exists"), "");
  }

  const receipt = JSON.parse(readFileSync(join(fixture, "release-state/receipt.json"), "utf8"));
  const protocolReceipt = receipt.packages.find(({ name }) => name === "@openscout/protocol");
  const scoutReceipt = receipt.packages.find(({ name }) => name === "@openscout/scout");
  assert.ok(protocolReceipt && scoutReceipt);
  const protocolIntegrity = firstUploadIntegrityMismatch
    ? "sha512-registrymismatch"
    : protocolReceipt.integrity;
  const stagingTag = `scout-release-${version.replaceAll(".", "-")}`;

  const npmScript = [
    "#!/bin/bash",
    `fixture=${JSON.stringify(fixture)}`,
    `state_dir=${JSON.stringify(stateDir)}`,
    `protocol_integrity=${JSON.stringify(protocolIntegrity)}`,
    `scout_integrity=${JSON.stringify(scoutReceipt.integrity)}`,
    'command="$1"',
    'if [[ "$command" == "whoami" ]]; then',
    '  echo whoami >> "$state_dir/auth.log"',
    '  if [[ "${FIXTURE_NPM_LOGIN_FAILURE:-}" == "1" ]]; then exit 1; fi',
    '  echo fixture-user',
    '  exit 0',
    'fi',
    'if [[ "${SCOUT_NPM_AUTH_MODE:-}" == "npm-login" ]]; then',
    '  for argument in "$@"; do [[ "$argument" != "--userconfig" ]] || exit 81; done',
    'fi',
    'if [[ "$command" == "view" || "$command" == "publish" || "$command" == "dist-tag" ]]; then',
    '  scoped_registry=""',
    '  for argument in "$@"; do if [[ "$argument" == --@openscout:registry=* ]]; then scoped_registry="${argument#*=}"; fi; done',
    '  [[ "$scoped_registry" == "https://registry.npmjs.org" ]] || { echo "unbound scoped registry" >&2; exit 82; }',
    'fi',
    'if [[ "$command" == "view" ]]; then',
    '  identity="$2"',
    '  field="$3"',
    '  key=""',
    `  if [[ "$identity" == "@openscout/protocol@${version}" ]]; then key="protocol"; fi`,
    `  if [[ "$identity" == "@openscout/scout@${version}" ]]; then key="scout"; fi`,
    '  if [[ -n "$key" ]]; then',
    '    if [[ ! -f "$state_dir/${key}-exists" ]]; then echo "npm error code E404" >&2; exit 1; fi',
    '    if [[ "$field" == "version" && -n "${FIXTURE_PROPAGATION_ERROR:-}" ]]; then',
    '      count=0; [[ ! -f "$state_dir/${key}-reads" ]] || count=$(cat "$state_dir/${key}-reads")',
    '      count=$((count + 1)); echo "$count" > "$state_dir/${key}-reads"',
    '      if ((count <= ${FIXTURE_PROPAGATION_FAILURES:-1})); then',
    '        [[ " $* " == *" --prefer-online "* && " $* " == *" --prefer-offline=false "* && " $* " == *" --offline=false "* && " $* " == *" --fetch-retries=0 "* && " $* " == *" --fetch-timeout="* ]] || { echo "stale cached response: polling was not forced online" >&2; exit 83; }',
    '        if [[ "$FIXTURE_PROPAGATION_ERROR" == "WRONG_VERSION" ]]; then echo 9.9.9; exit 0; fi',
    '        echo "npm error code $FIXTURE_PROPAGATION_ERROR: fixture registry diagnostic" >&2; exit 1',
    '      fi',
    '    fi',
    '    case "$field" in',
    `      version) echo ${version} ;;`,
    '      gitHead) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;',
    '      repository.url) echo git+https://github.com/openscout-app/scout.git ;;',
    '      dist.integrity) if [[ "$key" == "protocol" ]]; then echo "$protocol_integrity"; else echo "$scout_integrity"; fi ;;',
    '      *) exit 8 ;;',
    '    esac',
    '    exit 0',
    '  fi',
    '  if [[ "$field" == "dist-tags.dev" ]]; then key="scout"; [[ "$identity" != "@openscout/protocol" ]] || key="protocol"; cat "$state_dir/${key}-dev" 2>/dev/null || true; exit 0; fi',
    '  if [[ "$identity" == "@openscout/protocol" && "$field" == "dist-tags.latest" ]]; then cat "$state_dir/protocol-latest"; exit 0; fi',
    '  if [[ "$identity" == "@openscout/scout" && "$field" == "dist-tags.latest" ]]; then cat "$state_dir/scout-latest"; exit 0; fi',
    `  if [[ "$field" == "dist-tags.${stagingTag}" ]]; then echo "\${FIXTURE_STAGING_VALUE:-${version}}"; exit 0; fi`,
    '  exit 7',
    'fi',
    'if [[ "$command" == "publish" ]]; then',
    '  tarball="$2"',
    '  [[ -f "$fixture/release-state/receipt.json" ]] || exit 77',
    '  case "$tarball" in',
    `    "$fixture/release-state/openscout-protocol-${version}.tgz") key="protocol" ;;`,
    `    "$fixture/release-state/openscout-scout-${version}.tgz") key="scout" ;;`,
    '    *) exit 78 ;;',
    '  esac',
    '  publish_tag=""',
    '  while [[ "$#" -gt 0 ]]; do',
    '    if [[ "$1" == "--tag" ]]; then publish_tag="$2"; shift 2; else shift; fi',
    '  done',
    '  [[ -n "$publish_tag" ]] || exit 80',
    '  if [[ "$key" == "scout" && "${FIXTURE_SCOUT_PUBLISH_FAILURE:-}" == "1" ]]; then echo "fixture publish failed" >&2; exit 1; fi',
    '  : > "$state_dir/${key}-exists"',
    '  if [[ "$publish_tag" == "latest" ]]; then echo ' +
      version +
      ' > "$state_dir/${key}-latest"; fi',
    '  if [[ "$publish_tag" == "dev" ]]; then echo ' + version + ' > "$state_dir/${key}-dev"; fi',
    '  if [[ "$publish_tag" == "dev" && "${FIXTURE_CHANGE_LATEST:-}" == "1" ]]; then echo "0.3.3" > "$state_dir/${key}-latest"; fi',
    '  echo "publish $key tag=$publish_tag" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'if [[ "$command" == "dist-tag" && "$2" == "add" ]]; then',
    '  identity="$3"',
    '  case "$identity" in',
    `    @openscout/protocol@${version}) key="protocol" ;;`,
    `    @openscout/scout@${version}) key="scout" ;;`,
    '    *) exit 79 ;;',
    '  esac',
    `  echo ${version} > "$state_dir/\${key}-latest"`,
    '  echo "promote $key" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'if [[ "$command" == "dist-tag" && "$2" == "rm" ]]; then',
    '  echo "remove-stage $3" >> "$state_dir/mutations.log"',
    '  exit 0',
    'fi',
    'echo "unexpected npm command: $*" >&2',
    'exit 9',
    "",
  ].join("\n");
  writeFileSync(join(fixture, "fake-bin/npm"), npmScript);
  chmodSync(join(fixture, "fake-bin/npm"), 0o755);
  return { fixture, stateDir };
}

test("registry state fails closed on a partial immutable publication", () => {
  const fixture = createRegistryFixture();
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete npm package set.*cannot be resumed/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry state rejects an existing artifact from another commit", () => {
  const fixture = createRegistryFixture({ mismatchedGitHead: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /published from b+.*expected a+/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry state allows a complete immutable set to finish dist-tag promotion", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    protocolLatest: "0.2.99",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /complete immutable 0\.2\.99 package set/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("complete registry state requires its durable receipt", () => {
  const fixture = createRegistryFixture({ completeSet: true, receiptState: "missing" });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no durable local integrity receipt/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("receipt verification rejects rebuilt or damaged retained bytes", () => {
  const fixture = createRegistryFixture({ completeSet: true, receiptState: "tampered" });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retained candidate (size|SRI) mismatch/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("registry integrity must exactly match the durable candidate receipt", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    registryIntegrityMismatch: true,
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-state"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry integrity does not match the exact reviewed candidate/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("published verification reuses the receipt without rebuilding", () => {
  const fixture = createRegistryFixture({
    completeSet: true,
    protocolLatest: "0.2.99",
    scoutLatest: "0.2.99",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--verify-published"], {
      cwd: fixture,
      encoding: "utf8",
      env: registryEnv(fixture),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Building packages|Preparing exact publication candidates/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("release receipts are exclusive and cannot be overwritten", () => {
  const fixture = createRegistryFixture();
  try {
    const receiptPath = join(fixture, "release-state/receipt.json");
    const before = readFileSync(receiptPath, "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/npm-release-receipt.mjs",
        "create",
        receiptPath,
        "https://github.com/openscout-app/scout",
        "0.2.99",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "local-signed",
        "@openscout/protocol",
        "0.2.99",
        join(fixture, "release-state/openscout-protocol-0.2.99.tgz"),
        "@openscout/scout",
        "0.2.99",
        join(fixture, "release-state/openscout-scout-0.2.99.tgz"),
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persist receipt exclusively/i);
    assert.equal(readFileSync(receiptPath, "utf8"), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("publish resumes from retained candidates and records them before npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Building packages|Preparing exact publication candidates/);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.match(
      mutations,
      /^publish protocol tag=scout-release-0-2-99\npublish scout tag=scout-release-0-2-99\n/,
    );
    assert.match(mutations, /promote protocol\npromote scout\n/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("explicit npm-login publishes the retained pair without reading or copying credentials", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    const npmrc = join(fixture, "existing-npmrc");
    writeFileSync(npmrc, "@openscout:registry=https://foreign.invalid\n");
    writeFileSync(join(fixture, "fake-bin/secret"), "#!/bin/bash\ntouch secret-helper-called\nexit 99\n");
    chmodSync(join(fixture, "fake-bin/secret"), 0o755);
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "", NODE_AUTH_TOKEN: "", SCOUT_NPM_AUTH_MODE: "npm-login", NPM_CONFIG_USERCONFIG: npmrc },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(npmrc, "utf8"), "@openscout:registry=https://foreign.invalid\n");
    assert.equal(existsSync(join(fixture, "secret-helper-called")), false);
    assert.equal(readFileSync(join(stateDir, "auth.log"), "utf8"), "whoami\n");
    assert.match(readFileSync(join(stateDir, "mutations.log"), "utf8"), /^publish protocol tag=scout-release-0-2-99\npublish scout tag=scout-release-0-2-99\npromote protocol\npromote scout\n/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-user|foreign\.invalid/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const [label, extra, expected] of [
  ["missing login", { FIXTURE_NPM_LOGIN_FAILURE: "1" }, /existing authenticated npm login/],
  ["token conflict", { NPM_TOKEN: "fixture-token" }, /cannot be combined with NPM_TOKEN/],
  ["node token conflict", { NODE_AUTH_TOKEN: "fixture-token" }, /cannot be combined with NPM_TOKEN or NODE_AUTH_TOKEN/],
  ["hosted authority", { GITHUB_ACTIONS: "true" }, /npm-login authentication is local-only/],
  ["unknown mode", { SCOUT_NPM_AUTH_MODE: "automatic" }, /SCOUT_NPM_AUTH_MODE must be token or npm-login/],
]) {
  test(`npm-login fails closed before mutations: ${label}`, () => {
    const { fixture, stateDir } = createPublishFixture();
    try {
      const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...registryEnv(fixture), NPM_TOKEN: "", NODE_AUTH_TOKEN: "", SCOUT_NPM_AUTH_MODE: "npm-login", ...extra },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("npm-login preparation and completed publication do not authenticate", () => {
  for (const [mode, completeSet] of [["--prepare", false], ["--publish-prepared", true]]) {
    const { fixture, stateDir } = createPublishFixture({ completeSet });
    try {
      const result = spawnSync("bash", ["scripts/ship-npm.sh", mode], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...registryEnv(fixture), NPM_TOKEN: "", NODE_AUTH_TOKEN: "", SCOUT_NPM_AUTH_MODE: "npm-login", FIXTURE_NPM_LOGIN_FAILURE: "1" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(stateDir, "auth.log")), false);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test("trusted publishing works without optional token arguments on macOS Bash", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
  });
  try {
    writeFileSync(
      join(fixture, "fake-bin/secret"),
      `#!/bin/bash\necho called > ${JSON.stringify(join(fixture, "secret-called"))}\necho legacy-token\n`,
    );
    chmodSync(join(fixture, "fake-bin/secret"), 0o755);
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fixture, "secret-called")), false);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.match(mutations, /^publish protocol tag=latest\npublish scout tag=latest\n/);
    assert.doesNotMatch(mutations, /promote|remove-stage/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted publishing converges split older latest tags with one fresh version", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
    protocolLatest: "0.2.90",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /latest is split across older versions/i);
    assert.equal(
      readFileSync(join(stateDir, "mutations.log"), "utf8"),
      "publish protocol tag=latest\npublish scout tag=latest\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("prepared OIDC candidate bundles are reusable without npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--prepare"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /candidate bundle 0\.2\.91 is ready/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("publish-prepared refuses to mutate npm without an exact candidate bundle", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
  });
  try {
    rmSync(join(fixture, "release-state"), { recursive: true, force: true });
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish-prepared requires an exact retained candidate bundle/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("OIDC recovery resumes only the missing Scout package from the exact protocol prefix", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
    protocolLatest: "0.2.91",
    scoutLatest: "0.2.87",
  });
  try {
    writeFileSync(join(stateDir, "protocol-exists"), "");
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exact protocol prefix is recoverable/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish scout tag=latest\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("OIDC recovery rejects a protocol artifact that has not reached latest", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
    protocolLatest: "0.2.90",
    scoutLatest: "0.2.87",
  });
  try {
    writeFileSync(join(stateDir, "protocol-exists"), "");
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not the recoverable protocol-first prefix/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("OIDC recovery rejects a Scout-only partial set before npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
    protocolLatest: "0.2.87",
    scoutLatest: "0.2.91",
  });
  try {
    writeFileSync(join(stateDir, "scout-exists"), "");
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exists before its protocol dependency/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted publishing refuses dist-tag recovery for an existing unpromoted set", () => {
  const { fixture, stateDir } = createPublishFixture({
    version: "0.2.91",
    authority: "github-oidc",
    completeSet: true,
    protocolLatest: "0.2.87",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...registryEnv(fixture),
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "openscout-app/scout",
        GITHUB_WORKFLOW_REF:
          "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
        NPM_TOKEN: "",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm OIDC cannot mutate dist-tags/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("first-upload SRI mismatch stops before the second immutable upload", () => {
  const { fixture, stateDir } = createPublishFixture({ firstUploadIntegrityMismatch: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /registry integrity does not match the exact reviewed candidate/i);
    assert.equal(
      readFileSync(join(stateDir, "mutations.log"), "utf8"),
      "publish protocol tag=scout-release-0-2-99\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a competing local publication lock fails before npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    mkdirSync(join(fixture, "release-state.lock"));
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm release lock already exists/i);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a fully promoted matching set performs no npm mutation", () => {
  const { fixture, stateDir } = createPublishFixture({ completeSet: true });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a complete immutable set resumes only the missing mutable promotion", () => {
  const { fixture, stateDir } = createPublishFixture({
    completeSet: true,
    protocolLatest: "0.2.99",
    scoutLatest: "0.2.87",
  });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...registryEnv(fixture), NPM_TOKEN: "fixture-token" },
    });
    assert.equal(result.status, 0, result.stderr);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.doesNotMatch(mutations, /publish/);
    assert.doesNotMatch(mutations, /promote protocol/);
    assert.match(mutations, /^promote scout\n/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the isolated retained Scout candidate is normalized and passes the exact audit", () => {
  const fixture = mkdtempSync(join(tmpdir(), "scout-exact-pack-test."));
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "packages/runtime"), { recursive: true });
    mkdirSync(join(fixture, "candidate/bin"), { recursive: true });
    mkdirSync(join(fixture, "candidate/dist"), { recursive: true });
    copyFileSync(
      new URL("prepare-publish-manifest.mjs", import.meta.url),
      join(fixture, "scripts/prepare-publish-manifest.mjs"),
    );
    copyFileSync(
      new URL("check-packed-manifests.mjs", import.meta.url),
      join(fixture, "scripts/check-packed-manifests.mjs"),
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    writeFileSync(
      join(fixture, "packages/runtime/package.json"),
      JSON.stringify({ name: "@openscout/runtime", version: "0.2.99" }),
    );
    writeFileSync(
      join(fixture, "candidate/package.json"),
      JSON.stringify({
        name: "@openscout/scout",
        version: "0.2.99",
        files: ["bin", "dist", "README.md"],
        bin: { scout: "./bin/scout" },
        dependencies: { ...SCOUT_INSTALL_DEPENDENCIES },
        devDependencies: { "@openscout/runtime": "workspace:*" },
      }),
    );
    writeFileSync(join(fixture, "candidate/bin/scout"), "#!/bin/sh\n");
    writeFileSync(join(fixture, "candidate/bin/scoutd"), "fixture broker\n");
    writeFileSync(join(fixture, "candidate/dist/main.mjs"), "export {};\n");
    writeFileSync(join(fixture, "candidate/dist/pairing-runtime-controller.mjs"), "export {};\n");
    const knowledgeIndexChildPath = join(fixture, "candidate/dist/knowledge-index-child.mjs");
    writeFileSync(knowledgeIndexChildPath, "export {};\n");
    writeFileSync(join(fixture, "candidate/README.md"), "# Scout\n");
    const migrationSql = "CREATE TABLE retained (id INTEGER PRIMARY KEY);\n";
    const migrationJournal = JSON.stringify({ entries: [{ tag: "0000_retained", when: 1, breakpoints: false }] });
    mkdirSync(join(fixture, "candidate/dist/drizzle/meta"), { recursive: true });
    mkdirSync(join(fixture, "packages/runtime/drizzle/meta"), { recursive: true });
    writeFileSync(join(fixture, "candidate/dist/drizzle/0000_retained.sql"), migrationSql);
    writeFileSync(join(fixture, "candidate/dist/drizzle/meta/_journal.json"), migrationJournal);
    writeFileSync(join(fixture, "candidate/dist/drizzle/meta/0000_snapshot.json"), "{}");
    writeFileSync(join(fixture, "packages/runtime/drizzle/meta/0000_snapshot.json"), "source schema snapshot");


    const normalize = spawnSync(
      process.execPath,
      ["scripts/prepare-publish-manifest.mjs", "candidate", fixture],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(normalize.status, 0, normalize.stderr);
    const pack = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", fixture],
      {
        cwd: join(fixture, "candidate"),
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
      },
    );
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = join(fixture, "openscout-scout-0.2.99.tgz");
    const packedFiles = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    assert.equal(packedFiles.status, 0, packedFiles.stderr);
    assert.doesNotMatch(packedFiles.stdout, /_snapshot\.json/);
    for (const [name, expected] of [
      ["0000_retained.sql", migrationSql], ["meta/_journal.json", migrationJournal],
    ]) {
      const extracted = spawnSync("tar", ["-xOf", tarball, `package/dist/drizzle/${name}`], { encoding: "utf8" });
      assert.equal(extracted.status, 0, extracted.stderr);
      assert.equal(extracted.stdout, expected);
    }
    assert.equal(readFileSync(join(fixture, "packages/runtime/drizzle/meta/0000_snapshot.json"), "utf8"), "source schema snapshot");

    const audit = spawnSync(
      process.execPath,
      ["scripts/check-packed-manifests.mjs", "--tarball", tarball],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(audit.status, 0, audit.stderr);
    const packedManifest = spawnSync(
      "tar",
      ["-xOf", tarball, "package/package.json"],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.equal(packedManifest.status, 0, packedManifest.stderr);
    assert.doesNotMatch(packedManifest.stdout, /workspace:/);

    // The core still requires its background indexing worker.
    rmSync(knowledgeIndexChildPath);
    const missingChildPack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", fixture], {
      cwd: join(fixture, "candidate"), encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
    });
    assert.equal(missingChildPack.status, 0, missingChildPack.stderr);
    const missingChildAudit = spawnSync(process.execPath, ["scripts/check-packed-manifests.mjs", "--tarball", tarball], {
      cwd: fixture, encoding: "utf8",
    });
    assert.notEqual(missingChildAudit.status, 0);
    assert.match(missingChildAudit.stderr, /missing required packed files/);
    assert.match(missingChildAudit.stderr, /package\/dist\/knowledge-index-child\.mjs/);
    writeFileSync(knowledgeIndexChildPath, "export {};\n");

    const leakedCharacter = join(fixture, "candidate/dist/client/characters/sage/sage.glb");
    mkdirSync(dirname(leakedCharacter), { recursive: true });
    writeFileSync(leakedCharacter, "excluded character asset");
    const leakedPack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", fixture], {
      cwd: join(fixture, "candidate"), encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
    });
    assert.equal(leakedPack.status, 0, leakedPack.stderr);
    const leakedAudit = spawnSync(process.execPath, ["scripts/check-packed-manifests.mjs", "--tarball", tarball], {
      cwd: fixture, encoding: "utf8",
    });
    assert.notEqual(leakedAudit.status, 0);
    assert.match(leakedAudit.stderr, /characters\/sage\/sage.glb/);
    rmSync(leakedCharacter);

    // Crew artwork stays out of npm entirely.
    const leakedCrew = join(fixture, "candidate/dist/client/crew/sprout-bust.webp");
    mkdirSync(dirname(leakedCrew), { recursive: true });
    writeFileSync(leakedCrew, "fixture runtime art\n");
    const crewPack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", fixture], {
      cwd: join(fixture, "candidate"), encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(fixture, "npm-cache") },
    });
    assert.equal(crewPack.status, 0, crewPack.stderr);
    const crewAudit = spawnSync(process.execPath, ["scripts/check-packed-manifests.mjs", "--tarball", tarball], {
      cwd: fixture, encoding: "utf8",
    });
    assert.notEqual(crewAudit.status, 0);
    assert.match(crewAudit.stderr, /crew\/sprout-bust\.webp/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("packed core rejects stale client assets, server shims and bundled app source", () => {
  const main = "package/dist/main.mjs";
  const files = new Map([[main, "export {};"]]);
  const audit = () => findCorePackedFilesFailures([...files.keys()], entry => files.get(entry));
  assert.deepEqual(audit(), []);
  for (const entry of [
    "package/dist/client/index.html", "package/dist/client/assets/basic.js",
    "package/dist/scout-control-plane-web.mjs", "package/dist/scout-web-server.mjs",
    "package/dist/openscout-terminal-relay.mjs", "package/apps/desktop/main.ts",
  ]) {
    files.set(entry, "export {};");
    assert.match(audit().join("\n"), /App artifact returned/);
    files.delete(entry);
  }
  for (const source of ["// packages/web/server/index.ts\nexport {};", "// apps/desktop/src/main.ts\nexport {};"]) {
    files.set(main, source);
    assert.match(audit().join("\n"), /App source returned/);
  }
});

test("Package limits still reject excess bytes and file growth", () => {
  const oversized = findFootprintFailures("@openscout/scout", {
    packedBytes: 26_000_001,
    unpackedBytes: 60_000_001,
    fileCount: 671,
    fileSizes: new Map([["package/dist/scout-web-server.mjs", 103]]),
  });
  assert.match(oversized.join("\n"), /packed size .* exceeds/);
  assert.match(oversized.join("\n"), /unpacked size .* exceeds/);
  assert.match(oversized.join("\n"), /file count .* exceeds/);
});

test("npm publication is pinned, OIDC-compatible, and exactly scoped", () => {
  const script = readFileSync(new URL("ship-npm.sh", import.meta.url), "utf8");
  const publishMissing = script.slice(
    script.indexOf("publish_missing_artifacts()"),
    script.indexOf("wait_for_final_tag()"),
  );
  assert.match(script, /PUBLISH_PACKAGES=\(protocol cli\)/);
  assert.match(script, /NPM_REGISTRY_URL="https:\/\/registry\.npmjs\.org"/);
  assert.match(script, /PUBLISH_NPM_TAG="\$FINAL_NPM_TAG"/);
  assert.match(script, /--tag "\$PUBLISH_NPM_TAG"/);
  assert.match(script, /gitHead/);
  assert.match(script, /repository\.url/);
  assert.match(script, /registry integrity does not match the exact reviewed candidate/);
  assert.match(script, /run_npm_mutation publish "\$tarball"/);
  assert.doesNotMatch(script, /NPM_AUTH_ARGS/);
  assert.match(script, /manifest\.gitHead = process\.argv\[2\]/);
  assert.match(script, /exact candidate gitHead/);
  assert.match(script, /prepare-publish-manifest\.mjs "\$pack_root" "\$PWD"/);
  assert.match(script, /check-packed-manifests\.mjs --tarball "\$tarball"/);
  assert.ok(publishMissing.indexOf('wait_for_exact_artifact "$index"') < publishMissing.indexOf('inspect_exact_artifact "$index"'));
  const execution = script.slice(
    script.indexOf("if all_artifacts_exist; then", script.indexOf("if [[ \"$MODE\" == \"publish-prepared\"")),
  );
  assert.ok(execution.length > 0);
  assert.ok(execution.indexOf("persist_release_bundle") < execution.indexOf("publish_missing_artifacts"));
  assert.match(script, /npm release lock already exists/);
  assert.match(script, /refusing to overwrite existing npm release bundle/);
  assert.match(script, /incomplete npm package set and cannot be resumed/);
  assert.match(script, /NPM_DIST_TAG_VERIFY_ATTEMPTS="\$\{NPM_DIST_TAG_VERIFY_ATTEMPTS:-120\}"/);
  assert.match(script, /historical and unsupported; publication is disabled/);
  assert.match(script, /GITHUB_WORKFLOW_REF/);
  assert.match(script, /requires npm trusted publishing; refusing token authentication/);
  assert.match(script, /npm OIDC cannot mutate dist-tags/);
  assert.match(script, /assert_canonical_publish_ref/);
  assert.ok(script.indexOf("publish_missing_artifacts") < script.indexOf("promote_package_set"));
});

for (const version of ["0.2.88", "0.2.89", "0.2.90"]) {
  test(`historical ${version} cannot publish, prepare, or promote locally`, () => {
    const { fixture, stateDir } = createPublishFixture({ version });
    try {
      for (const mode of ["publish", "--prepare", "--publish-prepared"]) {
        const result = spawnSync("bash", ["scripts/ship-npm.sh", mode], {
          cwd: fixture, encoding: "utf8", env: registryEnv(fixture),
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /historical and unsupported/);
      }
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

for (const [label, before, after, diagnostic] of [
  ["foreign origin", "https://github.com/openscout-app/scout.git", "https://github.com/other/scout.git", /requires https:\/\/github.com\/openscout-app\/scout/],
  ["unreviewed branch", "then echo main;", "then echo feature;", /requires reviewed public main/],
  ["stale main", 'if [[ "$1" == "rev-parse" ]]; then', 'if [[ "$2" == "FETCH_HEAD^{commit}" ]]; then echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; exit 0; fi\nif [[ "$1" == "rev-parse" ]]; then', /freshly fetched origin\/main/],
  ["dirty source", 'if [[ "$1" == "status" ||', 'if [[ "$1" == "status" ]]; then echo " M source.ts"; exit 0; fi\nif [[ "$1" == "status" ||', /clean reviewed source/],
]) {
  test(`local publication rejects ${label} before npm mutation`, () => {
    const { fixture, stateDir } = createPublishFixture();
    try {
      const gitPath = join(fixture, "fake-bin/git");
      const original = readFileSync(gitPath, "utf8");
      assert.ok(original.includes(before));
      writeFileSync(gitPath, original.replace(before, after));
      const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
        cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, diagnostic);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("local publication overrides inherited provenance and records its actual authority", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    const npmPath = join(fixture, "fake-bin/npm");
    writeFileSync(npmPath, readFileSync(npmPath, "utf8").replace(
      'if [[ "$command" == "publish" ]]; then',
      'if [[ "$command" == "publish" ]]; then\n  [[ "$NPM_CONFIG_PROVENANCE" == "false" && "$npm_config_provenance" == "false" ]] || exit 91',
    ));
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only", NPM_CONFIG_PROVENANCE: "true", npm_config_provenance: "true" },
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(fixture, "release-state/receipt.json"), "utf8"));
    assert.equal(receipt.authority, "local-signed");
    assert.equal(receipt.provenance, "none");
    assert.match(readFileSync(join(stateDir, "mutations.log"), "utf8"), /publish protocol/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("local candidates cannot acquire a false OIDC receipt claim", () => {
  const { fixture, stateDir } = createPublishFixture();
  try {
    const receiptPath = join(fixture, "release-state/receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.provenance = "github-oidc";
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture, encoding: "utf8", env: registryEnv(fixture),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /receipt provenance/);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

function createLocalReleaseFixture({ corruptReceipt = false, initialRelease = "final", version = "0.2.99" } = {}) {
  const state = createPublishFixture({ version });
  const { fixture } = state;
  copyFileSync(new URL("ship-release.mjs", import.meta.url), join(fixture, "scripts/ship-release.mjs"));
  const manifests = [".", "packages/agent-sessions", "packages/cli", "packages/protocol", "packages/runtime", "packages/session-trace", "packages/pairing"];
  for (const directory of manifests) {
    mkdirSync(join(fixture, directory), { recursive: true });
    if (!existsSync(join(fixture, directory, "package.json"))) {
      writeFileSync(join(fixture, directory, "package.json"), JSON.stringify({ name: "fixture", version }));
    }
  }
  writeFileSync(join(fixture, "bun.lock"), '{\n"workspaces": {\n' + manifests.filter(p => p !== ".").map(p => `    "${p}": {\n      "version": "${version}",\n    },`).join("\n") + '\n}\n}');
  mkdirSync(join(fixture, "packages/cli/src/lib/shared"), { recursive: true });
  writeFileSync(join(fixture, "packages/cli/src/lib/shared/product.ts"), `export const SCOUT_APP_VERSION = process.env.SCOUT_APP_VERSION?.trim() || "${version}";`);
  writeFileSync(join(fixture, "docs.json"), JSON.stringify({ version }));
  writeFileSync(join(fixture, "packages/cli/server.json"), JSON.stringify({ version, packages: [{ identifier: "@openscout/scout", version }] }));
  const receipt = readFileSync(join(fixture, "release-state/receipt.json"));
  const remoteReceipt = join(fixture, "remote-receipt.json");
  if (corruptReceipt) {
    const corrupt = Buffer.from(receipt); corrupt[0] = 0;
    writeFileSync(remoteReceipt, corrupt);
  }
  // Release state: "missing", or "<isDraft> <isPrerelease>". Every create/edit
  // argv is logged so tests can assert how GitHub Latest was handled.
  const releaseState = join(fixture, "gh-release-state");
  const initialStates = { draft: "true false", prerelease: "false true", final: "false false" };
  if (initialRelease !== "missing") writeFileSync(releaseState, initialStates[initialRelease]);
  writeFileSync(join(fixture, "fake-bin/gh"), `#!/bin/bash
state='${releaseState}'
if [[ "$1 $2" == "release view" ]]; then
  if [[ ! -f "$state" ]]; then echo "release not found" >&2; exit 1; fi
  read -r draft prerelease < "$state"
  assets=''
  comma=''
  for name in receipt.json candidate-receipt.json; do
    file='${fixture}/remote-'"$name"
    if [[ -f "$file" ]]; then
      size=$(wc -c < "$file" | tr -d ' ')
      assets="$assets$comma"'{"name":"'"$name"'","size":'"$size"',"url":"https://github.com/openscout-app/scout/releases/download/v${version}/'"$name"'"}'
      comma=','
    fi
  done
  assets="[$assets]"
  echo '{"tagName":"v${version}","isDraft":'"$draft"',"isPrerelease":'"$prerelease"',"url":"https://github.com/openscout-app/scout/releases/tag/v${version}","assets":'"$assets"'}'
  exit 0
fi
if [[ "$1 $2" == "release create" ]]; then
  [[ ! -f "$state" ]] || exit 96
  echo "$*" >> '${fixture}/gh-release-calls.log'
  prerelease=false
  for arg in "$@"; do [[ "$arg" == "--prerelease" ]] && prerelease=true; done
  echo "false $prerelease" > "$state"
  exit 0
fi
if [[ "$1 $2" == "release edit" ]]; then
  [[ -f "$state" ]] || exit 95
  echo "$*" >> '${fixture}/gh-release-calls.log'
  read -r draft prerelease < "$state"
  for arg in "$@"; do
    [[ "$arg" == "--draft=false" ]] && draft=false
    [[ "$arg" == "--prerelease=false" ]] && prerelease=false
  done
  echo "$draft $prerelease" > "$state"
  exit 0
fi
if [[ "$1 $2" == "release upload" ]]; then
  name=$(basename "$4")
  target='${fixture}/remote-'"$name"
  if [[ "$name" == "candidate-receipt.json" && "\${FIXTURE_CANDIDATE_ASSET_FAILURE:-}" == "1" ]]; then exit 1; fi
  [[ ! -f "$target" ]] || exit 97
  cp "$4" "$target"
  echo upload >> '${fixture}/gh-mutations.log'
  exit 0
fi
exit 98
`);
  writeFileSync(join(fixture, "fake-bin/curl"), `#!/bin/bash\nfor url in "$@"; do :; done\nname=\${url##*/}\ncat '${fixture}/remote-'"$name"\n`);
  chmodSync(join(fixture, "fake-bin/gh"), 0o755);
  chmodSync(join(fixture, "fake-bin/curl"), 0o755);
  return state;
}

for (const corruptReceipt of [false, true]) {
  test(`local release orchestration ${corruptReceipt ? "refuses conflicting public receipt" : "reuses candidates and verifies public receipt bytes"}`, () => {
    const { fixture, stateDir } = createLocalReleaseFixture({ corruptReceipt });
    try {
      const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--execute", "--yes", "--local-publish"], {
        cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only" },
      });
      if (corruptReceipt) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Public GitHub npm receipt bytes differ/);
        assert.equal(existsSync(join(fixture, "gh-mutations.log")), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /release complete/);
        assert.deepEqual(readFileSync(join(fixture, "remote-receipt.json")), readFileSync(join(fixture, "release-state/receipt.json")));
      }
      assert.match(readFileSync(join(stateDir, "mutations.log"), "utf8"), /publish protocol[\s\S]*publish scout/);
      assert.doesNotMatch(result.stdout, /workflow run|Building packages/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

for (const initialRelease of ["missing", "draft", "prerelease"]) {
  test(`local release publishes a ${initialRelease} receipt-only release without claiming GitHub Latest`, () => {
    const { fixture } = createLocalReleaseFixture({ initialRelease });
    try {
      const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--execute", "--yes", "--local-publish"], {
        cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only", SCOUT_NPM_LOCAL_PUBLISH: "" },
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(join(fixture, "gh-release-calls.log"), "utf8").trim().split("\n");
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.match(call, /--latest=false/, call);
        assert.doesNotMatch(call, /--latest(?!=false)/, call);
      }
      if (initialRelease === "missing") assert.match(calls[0], /^release create v0\.2\.99 /);
      else assert.ok(calls.every((call) => call.startsWith("release edit v0.2.99 ")));
      assert.equal(readFileSync(join(fixture, "gh-release-state"), "utf8").trim(), "false false");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

for (const phase of ["release", "candidate"]) {
  test(`a ${phase} run on a retained bundle with nothing uploaded needs --local-publish and changes nothing`, () => {
    const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
    try {
      const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--phase", phase, "--execute", "--yes"], {
        cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /a local upload needs .*--local-publish/);
      assert.doesNotMatch(readFileSync(join(stateDir, "mutations.log"), "utf8"), /publish/);
      assert.doesNotMatch(result.stdout, /\$ git (tag|push)/);
      assert.doesNotMatch(result.stdout, /^\$ bash scripts\/ship-npm\.sh --publish-(prepared|candidate)/m);
      assert.equal(existsSync(join(fixture, "release-state/candidate-receipt.json")), false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("a retained bundle whose pair is already on npm resumes without --local-publish", () => {
  const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
  try {
    writeFileSync(join(stateDir, "protocol-exists"), "");
    writeFileSync(join(stateDir, "scout-exists"), "");
    const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--execute", "--yes"], {
      cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only" },
    });
    assert.equal(result.status, 0, result.stderr);
    const mutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.doesNotMatch(mutations, /^publish /m);
    assert.match(mutations, /^promote protocol/m);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("retrying an existing final release preserves its GitHub Latest state", () => {
  const { fixture } = createLocalReleaseFixture({ initialRelease: "final" });
  try {
    const result = spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--execute", "--yes", "--local-publish"], {
      cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only", SCOUT_NPM_LOCAL_PUBLISH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    // An existing stable release may be the verified native installer release;
    // the package publisher must not edit it, so it neither promotes nor demotes Latest.
    assert.equal(existsSync(join(fixture, "gh-release-calls.log")), false);
    assert.match(readFileSync(join(fixture, "gh-mutations.log"), "utf8"), /^upload$/m);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

function runCandidatePhase(fixture, phase, extraEnv = {}) {
  const local = phase === "promote" ? [] : ["--local-publish"];
  return spawnSync(process.execPath, ["scripts/ship-release.mjs", "0.2.99", "--phase", phase, "--execute", "--yes", ...local], {
    cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), NPM_TOKEN: "test-only", ...extraEnv },
  });
}

for (const phase of ["candidate", "promote"]) {
  test(`${phase} has an explicit local plan and requires confirmation`, () => {
    const result = plan(currentVersion, "--phase", phase);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Local ${phase} steps`));
    assert.match(result.stdout, /candidate-receipt\.json/);
    assert.doesNotMatch(result.stdout, /gh workflow run/);
    const execute = plan(currentVersion, "--phase", phase, "--execute");
    assert.notEqual(execute.status, 0);
    assert.match(execute.stderr, /without --yes/);
  });
}

test("candidate publication and explicit promotion reuse exact bytes and preserve both Latest channels until promotion", () => {
  const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
  try {
    const receiptBefore = readFileSync(join(fixture, "release-state/receipt.json"));
    const candidate = runCandidatePhase(fixture, "candidate");
    assert.equal(candidate.status, 0, candidate.stderr);
    const uploads = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.match(uploads, /publish protocol tag=scout-release-0-2-99[\s\S]*publish scout tag=scout-release-0-2-99/);
    assert.doesNotMatch(uploads, /promote|remove-stage/);
    for (const key of ["protocol", "scout"]) assert.equal(readFileSync(join(stateDir, `${key}-latest`), "utf8").trim(), "0.2.87");
    assert.equal(readFileSync(join(fixture, "gh-release-state"), "utf8").trim(), "false true");
    assert.match(readFileSync(join(fixture, "gh-release-calls.log"), "utf8"), /--prerelease --latest=false/);
    assert.equal(existsSync(join(fixture, "remote-receipt.json")), false);
    const markerPath = join(fixture, "release-state/candidate-receipt.json");
    const markerBytes = readFileSync(markerPath);
    const marker = JSON.parse(markerBytes);
    assert.equal(marker.kind, "scout-npm-candidate");
    assert.equal(marker.releaseState, "CANDIDATE");
    assert.equal(marker.releaseSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(marker.integrityReceiptSha256, createHash("sha256").update(receiptBefore).digest("hex"));
    assert.deepEqual(marker.packages, JSON.parse(receiptBefore).packages);
    assert.deepEqual(readFileSync(join(fixture, "remote-candidate-receipt.json")), markerBytes);
    const retry = runCandidatePhase(fixture, "candidate");
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), uploads);
    const defaultRelease = runCandidatePhase(fixture, "release");
    assert.notEqual(defaultRelease.status, 0);
    assert.match(defaultRelease.stderr, /explicit --phase promote/);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), uploads);
    const promote = runCandidatePhase(fixture, "promote");
    assert.equal(promote.status, 0, promote.stderr);
    const promotions = readFileSync(join(stateDir, "mutations.log"), "utf8").slice(uploads.length);
    assert.match(promotions, /promote protocol[\s\S]*promote scout/);
    assert.doesNotMatch(promotions, /publish/);
    assert.doesNotMatch(promote.stdout, /Building packages|--prepare\b|--publish-prepared/);
    assert.deepEqual(readFileSync(join(fixture, "release-state/receipt.json")), receiptBefore);
    assert.deepEqual(readFileSync(markerPath), markerBytes);
    assert.deepEqual(readFileSync(join(fixture, "remote-receipt.json")), receiptBefore);
    assert.equal(readFileSync(join(fixture, "gh-release-state"), "utf8").trim(), "false false");
    for (const call of readFileSync(join(fixture, "gh-release-calls.log"), "utf8").trim().split("\n")) assert.match(call, /--latest=false/);
    const promotedMutations = readFileSync(join(stateDir, "mutations.log"), "utf8");
    const repeated = runCandidatePhase(fixture, "promote");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), promotedMutations);
    const lateCandidate = runCandidatePhase(fixture, "candidate");
    assert.notEqual(lateCandidate.status, 0);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), promotedMutations);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

for (const conflict of ["local marker", "remote marker", "missing marker", "missing public marker", "retained tarball", "receipt source", "tag source", "partial pair", "newer latest", "staging tag"]) {
  test(`promotion holds ${conflict} without npm publish, rebuild or Latest mutation`, () => {
    const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
    try {
      const candidate = runCandidatePhase(fixture, "candidate");
      assert.equal(candidate.status, 0, candidate.stderr);
      const before = readFileSync(join(stateDir, "mutations.log"), "utf8");
      const marker = join(fixture, "release-state/candidate-receipt.json");
      const remoteMarker = join(fixture, "remote-candidate-receipt.json");
      const corrupt = file => { const data = readFileSync(file); data[0] = 0; writeFileSync(file, data); };
      let extraEnv = {};
      if (conflict === "local marker") corrupt(marker);
      if (conflict === "remote marker") corrupt(remoteMarker);
      if (conflict === "missing marker") rmSync(marker);
      if (conflict === "missing public marker") rmSync(remoteMarker);
      if (conflict === "retained tarball") corrupt(join(fixture, "release-state/openscout-scout-0.2.99.tgz"));
      if (conflict === "receipt source") {
        const receiptPath = join(fixture, "release-state/receipt.json");
        const receipt = JSON.parse(readFileSync(receiptPath)); receipt.releaseSha = "b".repeat(40); writeFileSync(receiptPath, JSON.stringify(receipt));
      }
      if (conflict === "tag source") {
        const git = join(fixture, "fake-bin/git");
        writeFileSync(git, readFileSync(git, "utf8").replace("printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      }
      if (conflict === "partial pair") rmSync(join(stateDir, "scout-exists"));
      if (conflict === "newer latest") for (const key of ["protocol", "scout"]) writeFileSync(join(stateDir, `${key}-latest`), "0.3.0\n");
      if (conflict === "staging tag") extraEnv.FIXTURE_STAGING_VALUE = "0.2.98";
      const result = runCandidatePhase(fixture, "promote", extraEnv);
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), before);
      assert.doesNotMatch(result.stdout, /Building packages/);
      assert.equal(readFileSync(join(fixture, "gh-release-state"), "utf8").trim(), "false true");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("interrupted candidate publication holds its protocol prefix and cannot auto-recover or promote", () => {
  const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
  try {
    const interrupted = runCandidatePhase(fixture, "candidate", { FIXTURE_SCOUT_PUBLISH_FAILURE: "1" });
    assert.notEqual(interrupted.status, 0);
    const before = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.match(before, /^publish protocol tag=scout-release-0-2-99\n$/);
    assert.equal(existsSync(join(fixture, "gh-release-state")), false);
    for (const phase of ["candidate", "promote", "release"]) {
      const retry = runCandidatePhase(fixture, phase);
      assert.notEqual(retry.status, 0);
      assert.match(retry.stderr, /incomplete npm package set/);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), before);
    }
    for (const key of ["protocol", "scout"]) assert.equal(readFileSync(join(stateDir, `${key}-latest`), "utf8").trim(), "0.2.87");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

for (const mode of ["--publish-candidate", "--verify-candidate", "--promote-prepared"]) {
  test(`${mode} rejects hosted execution before publication`, () => {
    const { fixture, stateDir } = createPublishFixture();
    try {
      const result = spawnSync("bash", ["scripts/ship-npm.sh", mode], { cwd: fixture, encoding: "utf8", env: { ...registryEnv(fixture), GITHUB_ACTIONS: "true" } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /local-only/);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("interrupted candidate asset handoff cannot be finalized through the default release command", () => {
  const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
  try {
    const interrupted = runCandidatePhase(fixture, "candidate", { FIXTURE_CANDIDATE_ASSET_FAILURE: "1" });
    assert.notEqual(interrupted.status, 0);
    const before = readFileSync(join(stateDir, "mutations.log"), "utf8");
    assert.doesNotMatch(before, /promote/);
    const ordinary = runCandidatePhase(fixture, "release");
    assert.notEqual(ordinary.status, 0);
    assert.match(ordinary.stderr, /explicit --phase promote/);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), before);
    const retry = runCandidatePhase(fixture, "candidate");
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), before);
    assert.equal(existsSync(join(fixture, "remote-candidate-receipt.json")), true);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("a public candidate marker holds default release when only the local marker is missing", () => {
  const { fixture, stateDir } = createLocalReleaseFixture({ initialRelease: "missing" });
  try {
    const candidate = runCandidatePhase(fixture, "candidate");
    assert.equal(candidate.status, 0, candidate.stderr);
    const markerPath = join(fixture, "release-state/candidate-receipt.json");
    const marker = readFileSync(markerPath);
    const npmBefore = readFileSync(join(stateDir, "mutations.log"), "utf8");
    const githubBefore = readFileSync(join(fixture, "gh-release-calls.log"), "utf8");
    const uploadsBefore = readFileSync(join(fixture, "gh-mutations.log"), "utf8");
    rmSync(markerPath);
    for (const phase of ["release", "promote"]) {
      const held = runCandidatePhase(fixture, phase);
      assert.notEqual(held.status, 0, held.stdout);
      assert.match(held.stderr, phase === "release" ? /explicit --phase promote/ : /Original candidate receipt is missing/);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), npmBefore);
      assert.equal(readFileSync(join(fixture, "gh-release-calls.log"), "utf8"), githubBefore);
      assert.equal(readFileSync(join(fixture, "gh-mutations.log"), "utf8"), uploadsBefore);
      assert.doesNotMatch(held.stdout, /Building packages|^\$ bash scripts\/ship-npm\.sh --prepare/m);
      assert.equal(readFileSync(join(fixture, "gh-release-state"), "utf8").trim(), "false true");
    }
    writeFileSync(markerPath, marker);
    const promoted = runCandidatePhase(fixture, "promote");
    assert.equal(promoted.status, 0, promoted.stderr);
    const completedNpm = readFileSync(join(stateDir, "mutations.log"), "utf8");
    const completedGithub = readFileSync(join(fixture, "gh-release-calls.log"), "utf8");
    const completedUploads = readFileSync(join(fixture, "gh-mutations.log"), "utf8");
    const stableRetry = runCandidatePhase(fixture, "release");
    assert.equal(stableRetry.status, 0, stableRetry.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), completedNpm);
    assert.equal(readFileSync(join(fixture, "gh-release-calls.log"), "utf8"), completedGithub);
    assert.equal(readFileSync(join(fixture, "gh-mutations.log"), "utf8"), completedUploads);
    assert.deepEqual(readFileSync(join(fixture, "remote-candidate-receipt.json")), marker);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

function createOriginalCandidateFixture() {
  const version = "0.3.3", source = "2fed47b16bba310fa90ad47196b3eb5e697ea152", tooling = "b".repeat(40);
  const state = createLocalReleaseFixture({ version, initialRelease: "missing" });
  const { fixture, stateDir } = state;
  copyFileSync(new URL("recover-local-npm-release.mjs", import.meta.url), join(fixture, "scripts/recover-local-npm-release.mjs"));
  const common = join(fixture, ".git"), bundle = join(common, "scout-release/npm", `${version}-${source}`);
  mkdirSync(bundle, { recursive: true });
  const triples = [];
  const names = ["@openscout/protocol", "@openscout/scout"];
  for (let i = 0; i < names.length; i++) {
    const stage = join(fixture, `original-package-${i}`);
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package/package.json"), JSON.stringify({ name: names[i], version, gitHead: source, repository: { url: "https://github.com/openscout-app/scout" } }));
    const file = join(bundle, `openscout-${names[i].split('/').at(-1)}-${version}.tgz`);
    const packed = spawnSync("tar", ["-czf", file, "-C", stage, "package"], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    triples.push(names[i], version, file);
    writeFileSync(join(stateDir, `${i ? 'scout' : 'protocol'}-exists`), "");
    writeFileSync(join(stateDir, `${i ? 'scout' : 'protocol'}-stage`), version);
  }
  const receiptPath = join(bundle, "receipt.json");
  const created = spawnSync(process.execPath, ["scripts/npm-release-receipt.mjs", "create", receiptPath, "https://github.com/openscout-app/scout", version, source, "local-signed", ...triples], { cwd: fixture, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const receipt = JSON.parse(readFileSync(receiptPath));
  const markerPath = join(bundle, "candidate-receipt.json");
  writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, kind: "scout-npm-candidate", releaseState: "CANDIDATE", repository: receipt.repository,
    releaseVersion: version, releaseSha: source, authority: "local-signed", provenance: "none", stagingTag: "scout-release-0-3-3",
    integrityReceiptSha256: digest(readFileSync(receiptPath)), packages: receipt.packages }, null, 2) + "\n");
  const sourceFiles = ["package.json", "packages/agent-sessions/package.json", "packages/cli/package.json", "packages/protocol/package.json", "packages/runtime/package.json", "packages/session-trace/package.json", "packages/pairing/package.json", "packages/cli/src/lib/shared/product.ts", "docs.json", "packages/cli/server.json", "bun.lock"];
  for (const file of sourceFiles) {
    const target = join(fixture, "original-tree", file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(fixture, file), target);
    // Tooling versions deliberately differ: retained identity comes from git show source.
    writeFileSync(join(fixture, file), readFileSync(join(fixture, file), "utf8").replaceAll(version, "0.4.0"));
  }
  writeFileSync(join(fixture, "fake-bin/git"), `#!/bin/bash
if [[ "$1" == "remote" ]]; then echo https://github.com/openscout-app/scout.git; exit 0; fi
if [[ "$1" == "status" ]]; then [[ ! -f '${fixture}/dirty' ]] || echo ' M source'; exit 0; fi
if [[ "$1" == "branch" ]]; then echo main; exit 0; fi
if [[ "$1" == "fetch" ]]; then exit 0; fi
if [[ "$1" == "merge-base" ]]; then [[ ! -f '${fixture}/nonancestor' ]]; exit $?; fi
if [[ "$1" == "show" ]]; then [[ "$2" == ${source}:* ]] || exit 90; cat '${fixture}/original-tree/'"\${2#*:}"; exit $?; fi
if [[ "$1" == "rev-parse" ]]; then
  for arg in "$@"; do [[ "$arg" != --git-common-dir ]] || { echo '${common}'; exit 0; }; done
  if [[ "$*" == *refs/tags/* ]]; then [[ ! -f '${fixture}/missing-tag' ]] || { echo 'fatal: needed a single revision' >&2; exit 1; }; echo ${source}; else echo ${tooling}; fi
  exit 0
fi
if [[ "$1" == "ls-remote" ]]; then
  printf '${tooling}\\trefs/heads/main\\n'
  [[ -f '${fixture}/missing-tag' ]] || printf '${source}\\trefs/tags/v${version}^{}\\n'
  exit 0
fi
echo "unexpected git mutation $*" >> '${fixture}/unexpected-git.log'; exit 99
`);
  writeFileSync(join(fixture, "fake-bin/npm"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const state=${JSON.stringify(stateDir)},bundle=${JSON.stringify(bundle)},version=${JSON.stringify(version)},source=${JSON.stringify(source)};
const names=['@openscout/protocol','@openscout/scout'],keys=['protocol','scout'];
const receipt=JSON.parse(fs.readFileSync(path.join(bundle,'receipt.json'))),a=process.argv.slice(2);
const print=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
const get=(key,suffix)=>fs.readFileSync(path.join(state,key+'-'+suffix),'utf8').trim();
if(a[0]==='whoami'){print('fixture-operator');process.exit(0);}
if(a[0]==='view'){
 const i=names.findIndex(n=>a[1]===n||a[1]===n+'@'+version),key=keys[i]; if(i<0)process.exit(91);
 if(a[2]==='dist-tags'){print({latest:get(key,'latest'),['scout-release-0-3-3']:get(key,'stage')});process.exit(0);}
 if(!fs.existsSync(path.join(state,key+'-exists'))){print({error:{code:'E404',summary:'No match found for version0.3.3'}});process.exit(1);}
 print({name:names[i],version,gitHead:source,repository:{url:'https://github.com/openscout-app/scout'},dist:{integrity:receipt.packages[i].integrity,tarball:'https://registry.npmjs.org/'+names[i]+'/-/'+key+'-'+version+'.tgz'}});process.exit(0);
}
fs.appendFileSync(path.join(state,'mutations.log'),a.join(' ')+'\\n');
if(a[0]==='dist-tag'&&a[1]==='add'){
 const i=names.findIndex(n=>a[2]===n+'@'+version); if(i<0||a[3]!=='latest')process.exit(92);
 fs.writeFileSync(path.join(state,keys[i]+'-latest'),version);
 if(i===0&&process.env.FIXTURE_NEWER_AFTER_FIRST_PROMOTION==='1')fs.writeFileSync(path.join(state,'scout-latest'),'0.4.0');
 process.exit(0);
}
process.exit(93);
`);
  writeFileSync(join(fixture, "fake-bin/curl"), `#!/bin/bash
for url in "$@"; do :; done
if [[ "$url" == https://registry.npmjs.org/* ]]; then
  for arg in "$@"; do [[ "$arg" != --location ]] || exit 94; done
  if [[ "$url" == */protocol/* ]]; then cat '${bundle}/openscout-protocol-${version}.tgz'; else cat '${bundle}/openscout-scout-${version}.tgz'; fi
  printf '\\n200'
else name=\${url##*/}; cat '${fixture}/remote-'"$name"; fi
`);
  for (const name of ["git", "npm", "curl"]) chmodSync(join(fixture, "fake-bin", name), 0o755);
  const identityArgs = ["--source", source, "--receipt-sha256", digest(readFileSync(receiptPath)), "--candidate-receipt-sha256", digest(readFileSync(markerPath))];
  const execute = (phase, extraEnv = {}, retained = true) => spawnSync(process.execPath, ["scripts/ship-release.mjs", version, "--phase", phase,
    ...(retained ? identityArgs : ["--local-publish"]), "--execute", "--yes", "--auth", "npm-login"], {
    cwd: fixture, encoding: "utf8", env: { ...process.env, PATH: join(fixture, "fake-bin") + ":" + process.env.PATH,
      NPM_TOKEN: "", NODE_AUTH_TOKEN: "", SCOUT_NPM_RELEASE_STATE_DIR: "", GITHUB_ACTIONS: "", ...extraEnv },
  });
  return { ...state, version, source, tooling, bundle, receiptPath, markerPath, identityArgs, execute };
}

test("retained candidate and promotion keep original2fed identity when reviewed tooling HEAD and versions are newer", () => {
  const f = createOriginalCandidateFixture();
  try {
    const receiptBefore = readFileSync(f.receiptPath), markerBefore = readFileSync(f.markerPath);
    const result = f.execute("candidate");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8"), "");
    assert.equal(existsSync(join(f.fixture, "unexpected-git.log")), false);
    assert.doesNotMatch(result.stdout, /ship-npm\.sh|--prepare|--publish-candidate|Building packages/);
    assert.match(readFileSync(join(f.fixture, "gh-release-calls.log"), "utf8"), /--prerelease --latest=false/);
    assert.deepEqual(readFileSync(join(f.fixture, "remote-candidate-receipt.json")), markerBefore);
    assert.equal(JSON.parse(markerBefore).releaseSha, f.source);
    assert.notEqual(f.source, f.tooling);
    for (const key of ["protocol", "scout"]) assert.equal(readFileSync(join(f.stateDir, key + "-latest"), "utf8"), "0.2.87");
    const promote = f.execute("promote");
    assert.equal(promote.status, 0, promote.stderr);
    const mutations = readFileSync(join(f.stateDir, "mutations.log"), "utf8");
    assert.equal(mutations.trim().split("\n").length, 2);
    assert.doesNotMatch(mutations, /publish/);
    assert.deepEqual(readFileSync(join(f.fixture, "remote-receipt.json")), receiptBefore);
    assert.deepEqual(readFileSync(f.markerPath), markerBefore);
    assert.equal(readFileSync(join(f.fixture, "gh-release-state"), "utf8").trim(), "false false");
    const again = f.execute("promote"); assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8"), mutations);
    for (const call of readFileSync(join(f.fixture, "gh-release-calls.log"), "utf8").trim().split("\n")) assert.match(call, /--latest=false/);
  } finally { rmSync(f.fixture, { recursive: true, force: true }); }
});

for (const conflict of ["partial pair", "missing marker", "receipt digest", "marker digest", "missing tag", "nonancestor", "source version", "state override"]) {
  test(`retained original candidate holds ${conflict} before release/npm mutation`, () => {
    const f = createOriginalCandidateFixture();
    try {
      let extra = {};
      if (conflict === "partial pair") rmSync(join(f.stateDir, "scout-exists"));
      if (conflict === "missing marker") rmSync(f.markerPath);
      if (conflict === "receipt digest") f.identityArgs[3] = "0".repeat(64);
      if (conflict === "marker digest") f.identityArgs[5] = "0".repeat(64);
      if (conflict === "missing tag") writeFileSync(join(f.fixture, "missing-tag"), "");
      if (conflict === "nonancestor") writeFileSync(join(f.fixture, "nonancestor"), "");
      if (conflict === "source version") writeFileSync(join(f.fixture, "original-tree/docs.json"), '{"version":"0.4.0"}');
      if (conflict === "state override") extra.SCOUT_NPM_RELEASE_STATE_DIR = f.bundle;
      const result = f.execute("candidate", extra);
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8"), "");
      assert.equal(existsSync(join(f.fixture, "gh-release-calls.log")), false);
      assert.equal(existsSync(join(f.fixture, "gh-mutations.log")), false);
    } finally { rmSync(f.fixture, { recursive: true, force: true }); }
  });
}

test("retained promotion rechecks newer Latest before each mutation", () => {
  const f = createOriginalCandidateFixture();
  try {
    const candidate = f.execute("candidate"); assert.equal(candidate.status, 0, candidate.stderr);
    const fail = f.execute("promote", { FIXTURE_NEWER_AFTER_FIRST_PROMOTION: "1" });
    assert.notEqual(fail.status, 0);
    assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8").trim().split("\n").length, 1);
    assert.equal(readFileSync(join(f.fixture, "gh-release-state"), "utf8").trim(), "false true");
  } finally { rmSync(f.fixture, { recursive: true, force: true }); }
});

for (const conflict of ["partial pair", "missing public marker", "changed public marker"]) {
  test(`retained promotion holds ${conflict} before any Latest mutation`, () => {
    const f = createOriginalCandidateFixture();
    try {
      const candidate = f.execute("candidate"); assert.equal(candidate.status, 0, candidate.stderr);
      const marker = join(f.fixture, "remote-candidate-receipt.json");
      if (conflict === "partial pair") rmSync(join(f.stateDir, "scout-exists"));
      if (conflict === "missing public marker") rmSync(marker);
      if (conflict === "changed public marker") writeFileSync(marker, readFileSync(marker).toString().replace('CANDIDATE', 'XANDIDATE'));
      const result = f.execute("promote");
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8"), "");
      assert.equal(readFileSync(join(f.fixture, "gh-release-state"), "utf8").trim(), "false true");
    } finally { rmSync(f.fixture, { recursive: true, force: true }); }
  });
}

test("default release and fresh candidate/promotion still require the current HEAD version tag", () => {
  const f = createOriginalCandidateFixture();
  try {
    for (const file of ["package.json", "packages/agent-sessions/package.json", "packages/cli/package.json", "packages/protocol/package.json", "packages/runtime/package.json", "packages/session-trace/package.json", "packages/pairing/package.json", "packages/cli/src/lib/shared/product.ts", "docs.json", "packages/cli/server.json", "bun.lock"]) {
      copyFileSync(join(f.fixture, "original-tree", file), join(f.fixture, file));
    }
    for (const phase of ["release", "candidate", "promote"]) {
      const result = f.execute(phase, {}, false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Local tag .* points to/);
      assert.equal(readFileSync(join(f.stateDir, "mutations.log"), "utf8"), "");
      assert.equal(existsSync(join(f.fixture, "gh-release-calls.log")), false);
    }
  } finally { rmSync(f.fixture, { recursive: true, force: true }); }
});

test("retained identity cannot be supplied incompletely or used for the default release phase", () => {
  const source = "a".repeat(40), digest = "b".repeat(64);
  for (const args of [["--phase", "candidate", "--source", source], ["--source", source, "--receipt-sha256", digest, "--candidate-receipt-sha256", digest]]) {
    const result = plan(currentVersion, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must all be supplied|only supported for explicit/);
  }
});

function devEnv(fixture) {
  return { ...registryEnv(fixture), GITHUB_ACTIONS: "true", NPM_TAG: "dev",
    GITHUB_REPOSITORY: "openscout-app/scout",
    GITHUB_WORKFLOW_REF: "openscout-app/scout/.github/workflows/release-package-npm.yml@refs/heads/main",
    NPM_TOKEN: "", NODE_AUTH_TOKEN: "", NPM_DIST_TAG_VERIFY_ATTEMPTS: "1", NPM_DIST_TAG_VERIFY_DELAY_SECONDS: "0" };
}

test("dev OIDC publishes both prerelease artifacts directly to dev and leaves latest unchanged", () => {
  const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.1", authority: "github-oidc", protocolLatest: "0.3.2", scoutLatest: "0.3.2" });
  try {
    for (const mode of ["--prepare", "--publish-prepared", "--verify-published", "--publish-prepared"]) {
      const r = spawnSync("bash", ["scripts/ship-npm.sh", mode], { cwd: fixture, encoding: "utf8", env: devEnv(fixture) });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\npublish scout tag=dev\n");
    for (const key of ["protocol", "scout"]) {
      assert.equal(readFileSync(join(stateDir, `${key}-latest`), "utf8"), "0.3.2");
      assert.equal(readFileSync(join(stateDir, `${key}-dev`), "utf8").trim(), "0.3.6-dev.1");
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("dev OIDC recovery resumes only exact protocol-first dev prefix", () => {
  const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.2", authority: "github-oidc" });
  try {
    const env = devEnv(fixture);
    let r = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], { cwd: fixture, encoding: "utf8", env: { ...env, FIXTURE_SCOUT_PUBLISH_FAILURE: "1" } });
    assert.notEqual(r.status, 0);
    r = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], { cwd: fixture, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\npublish scout tag=dev\n");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

for (const [label, version, overrides, priorDev] of [
  ["stable version", "0.3.6", {}, ""],
  ["prerelease to latest", "0.3.6-dev.1", { NPM_TAG: "latest" }, ""],
  ["unknown channel", "0.3.6-dev.1", { NPM_TAG: "beta" }, ""],
  ["local dev", "0.3.6-dev.1", { GITHUB_ACTIONS: "false" }, ""],
  ["dev rollback", "0.3.6-dev.1", {}, "0.3.6-dev.2"],
  ["historical prerelease", "0.2.90-dev.1", {}, ""],
]) {
  test(`dev fails closed: ${label}`, () => {
    const { fixture, stateDir } = createPublishFixture({ version, authority: "github-oidc" });
    try {
      for (const key of ["protocol", "scout"]) writeFileSync(join(stateDir, `${key}-dev`), priorDev);
      const r = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], { cwd: fixture, encoding: "utf8", env: { ...devEnv(fixture), ...overrides } });
      assert.notEqual(r.status, 0);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("workflow release target guard strictly pairs versions and channels", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release-package-npm.yml", import.meta.url), "utf8");
  const script = workflow.split("        run: |\n")[1].split("\n      - uses:")[0].split("\n").map(line => line.replace(/^          /, "")).join("\n");
  const output = join(mkdtempSync(join(tmpdir(), "scout-dev-guard.")), "output");
  try {
    for (const [tag, channel, valid] of [
      ["v0.3.6", "latest", true], ["v0.3.6-dev.1", "dev", true], ["v0.3.6-dev.0", "dev", true],
      ["v0.3.6-dev.1", "latest", false], ["v0.3.6", "dev", false], ["v0.3.6-beta.1", "dev", false],
      ["v0.3.6-dev.01", "dev", false], ["v0.3.6-dev.1", "beta", false], ["v0.2.90-dev.1", "dev", false],
    ]) {
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, INPUT_TAG: tag, INPUT_NPM_TAG: channel, INPUT_RECOVERY_RUN_ID: "", GITHUB_OUTPUT: output } });
      assert.equal(r.status === 0, valid, `${tag}/${channel}: ${r.stderr}`);
    }
    assert.match(workflow, /environment:\s*\n\s+name: Production/);
    assert.match(workflow, /release_sha.*DISPATCH_SHA/);
    assert.match(workflow, /merge-base --is-ancestor HEAD FETCH_HEAD/);
  } finally { rmSync(dirname(output), { recursive: true, force: true }); }
});

test("dev verification fails if stable latest changes during publication", () => {
  const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.1", authority: "github-oidc", protocolLatest: "0.3.2", scoutLatest: "0.3.2" });
  try {
    const r = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], { cwd: fixture, encoding: "utf8", env: { ...devEnv(fixture), FIXTURE_CHANGE_LATEST: "1" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /latest changed during dev publication/);
    assert.doesNotMatch(readFileSync(join(stateDir, "mutations.log"), "utf8"), /promote|tag=latest/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

for (const code of ["E404", "ECONNRESET", "E503"]) {
  test(`accepted upload tolerates ${code}, revalidates cache, and publishes only once`, () => {
    const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.1", authority: "github-oidc" });
    try {
      const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
        cwd: fixture, encoding: "utf8", env: { ...devEnv(fixture), NPM_DIST_TAG_VERIFY_ATTEMPTS: "3",
          FIXTURE_PROPAGATION_ERROR: code, FIXTURE_PROPAGATION_FAILURES: "2", npm_config_prefer_offline: "true" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout + result.stderr, code === "E404" ? /propagation pending/ : /transient registry read failure/);
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\npublish scout tag=dev\n");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

for (const code of ["E403", "E401", "UNRECOGNIZED", "WRONG_VERSION", "E404"]) {
  test(`accepted upload fails closed with ${code} and preserves exact recovery candidates`, () => {
    const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.1", authority: "github-oidc" });
    try {
      const env = { ...devEnv(fixture), NPM_DIST_TAG_VERIFY_ATTEMPTS: "3" };
      const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
        cwd: fixture, encoding: "utf8", env: { ...env, FIXTURE_PROPAGATION_ERROR: code, FIXTURE_PROPAGATION_FAILURES: "10" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, code === "WRONG_VERSION" ? /registry returned '9.9.9'/ : new RegExp(code + ": fixture registry diagnostic"));
      assert.equal(readFileSync(join(stateDir, "protocol-reads"), "utf8").trim(), code === "E404" ? "3" : "1");
      assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\n");
      assert.ok(existsSync(join(fixture, "release-state/receipt.json")));
      if (code === "E404") {
        assert.match(result.stderr, /3 attempts/);
        assert.match(result.stderr, /do not re-upload automatically/);
        const retry = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], { cwd: fixture, encoding: "utf8", env });
        assert.equal(retry.status, 0, retry.stderr);
        assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\npublish scout tag=dev\n");
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}

test("registry propagation wall-clock budget caps long configured poll delays", () => {
  const { fixture, stateDir } = createPublishFixture({ version: "0.3.6-dev.1", authority: "github-oidc" });
  try {
    const result = spawnSync("bash", ["scripts/ship-npm.sh", "--publish-prepared"], {
      cwd: fixture, encoding: "utf8", timeout: 10000,
      env: { ...devEnv(fixture), NPM_DIST_TAG_VERIFY_ATTEMPTS: "120", NPM_DIST_TAG_VERIFY_DELAY_SECONDS: "60",
        NPM_REGISTRY_VERIFY_TIMEOUT_SECONDS: "1", FIXTURE_PROPAGATION_ERROR: "E404", FIXTURE_PROPAGATION_FAILURES: "1000" },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not observable after publication \(1 attempts/);
    assert.equal(readFileSync(join(stateDir, "protocol-reads"), "utf8").trim(), "1");
    assert.equal(readFileSync(join(stateDir, "mutations.log"), "utf8"), "publish protocol tag=dev\n");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
