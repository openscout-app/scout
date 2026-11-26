import { expect, test } from "bun:test";
import { parsePlay, renderPlay } from "./playbook.js";

const markdown = [
  "---", "name: report", 'description: "Write a report: Markdown."', "inputs:", "  path:", "  format: Markdown",
  "target:", "  project: ~/work", "  host: worker", "  harness: codex", "delivery: A {{format}} file.",
  "---", "Read {{path}}.", "---", "Summarize the findings.",
].join("\r\n");

test("fills YAML defaults, procedure and delivery once; remote paths belong to the target", () => {
  const play = parsePlay("report", markdown);
  expect(play.inputs).toEqual([{ name: "path", label: "Path", required: true, default: null },
    { name: "format", label: "Format", required: false, default: "Markdown" }]);
  const run = renderPlay(play, { path: "dir/{{format}} $1" }, { host: "other" }, "/local");
  expect(run.target).toEqual({ project: "~/work", host: "other", harness: "codex" });
  expect(run.body).toContain("Read dir/{{format}} $1.\n---\nSummarize the findings.");
  expect(run.body).toEndWith("Delivery: A Markdown file.");
  expect(() => parsePlay("another", markdown)).toThrow("name must match");
  expect(() => parsePlay("report", markdown.replace("  host:", "  hostname:"))).toThrow("hostname");
  expect(() => renderPlay(play, { path: "a", typo: "b" }, {}, "/local")).toThrow("typo");
  expect(() => renderPlay({ ...play, delivery: "{{typo}}" }, { path: "a" }, {}, "/local")).toThrow("typo");
});
