import { describe, expect, test } from "bun:test";

import {
  applyContinuationModelGuess,
  claudePermissionFloor,
  classifyContinuationRisk,
  decideContinuation,
  decideContinuationWithModel,
  parseContinuationDialog,
  parseContinuationModelGuess,
  sameContinuationDecision,
} from "./continuation.js";

const BASH_PERMISSION = `
 Bash command

   bun test packages/web/server

 Permission rule Bash(bun:*) requires confirmation for this command.
 /permissions to update rules

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for this command
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

const CURL_PERMISSION = `
 Bash command

   curl -sS -o probe.html https://example.com

 Permission rule Bash(curl:*) requires confirmation for this command.

 Do you want to proceed?
   1. Yes
 ❯ 2. No

 Esc to cancel   Tab to amend
`;

const HOLD = `
• Bash git push origin gh-pages
 auto mode held this action
 Classifier: public remote would publish .env contents
`;

describe("parseContinuationDialog", () => {
  test("parses a live Claude bash permission prompt", () => {
    const dialog = parseContinuationDialog(BASH_PERMISSION);
    expect(dialog).toMatchObject({
      kind: "permission",
      live: true,
      command: "bun test packages/web/server",
      permissionRule: "Bash(bun:*)",
    });
    expect(dialog.options.map((option) => [option.index, option.kind, option.selected])).toEqual([
      [1, "allow", true],
      [2, "allow_always", false],
      [3, "deny", false],
    ]);
  });

  test("ignores a prompt once Claude keeps working under it", () => {
    expect(parseContinuationDialog(`${BASH_PERMISSION}\n⏺ Read(src/model.ts)\n  ⎿ Read 20 lines`).live)
      .toBe(false);
  });

  test("ignores a prompt once the composer is back", () => {
    expect(parseContinuationDialog(`${BASH_PERMISSION}\n❯ `).live).toBe(false);
  });

  test("classifies a classifier hold as live hold, not a Yes/No", () => {
    expect(parseContinuationDialog(HOLD)).toMatchObject({
      kind: "hold",
      live: true,
    });
  });

  test("parses an Antigravity TUI sandbox-bypass approval prompt", () => {
    const agyPrompt = [
      "Run command",
      "  gh pr create --repo arach/scout --base main",
      "Confirm the command is safe to run outside of the sandbox with full network and disk access.",
      "Proceed?",
      "❯ 1. Yes",
      "  2. Yes, and always allow access to 'gh pr create'",
      "  3. No",
      "  Esc to cancel",
    ].join("\n");
    const dialog = parseContinuationDialog(agyPrompt);
    expect(dialog).toMatchObject({
      kind: "permission",
      live: true,
    });
    expect(dialog.options.map((option) => [option.index, option.kind, option.selected])).toEqual([
      [1, "allow", true],
      [2, "allow_always", false],
      [3, "deny", false],
    ]);
  });
});

describe("classifyContinuationRisk", () => {
  test("sorts local tests from network, publish, and destruction", () => {
    expect(classifyContinuationRisk("bun test packages/web/server")).toBe("workspace");
    expect(classifyContinuationRisk("curl https://example.com")).toBe("network");
    expect(classifyContinuationRisk("git push origin main")).toBe("publish");
    expect(classifyContinuationRisk("rm -rf /tmp/build")).toBe("destructive");
    expect(classifyContinuationRisk("cat .env")).toBe("secrets");
  });
});

describe("decideContinuation", () => {
  test("workspace continues in-repo tests and would send the Yes option, not don't-ask-again", () => {
    expect(decideContinuation({ paneBody: BASH_PERMISSION, policy: "workspace" })).toMatchObject({
      act: "continue",
      keys: ["enter"],
      risk: "workspace",
      source: "rules",
    });
  });

  test("workspace notifies on network and does not send keys", () => {
    expect(decideContinuation({ paneBody: CURL_PERMISSION, policy: "workspace" })).toMatchObject({
      act: "notify",
      keys: null,
      risk: "network",
    });
  });

  test("unattended would continue network by sending the Yes index, not the selected No", () => {
    expect(decideContinuation({ paneBody: CURL_PERMISSION, policy: "unattended" })).toMatchObject({
      act: "continue",
      keys: ["1"],
      risk: "network",
    });
  });

  test("ask notifies even boring workspace commands", () => {
    expect(decideContinuation({ paneBody: BASH_PERMISSION, policy: "ask" }).act).toBe("notify");
  });

  test("fail-closed notifies on unknown screens", () => {
    expect(decideContinuation({ paneBody: "thinking…\n", policy: "silent" })).toMatchObject({
      act: "notify",
      live: false,
      reason: "no live dialog",
    });
  });

  test("never continues a classifier hold", () => {
    expect(decideContinuation({ paneBody: HOLD, policy: "silent" }).act).toBe("notify");
  });

  test("maps levels onto Claude permission floors without treating bypass as a promise", () => {
    expect(claudePermissionFloor("ask")).toBe("default");
    expect(claudePermissionFloor("workspace")).toBe("acceptEdits");
    expect(claudePermissionFloor("unattended")).toBe("auto");
    expect(claudePermissionFloor("silent")).toBe("bypassPermissions");
  });

  test("refuses to treat a swapped command as the same decision", () => {
    const bunTest = decideContinuation({ paneBody: BASH_PERMISSION, policy: "workspace" });
    const curl = decideContinuation({ paneBody: CURL_PERMISSION, policy: "workspace" });
    expect(sameContinuationDecision(bunTest, bunTest)).toBe(true);
    expect(sameContinuationDecision(bunTest, curl)).toBe(false);
  });
});

const UNPARSED = `
 Do you want to proceed?

 Esc to cancel · Tab to amend
