import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseHeadline, releaseNotes, releaseVersions } from './release-notes.mjs';

const docs = readFileSync(new URL('../docs/releases.md', import.meta.url), 'utf8');

// openscout.app lists a release under "Recently shipped" only when its notes
// have a "* " bullet, and it shows that bullet's first line as plain text.
const HEADLINE_FROM = [0, 5, 1];
const atLeast = (version, floor) => {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== floor[i]) return parts[i] > floor[i];
  return true;
};

test('a version section becomes the release notes', () => {
  const markdown = [
    '## Prepare and review', '', 'Not a release.', '',
    '## 1.2.3 a name', '', 'One paragraph.', '', '### What\'s changed', '',
    '* Add the thing', '* Fix the other thing', '', '### Details', '',
    '- See [the guide](./guide.md).', '',
    '## 1.2.2 earlier', '', 'Old.',
  ].join('\n');
  const notes = releaseNotes(markdown, '1.2.3');
  assert.equal(notes, [
    'One paragraph.', '', '## What\'s changed', '',
    '* Add the thing', '* Fix the other thing', '', '## Details', '',
    '- See [the guide](https://github.com/openscout-app/scout/blob/v1.2.3/docs/guide.md).', '',
  ].join('\n'));
  assert.equal(releaseHeadline(notes), 'Add the thing');
  assert.equal(releaseNotes(markdown, '1.2'), null);
  assert.equal(releaseNotes(markdown, '9.9.9'), null);
  assert.deepEqual(releaseVersions(markdown), ['1.2.3', '1.2.2']);
});

test('every release from 0.5.1 on has a headline the site can show', () => {
  const versions = releaseVersions(docs).filter((version) => atLeast(version, HEADLINE_FROM));
  assert.ok(versions.includes('0.5.1'));
  for (const version of versions) {
    const notes = releaseNotes(docs, version);
    const lines = notes.split('\n');
    const index = lines.findIndex((line) => line.startsWith('* '));
    assert.ok(index >= 0, `${version} has no "* " bullet`);
    const headline = lines[index].slice(2).trim();
    assert.ok(!/^\s+\S/.test(lines[index + 1] ?? ''), `${version}: keep the headline bullet on one line`);
    assert.ok(headline.length <= 72, `${version}: the headline is ${headline.length} characters`);
    assert.ok(!/[`*_]|\p{Extended_Pictographic}/u.test(headline), `${version}: the headline shows as plain text`);
  }
});
