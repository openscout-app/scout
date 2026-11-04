import { describe, expect, test } from "bun:test";

import { renderScoutHelp } from "./help.ts";

describe("renderScoutHelp", () => {
  test("documents the operator loop, lifecycle, and routing model", () => {
    const help = renderScoutHelp("0.2.99", true);

    expect(help).toContain("Fast path:");
    expect(help).toContain("Orientation (only when route or sender is unclear):");
    expect(help).toContain("scout search index");
    expect(help).toContain("scout search query");
    expect(help).toContain("scout search status");
    expect(help).toContain("Lifecycle:");
    expect(help).toContain("one target -> DM");
    expect(help).toContain("independent task and receipt per target");
    expect(help).toContain("File-backed input:");
    expect(help).toContain("--prompt-file");
    expect(help).toContain("unknown flags are errors");
    expect(help).toContain("Project targets:");
    expect(help).toContain("scout ask --project ../talkie");
    expect(help).toContain("scout ask --harness codex");
    expect(help).toContain("broker chooses the worker");
    expect(help).toContain("reply --ref <task>");
    expect(help).toContain("Doctor flags:");
    expect(help).toContain("scout doctor --fix --yes");
    expect(help).toContain("scout providers usage");
    expect(help).toContain("scout providers map");
    expect(help).toContain("MCP parity:");
    expect(help).toContain("scout card create");
  });
});

 test("default help is short and points to command help and complete reference", () => {
  const help = renderScoutHelp("test");
  expect(help.split("\n").length).toBeLessThan(32);
  expect(help).toContain("scout help --detail");
  expect(help).toContain("scout <command> --help");
  expect(help).toContain("doctor");
  for (const detail of [false, true]) {
    const output = renderScoutHelp("test", detail);
    expect(output).toContain("https://openscout.app/install.md");
    expect(output).toContain("https://openscout.app/docs/quickstart");
    expect(output).toContain("Troubleshooting: scout doctor");
  }
});


test("news uses FYI and help never teaches positional recipients", () => {
  const help = renderScoutHelp(undefined, true);
  expect(help).toContain('scout ask --operator --fyi "Ready to review"');
  expect(help).not.toContain("scout @agent");
  expect(help).not.toContain("current ask state");
});