`;

const UNPARSED_MENU = `
 Bash command

   bun test packages/web/server

 Do you want to proceed?
 ❯ 1) Yes
   2) No

 Esc to cancel · Tab to amend
`;

describe("continuation model fallback", () => {
  test("parses a strict JSON guess and rejects junk", () => {
    expect(parseContinuationModelGuess({
      kind: "permission",
      command: "bun test",
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "yes/no",
    })).toMatchObject({ kind: "permission", allowIndex: 1, confidence: "high" });
    expect(parseContinuationModelGuess({ kind: "nope", risk: "workspace", confidence: "high" })).toBeNull();
    expect(parseContinuationModelGuess("not json")).toBeNull();
  });

  test("high-confidence permission with an allow index continues through policy", () => {
    const rules = decideContinuation({ paneBody: UNPARSED_MENU, policy: "workspace" });
    expect(rules).toMatchObject({ act: "notify", reason: "unparsed dialog" });
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "bun test packages/web/server",
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "yes",
    }, UNPARSED_MENU)).toMatchObject({
      act: "continue",
      keys: ["1"],
      source: "model",
      risk: "workspace",
    });
  });

  test("never continues a low-confidence or non-permission guess", () => {
    const rules = decideContinuation({ paneBody: UNPARSED, policy: "workspace" });
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "bun test",
      risk: "workspace",
      allowIndex: 1,
      confidence: "low",
      reason: "maybe",
    }).act).toBe("notify");
    expect(applyContinuationModelGuess(rules, {
      kind: "question",
      command: null,
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "ask",
    }).act).toBe("notify");
  });

  test("model still cannot continue a network command at workspace level", () => {
    const rules = decideContinuation({ paneBody: UNPARSED, policy: "workspace" });
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "curl https://example.com",
      risk: "network",
      allowIndex: 1,
      confidence: "high",
      reason: "curl",
    })).toMatchObject({
      act: "notify",
      keys: null,
      source: "model",
    });
  });

  test("skips the model when rules already decided", async () => {
    let called = 0;
    const verdict = await decideContinuationWithModel({
      paneBody: BASH_PERMISSION,
      policy: "workspace",
      model: async () => {
        called += 1;
        return null;
      },
    });
    expect(called).toBe(0);
    expect(verdict.source).toBe("rules");
    expect(verdict.act).toBe("continue");
  });

  test("fail-closes when the model throws", async () => {
    const verdict = await decideContinuationWithModel({
      paneBody: UNPARSED,
      policy: "workspace",
      model: async () => {
        throw new Error("timeout");
      },
    });
    expect(verdict).toMatchObject({ act: "notify", source: "model", reason: "model unavailable" });
  });
});

describe("adversarial review regressions", () => {
  test("a multi-line command is inexact and never continues", () => {
    const pane = `
 Bash command

   echo ok
   rm -rf /tmp/victim

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel
`;
    const verdict = decideContinuation({ paneBody: pane, policy: "silent" });
    expect(verdict).toMatchObject({ act: "notify", risk: "unknown", keys: null });
    expect(verdict.command).toContain("rm -rf");
  });

  test("changing a later line of the command is a different decision", () => {
    const one = decideContinuation({ paneBody: BASH_PERMISSION.replace("bun test packages/web/server", "bun test a\n   echo 1"), policy: "workspace" });
    const two = decideContinuation({ paneBody: BASH_PERMISSION.replace("bun test packages/web/server", "bun test a\n   rm x"), policy: "workspace" });
    expect(sameContinuationDecision(one, two)).toBe(false);
  });

  test("unknown and out-of-tree commands are unknown, not workspace", () => {
    for (const command of [
      "rm -f /tmp/victim",
      "git -C /tmp/other push origin main",
      "echo overwrite > /tmp/outside-project",
      "cat /etc/passwd",
      "bun test ../other-repo",
      "python3 script.py",
      "bun test $(whoami)",
      "bun test; echo hi",
    ]) {
      expect(classifyContinuationRisk(command)).not.toBe("workspace");
    }
    const pane = BASH_PERMISSION.replace("bun test packages/web/server", "echo overwrite > /tmp/outside-project");
    expect(decideContinuation({ paneBody: pane, policy: "silent" }).act).toBe("notify");
  });

  test("options from an earlier dialog never pick the live one's answer", () => {
    const pane = `
 Do you want to proceed?
 ❯ 1. Yes
   2. No

 ⏺ Bash(bun test)
   ⎿ ok

 Bash command

   bun test packages/web/server

 Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and don't ask again for this command
   3. No

 Esc to cancel
