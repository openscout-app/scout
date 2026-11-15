import { describe, expect, test } from "bun:test";
import type { ObserveData, ObserveEvent } from "../../lib/types.ts";
import { displayPath, resolveUpdatePath, splitBeats, tidyMarkdown, toArticle, toSessionUpdate } from "./agents-feed-article.ts";

describe("toArticle", () => {
  test("a structured report: status headline, sections, file and link lines", () => {
    const article = toArticle([
      "[ask:f-abc] DONE — Workflow Planner study landed in the studio.",
      "",
      "LOCATION",
      "  design/studio/views/workflow-planner.tsx        (view, ~1.8k lines)",
      "  design/studio/lib/studio-pages.ts               (registry entry)",
      "",
      "PREVIEW",
      "  http://127.0.0.1:43140/studies/workflow-planner  (dev server already up)",
    ].join("\n"));
    expect(article.headline).toBe("DONE — Workflow Planner study landed in the studio.");
    expect(article.body.map((b) => b.kind)).toEqual(["heading", "file", "file", "heading", "link"]);
    expect(article.body[1]).toEqual({ kind: "file", path: "design/studio/views/workflow-planner.tsx", note: "view, ~1.8k lines" });
    expect(article.body[4]).toEqual({ kind: "link", url: "http://127.0.0.1:43140/studies/workflow-planner", note: "dev server already up" });
    expect(article.files).toEqual([]);
    expect(article.links).toEqual(["http://127.0.0.1:43140/studies/workflow-planner"]);
  });

  test("a streamed reply: beats split back, narration folded into notes", () => {
    const article = toArticle(
      "I'll review the draft as an editorial pass only.Hold this for one revision. The voice is already right.The argument is not supported yet.",
    );
    expect(article.notes).toEqual(["I'll review the draft as an editorial pass only."]);
    expect(article.headline).toBe("Hold this for one revision.");
    expect(article.body).toEqual([{ kind: "para", text: "The voice is already right. The argument is not supported yet." }]);
  });

  test("only narration so far: the promise is the headline", () => {
    const article = toArticle("I'll research Grok Bot dispatch from the local docs.");
    expect(article.headline).toBe("I'll research Grok Bot dispatch from the local docs.");
    expect(article.notes).toEqual([]);
  });

  test("files named in prose are collected; tmp scratch paths are not", () => {
    const article = toArticle(
      "Changed only docs/learn-07-handoffs.md and packages/web/client/app.tsx. Full report: /private/tmp/x/review.md",
    );
    expect(article.files).toEqual(["docs/learn-07-handoffs.md", "packages/web/client/app.tsx"]);
  });
});

describe("splitBeats", () => {
  test("does not split version numbers or abbreviations", () => {
    expect(splitBeats("Bumped to 0.12.0 today. Next step is QA.")).toEqual(["Bumped to 0.12.0 today. Next step is QA."]);
  });
});

describe("paths", () => {
  test("relative paths resolve against the workspace root", () => {
    expect(resolveUpdatePath("design/a.tsx", "/Users/you/dev/openscout/")).toBe("/Users/you/dev/openscout/design/a.tsx");
    expect(resolveUpdatePath("/abs/b.ts", null)).toBe("/abs/b.ts");
    expect(resolveUpdatePath("~/c.ts", "/r")).toBeNull();
    expect(resolveUpdatePath("d.ts", null)).toBeNull();
  });
  test("display folds the home directory", () => {
    expect(displayPath("/Users/you/dev/x.ts")).toBe("~/dev/x.ts");
  });
});

describe("toSessionUpdate", () => {
  const events = [
    { id: "m1", t: 1, at: 1_000, kind: "message", text: "Looked at the feed first." },
    { id: "t1", t: 2, at: 2_000, kind: "tool", text: "", tool: "bash", arg: "rg -n feed\nsecond line" },
    { id: "k1", t: 3, at: 2_500, kind: "think", text: "hmm" },
    { id: "t2", t: 4, at: 3_000, kind: "tool", text: "", tool: "edit", arg: "AgentsFeedDetail.tsx" },
    { id: "m2", t: 5, at: 4_000, kind: "message", text: "Every row opens the panel now." },
    { id: "t3", t: 6, at: 5_000, kind: "tool", text: "", tool: "bash", arg: "bun test" },
    { id: "m3", t: 7, at: 9_000, kind: "message", text: "Tests pass." },
  ] as const;
  const data = {
    events: events as unknown as ObserveEvent[],
    files: [
      { path: "/repo/a.ts", state: "modified", touches: 2, lastT: 4 },
      { path: "/repo/b.ts", state: "created", touches: 1, lastT: 6 },
      { path: "/repo/c.ts", state: "read", touches: 1, lastT: 2 },
      { path: "/private/tmp/x.png", state: "created", touches: 1, lastT: 5 },
    ],
    metadata: {
      session: { gitBranch: "main", turnCount: 12 },
      usage: { contextInputTokens: 150_000, contextWindowTokens: 1_000_000 },
    },
  } as ObserveData;

  test("reads the message behind the post, with the steps that produced it", () => {
    const update = toSessionUpdate(data, 4_000)!;
    expect(update.text).toBe("Every row opens the panel now.");
    expect(update.steps).toEqual([
      { id: "t1", tool: "bash", arg: "rg -n feed" },
      { id: "t2", tool: "edit", arg: "AgentsFeedDetail.tsx" },
    ]);
    expect(update.stepCount).toBe(2);
    expect(update.earlier.map((m) => m.id)).toEqual(["m1"]);
  });

  test("lists changed files newest first, skips scratch, counts reads, states facts", () => {
    const update = toSessionUpdate(data, 4_000)!;
    expect(update.changed).toEqual(["/repo/b.ts", "/repo/a.ts"]);
    expect(update.readCount).toBe(1);
    expect(update.facts).toEqual(["branch main", "12 turns", "15% context"]);
  });

  test("takes the nearest message in time, and null without one", () => {
    expect(toSessionUpdate(data, 8_000)!.text).toBe("Tests pass.");
    expect(toSessionUpdate(data, 600)!.text).toBe("Looked at the feed first.");
    expect(toSessionUpdate({ events: [], files: [] }, 0)).toBeNull();
  });
});

describe("tidyMarkdown", () => {
  test("drops inline marks and splits list items into paragraphs", () => {
    const text = "Checked [our submission](https://x.dev/pull/1):\n- **Open**, still a `draft`.\n1. Next step";
    expect(tidyMarkdown(text)).toBe("Checked our submission:\n\nOpen, still a draft.\n\n1. Next step");
  });

  test("an article keeps the link while the prose loses the markup", () => {
    const article = toArticle("**Done** — see [the PR](https://github.com/a/b/pull/9).");
    expect(article.headline).toBe("Done — see the PR.");
    expect(article.links).toEqual(["https://github.com/a/b/pull/9"]);
  });
});
