import { describe, expect, test } from "bun:test";

import type { HerdrPaneProjection } from "@openscout/protocol";

import { herdrAttentionItem } from "./herdr-host-attention.ts";
import { answerHerdrPermission } from "./herdr-permission-answer.ts";

const BASH_PERMISSION = `
 Bash command

   bun test packages/web/server

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for this command
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend
`;

const OTHER_PERMISSION = BASH_PERMISSION.replace("bun test packages/web/server", "git push origin main");

const PANE = {
  paneId: "w1:p2",
  terminalId: "t-7",
  agent: "claude",
  agentStatus: "blocked",
  agentSession: { agent: "claude", value: "sess-1" },
  name: "openscout",
} as unknown as HerdrPaneProjection;

function deps(paneText: string, sent: Array<readonly string[]>) {
  return {
    readBlockedPanes: async () => [{ session: "scout", pane: PANE }],
    capture: async () => paneText,
    sendKeys: async (_session: string, _target: string, keys: readonly string[]) => { sent.push(keys); },
    audit: () => {},
    claim: () => true,
  };
}

describe("answerHerdrPermission", () => {
  const item = herdrAttentionItem("scout", PANE, BASH_PERMISSION, 0);

  test("a parsed permission dialog is offered with a version", () => {
    expect(item.id).toBe("herdr-permission:scout:w1:p2:sess-1");
    expect(item.version).toBeNumber();
    expect(item.detail).toBe("bun test packages/web/server");
  });

  test("approve presses the plain Yes, never don't-ask-again", async () => {
    const sent: Array<readonly string[]> = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      deps(BASH_PERMISSION, sent),
    );
    expect(result.ok).toBe(true);
    expect(sent).toEqual([["enter"]]);
  });

  test("success reports accepted keys without claiming or checking disappearance", async () => {
    const sent: Array<readonly string[]> = []; let captures = 0;
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      { ...deps(BASH_PERMISSION, sent), capture: async () => { captures++; return BASH_PERMISSION; } },
    );
    // The dialog deliberately remains present; this is a transport receipt only.
    expect(result).toEqual({ ok: true, keys: ["enter"], location: "Herdr scout · w1:p2",
      message: "Herdr accepted the keys. Scout has not checked that the prompt closed." });
    expect(captures).toBe(1); expect(sent).toEqual([["enter"]]);
    // Existing phone decoders still receive their ok/location/code/message fields.
    const wire = JSON.parse(JSON.stringify(result));
    expect({ ok: wire.ok, location: wire.location, code: wire.code, message: wire.message }).toEqual({
      ok: true, location: "Herdr scout · w1:p2", code: undefined,
      message: "Herdr accepted the keys. Scout has not checked that the prompt closed.",
    });
  });
  test("deny presses No", async () => {
    const sent: Array<readonly string[]> = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "deny" },
      deps(BASH_PERMISSION, sent),
    );
    expect(result.ok).toBe(true);
    expect(sent).toEqual([["3"]]);
  });

  test("a different prompt in the same pane is refused", async () => {
    const sent: Array<readonly string[]> = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      deps(OTHER_PERMISSION, sent),
    );
    expect(result).toMatchObject({ ok: false, code: "changed" });
    expect(sent).toEqual([]);
  });

  test("a prompt that was already answered is refused", async () => {
    const sent: Array<readonly string[]> = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      deps(`${BASH_PERMISSION}\n⏺ Bash(bun test packages/web/server)\n`, sent),
    );
    expect(result).toMatchObject({ ok: false, code: "changed" });
    expect(sent).toEqual([]);
  });

  test("a pane no longer blocked is refused", async () => {
    const sent: Array<readonly string[]> = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      { ...deps(BASH_PERMISSION, sent), readBlockedPanes: async () => [] },
    );
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(sent).toEqual([]);
  });

  test("keys go to the pane id, the target herdr's agent commands accept", async () => {
    const targets: string[] = [];
    const result = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      { ...deps(BASH_PERMISSION, []), sendKeys: async (_session: string, target: string) => { targets.push(target); } },
    );
    expect(result.ok).toBe(true);
    expect(targets).toEqual(["w1:p2"]);
  });

  test("a press that fails gives its claim back, so the next tap is answered", async () => {
    const held = new Set<string>();
    const claims = {
      claim: (key: string) => (held.has(key) ? false : (held.add(key), true)),
      release: (key: string) => { held.delete(key); },
    };
    const failing = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      { ...deps(BASH_PERMISSION, []), ...claims, sendKeys: async () => { throw new Error("agent_not_found"); } },
    );
    expect(failing).toMatchObject({ ok: false, code: "send_failed" });

    const sent: Array<readonly string[]> = [];
    const retry = await answerHerdrPermission(
      { itemId: item.id, version: item.version!, decision: "approve" },
      { ...deps(BASH_PERMISSION, sent), ...claims },
    );
    expect(retry.ok).toBe(true);
    expect(sent).toEqual([["enter"]]);
  });

  test("the next prompt in a pane isn't refused when herdr's read cuts off its command", async () => {
    // A visible read that starts below the "Bash command" header: the parser
    // falls back to the line above the question for both prompts.
    const clipped = (rule: string) => `
 Permission rule Bash(${rule}:*) requires confirmation for this command.
 /permissions to update rules

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
`;
    const held = new Set<string>();
    const claim = (key: string) => (held.has(key) ? false : (held.add(key), true));
    for (const rule of ["curl", "git"]) {
      const prompt = herdrAttentionItem("scout", PANE, clipped(rule), 0);
      const sent: Array<readonly string[]> = [];
      const result = await answerHerdrPermission(
        { itemId: prompt.id, version: prompt.version!, decision: "approve" },
        { ...deps(clipped(rule), sent), claim },
      );
      expect(result.ok).toBe(true);
      expect(sent).toEqual([["enter"]]);
    }
  });

  test("an unparsed blocked pane carries no version", () => {
    const blocked = herdrAttentionItem("scout", PANE, "Enter your name:", 0);
    expect(blocked.id.startsWith("herdr-blocked:")).toBe(true);
    expect(blocked.version).toBeNull();
  });
});
