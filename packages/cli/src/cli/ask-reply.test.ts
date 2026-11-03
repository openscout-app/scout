import { expect, test } from "bun:test";
import { parseAskCommandOptions } from "./options.ts";
import { parseReplyCommandOptions } from "./commands/reply.ts";
import { removedScoutVerbError, REMOVED_SCOUT_VERBS } from "./removed-verbs.ts";
import { findScoutCommandRegistration } from "./registry.ts";
import { loadScoutCommandHandler } from "./commands/index.ts";

test.each([...REMOVED_SCOUT_VERBS])("removed %s is reserved and never reaches implicit ask", async verb => {
  expect(findScoutCommandRegistration(verb)).toBeDefined();
  const args = ["--to", "worker", "body with 'quotes' and $HOME; echo bad"];
  const error = removedScoutVerbError(verb, args)!;
  expect(error.message).toContain("Nothing was sent");
  expect(error.message).toContain("scout ask");
  expect(error.message).toContain("$HOME; echo bad");
  const handler = await loadScoutCommandHandler(verb);
  await expect(handler({} as any, args)).rejects.toThrow("was removed");
});

test("tell ref prints every interpretation without guessing or changing the payload", () => {
  const error = removedScoutVerbError("tell", ["--ref=inv-1", "result and spaces"])!;
  expect(error.message).toContain("scout reply --ref=inv-1 'result and spaces'");
  expect(error.message).toContain("scout reply --progress --ref=inv-1 'result and spaces'");
  expect(error.message).toContain("scout ask --ref=inv-1 'result and spaces'");
});
test("removed commands rewrite flags and preserve image/options", () => {
  expect(removedScoutVerbError("notify", ["--message", "down", "--image", "shot.png"])!.message)
    .toContain("scout ask --operator --fyi --notify down --image shot.png");
  expect(removedScoutVerbError("operator", ["--question", "Deploy?", "--option", "yes"])!.message)
    .toContain("scout ask --operator 'Deploy?' --option yes");
  expect(removedScoutVerbError("send", ["--tracked", "--to", "worker", "review"])!.message)
    .toContain("scout ask --to worker review");
});
test("strict parsing rejects unknown flags and accepts a literal flag after --", () => {
  expect(() => parseAskCommandOptions(["--to", "worker", "--message-file", "brief.md"], "/repo")).toThrow("unknown flag");
  expect(parseAskCommandOptions(["--to", "worker", "--", "--message-file"], "/repo").message).toBe("--message-file");
  expect(() => parseReplyCommandOptions(["--ref", "inv-1", "--typo", "done"])).toThrow("unknown flag");
});
test("repeated recipients are independent routes, not last-value-wins", () => {
  expect(parseAskCommandOptions(["--to", "a", "--to=b", "review"], "/repo").targets).toEqual(["a", "b"]);
  expect(() => parseAskCommandOptions(["--to", "a", "--ref", "inv-1", "review"], "/repo")).toThrow("exactly one");
});
test.each([
  ["--to", "a", "--notify", "review"],
  ["--operator", "--fyi", "--option", "yes", "review"],
  ["--channel", "shared", "review"],
  ["--ref", "inv-1", "--harness", "codex", "review"],
  ["--continue", "inv-1", "--continue-for", "parent", "review"],
  ["--fyi", "--project", "/repo", "review"],
  ["--operator", "--permission", "--default-action", "yes", "review"],
].map(args => [args]))("invalid ask flags %#", (args) => {
  expect(() => parseAskCommandOptions(args, "/repo")).toThrow();
});
test("reply is final by default; progress and failure stay typed and out of body", () => {
  expect(parseReplyCommandOptions(["--ref", "inv-1", "done"])).toMatchObject({ ref: "inv-1", body: "done" });
  expect(parseReplyCommandOptions(["--ref", "inv-1", "--progress", "testing"])).toMatchObject({ progress: true, body: "testing" });
  expect(parseReplyCommandOptions(["--ref", "inv-1", "--failed", "broken"])).toMatchObject({ failed: true, body: "broken" });
  expect(() => parseReplyCommandOptions(["--ref", "inv-1", "--progress", "--failed", "broken"])).toThrow();
  expect(() => parseReplyCommandOptions(["done"])).toThrow();
});

test("missing values do not consume another flag and implicit asks are strict too", async () => {
  for (const flag of ["--ref", "--harness", "--project", "--request-id"]) {
    expect(() => parseAskCommandOptions([flag, "--fyi", "news"], "/repo")).toThrow("value");
  }
  const { parseImplicitAskCommandOptions } = await import("./options.ts");
  expect(() => parseImplicitAskCommandOptions(["@worker", "--message-file", "brief.md"], "/repo")).toThrow("unknown flag");
  expect(() => parseImplicitAskCommandOptions(["--to", "worker", "--notify", "review"], "/repo")).toThrow("--notify now pushes");
});


test("successors on another host require an explicit project on that host", () => {
  expect(() => parseAskCommandOptions(["--continue", "inv-1", "--on", "peer", "review"], "/repo")).toThrow("needs --project");
  expect(parseAskCommandOptions(["--continue", "inv-1", "--on", "peer", "--project", "~/repo", "review"], "/repo").projectPath).toBe("~/repo");
});


test("speak tombstone explains that speech is controlled by the recipient device", () => {
  expect(removedScoutVerbError("speak", ["hello"])!.message).toContain("Sender-controlled speech was removed");
});