`;
    const verdict = decideContinuation({ paneBody: pane, policy: "workspace" });
    expect(verdict.act).toBe("continue");
    // Cursor is on don't-ask-again, so the Yes option is chosen by number.
    expect(verdict.keys).toEqual(["1"]);
  });

  test("the model cannot name a command that is not on screen", () => {
    const rules = decideContinuation({ paneBody: UNPARSED_MENU, policy: "workspace" });
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "bun test",
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "yes",
    }, UNPARSED_MENU).act).toBe("notify");
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "bun test packages/web/server",
      risk: "workspace",
      allowIndex: 2,
      confidence: "high",
      reason: "yes",
    }, UNPARSED_MENU).act).toBe("notify");
  });

  test("second review: quoting, expansion, comments and URLs never widen risk", () => {
    for (const command of [
      'cat "/etc/passwd"',
      "cat '/etc/passwd'",
      'cat "$HOME/private.txt"',
      "cat $HOME/private.txt",
      "rm -f victim # https://example.com",
      "rm -f victim https://example.com",
      "python3 -c print https://example.com",
    ]) {
      expect(classifyContinuationRisk(command)).not.toBe("workspace");
      expect(classifyContinuationRisk(command)).not.toBe("network");
    }
    expect(classifyContinuationRisk("curl -sS https://example.com")).toBe("network");
    expect(classifyContinuationRisk("curl -o /tmp/x https://example.com")).toBe("unknown");
  });

  test("second review: the model cannot match a partial or historical command", () => {
    const multi = `
 Bash command

   bun test
   rm -rf /tmp/victim

 Do you want to proceed?
 ❯ 1) Yes
   2) No

 Esc to cancel
`;
    const rules = decideContinuation({ paneBody: multi, policy: "workspace" });
    expect(applyContinuationModelGuess(rules, {
      kind: "permission",
      command: "bun test",
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "yes",
    }, multi).act).toBe("notify");

    const historical = `
 Bash command

   bun test

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 ⏺ Bash(bun test)
   ⎿ ok

 Bash command

   rm -f victim

 Do you want to proceed?
 ❯ 1) Yes
   2) No

 Esc to cancel
`;
    const historicalRules = decideContinuation({ paneBody: historical, policy: "workspace" });
    expect(applyContinuationModelGuess(historicalRules, {
      kind: "permission",
      command: "bun test",
      risk: "workspace",
      allowIndex: 1,
      confidence: "high",
      reason: "yes",
    }, historical).act).toBe("notify");
  });

  test("third review: a historical permission rule cannot name the live command", () => {
    const pane = `
 Bash command

   bun test

 Permission rule Bash(bun:*) requires confirmation for this command.

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel

 ⏺ Bash(bun test)
   ⎿ ok

 Bash command

   rm -rf victim

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel
`;
    const verdict = decideContinuation({ paneBody: pane, policy: "silent" });
    expect(verdict.command).toBe("rm -rf victim");
    expect(verdict.act).toBe("notify");
    // Same shape without the markers above the live header.
    const noHeader = pane.replace(/\n Bash command\n\n   rm -rf victim\n/u, "\n   rm -rf victim\n");
    expect(decideContinuation({ paneBody: noHeader, policy: "silent" }).act).toBe("notify");
  });

  test("third review: brace and glob expansion are unknown", () => {
    for (const command of ["cat {,/}etc/passwd", "cat [/]etc/passwd", "ls !$"]) {
      expect(classifyContinuationRisk(command)).toBe("unknown");
    }
  });
});
