import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const workflow = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
test('only stable npm publication records a Production deployment while dev retains signing access', () => {
  assert.match(workflow('release-package-npm'), /environment:\s+name: Production\s+#.*\n\s+deployment: \$\{\{ inputs.npm_tag == 'latest' \}\}/);
});
test('production reconciliation is manual, read-only and verifies before reporting success', () => {
  const source = workflow('verify-production-release');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /permissions:\s+contents: read/);
  assert.match(source, /group: release-package-npm/);
  assert.ok(source.indexOf('Verify stable release identity') < source.indexOf('Install verified package'));
  assert.ok(source.indexOf('Recheck stable pointers') < source.indexOf('Retain production verification'));
  assert.match(source, /--ignore-scripts/);
  assert.doesNotMatch(source, /npm publish|dist-tag add|deployments: write|id-token: write/);
});
test('TUI-created dev releases are prereleases, stable releases are not', () => {
  const source = workflow('release-scout-tui');
  const snippet = source.slice(source.indexOf('            prerelease=(--prerelease=false)'), source.indexOf('\n          fi', source.indexOf('            prerelease=(--prerelease=false)')));
  for (const [version, prerelease] of [['0.3.8', false], ['0.3.6-dev.3', true]]) {
    const result = spawnSync('bash', ['-c', `set -euo pipefail; gh() { printf '%s\\n' "$@"; }; VERSION="$1"; TAG="v$1"; GITHUB_REPOSITORY=openscout-app/scout; ${snippet}`, '--', version], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n').includes('--prerelease'), prerelease);
    assert.ok(result.stdout.includes('--latest=false'));
  }
});
test('MCP Registry publication lists stable releases only, through GitHub OIDC and a pinned publisher', () => {
  const source = workflow('publish-mcp-registry');
  assert.match(source, /release:\s+types: \[released\]/);
  assert.match(source, /permissions:\s+contents: read\s+id-token: write/);
  assert.match(source, /!github\.event\.release\.prerelease/);
  assert.match(source, /mcp-publisher login github-oidc/);
  assert.match(source, /MCP_PUBLISHER_SHA256: "[0-9a-f]{64}"/);
  assert.match(source, /sha256sum -c -/);
  assert.doesNotMatch(source, /secrets\./);
  assert.ok(source.indexOf('Wait for the npm package') < source.indexOf('Publish to the MCP Registry'));
  const start = source.indexOf('          if [[ ! "$TAG"');
  const snippet = source.slice(start, source.indexOf('>> "$GITHUB_OUTPUT"\n\n', start) + '>> "$GITHUB_OUTPUT"'.length);
  const dir = mkdtempSync(join(tmpdir(), 'scout-registry-workflow.'));
  try {
    const cases = [
      ['v0.4.3', 'released', true], ['v1.0.0', 'released', true],
      ['v0.4.3', 'a prerelease', false], ['v0.4.3', 'a draft', false], ['v0.4.3', 'missing', false],
      ['v0.4.3', 'error', 'fail'],
      ['v0.4.3-dev.1', 'released', false], ['0.4.3', 'released', false], ['v0.4', 'released', false],
    ];
    for (const [tag, state, publish] of cases) {
      const output = join(dir, `${tag}-${state}`);
      // gh reports a missing release as "release not found"; any other error must fail the run.
      const gh = `gh() { case "$STATE" in missing) echo 'release not found' >&2; return 1;; error) echo 'HTTP 401: Bad credentials' >&2; return 1;; esac; printf '%s\\n' "$STATE"; }`;
      const result = spawnSync('bash', ['-c', `set -euo pipefail; ${gh}; TAG="$1"; STATE="$2"; GITHUB_OUTPUT="$3"; GITHUB_REPOSITORY=openscout-app/scout; ${snippet}`, '--', tag, state, output], { encoding: 'utf8' });
      if (publish === 'fail') {
        assert.notEqual(result.status, 0, `${tag} ${state}`);
        assert.match(result.stderr, /Could not read the GitHub release for v0\.4\.3/);
        assert.equal(existsSync(output) && readFileSync(output, 'utf8').includes('publish='), false);
        continue;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8').includes('publish=true'), publish, `${tag} ${state}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('the hosted release path dispatches the MCP Registry listing for stable versions', () => {
  const source = workflow('release-scout-tui');
  const job = source.slice(source.indexOf('\n  publish:'));
  assert.match(job, /permissions:\s+actions: write\s+contents: write/);
  const step = job.slice(job.indexOf('- name: List the release in the MCP Registry'));
  assert.match(step, /if: \$\{\{ !contains\(needs\.resolve\.outputs\.version, '-'\) \}\}/);
  assert.match(step, /gh workflow run publish-mcp-registry\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f tag="\$TAG"/);
});
