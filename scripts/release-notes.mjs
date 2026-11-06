#!/usr/bin/env node
// Prints the GitHub release notes for one version from docs/releases.md.
//
//   node scripts/release-notes.mjs <version> [path/to/releases.md]
//
// A version's section runs from its "## <version> <name>" heading to the next
// "## " heading. Its subheadings become the release's headings, and links
// relative to docs/ point at that tag on GitHub. openscout.app shows the first
// "* " bullet as the release's headline and leaves out a release without one,
// so each section starts its "### What's changed" list with that bullet.
// Exits 1 when the file has no section for the version.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPOSITORY = "openscout-app/scout";

export function releaseNotes(markdown, version) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim()
    .replace(/^### /gm, "## ")
    .replace(/\]\(\.\/([^)\s]+)\)/g, `](https://github.com/${REPOSITORY}/blob/v${version}/docs/$1)`);
  return body + "\n";
}

// The line openscout.app shows for the release, or null when there is none.
export function releaseHeadline(notes) {
  const line = notes.split("\n").find((entry) => entry.startsWith("* "));
  return line ? line.slice(2).trim() : null;
}

// Every version that has a section, newest first, as the file lists them.
export function releaseVersions(markdown) {
  return [...markdown.matchAll(/^## (\d+\.\d+\.\d+\S*)(?: |$)/gm)].map((match) => match[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, file = fileURLToPath(new URL("../docs/releases.md", import.meta.url))] = process.argv.slice(2);
  if (!version) {
    console.error("Usage: node scripts/release-notes.mjs <version> [path/to/releases.md]");
    process.exit(2);
  }
  const notes = releaseNotes(readFileSync(file, "utf8"), version.replace(/^v/, ""));
  if (!notes) {
    console.error(`docs/releases.md has no section for ${version}.`);
    process.exit(1);
  }
  if (!releaseHeadline(notes)) {
    console.error(`The ${version} notes have no "* " bullet, so openscout.app will not list the release.`);
  }
  process.stdout.write(notes);
}
