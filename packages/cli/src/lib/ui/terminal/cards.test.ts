import { describe, expect, test } from "bun:test";

import type { ScoutAgentCard } from "@openscout/protocol";

import { formatScoutAgentCardContact, renderScoutAgentCard } from "./cards.ts";

function makeCard(overrides: Partial<ScoutAgentCard> = {}): ScoutAgentCard {
  return {
    id: "usetalkie-brand.brand-refresh-v1.mini",
    agentId: "usetalkie-brand.brand-refresh-v1.mini",
    definitionId: "usetalkie-brand",
    displayName: "Usetalkie Brand",
    handle: "usetalkie-brand",
    selector: "@usetalkie-brand.brand-refresh-v1.node:mini",
    defaultSelector: "@usetalkie-brand",
    projectRoot: "/Users/guest/dev/usetalkie.com",
    currentDirectory: "/Users/guest/dev/usetalkie.com",
    harness: "claude",
    transport: "tmux",
    sessionId: "relay-usetalkie-brand-copy-humanize-ideas-blog-mini-claude",
    branch: "brand/refresh-v1",
    createdAt: 1_000,
    brokerRegistered: true,
    inboxConversationId: "dm.arach.usetalkie-brand.brand-refresh-v1.mini",
    returnAddress: {
      actorId: "usetalkie-brand.brand-refresh-v1.mini",
      handle: "usetalkie-brand",
      selector: "@usetalkie-brand.brand-refresh-v1.node:mini",
      defaultSelector: "@usetalkie-brand",
      conversationId: "dm.arach.usetalkie-brand.brand-refresh-v1.mini",
    },
    ...overrides,
  };
}

describe("renderScoutAgentCard", () => {
  test("leads with a compact contact reference", () => {
    const card = makeCard();

    expect(formatScoutAgentCardContact(card)).toBe("@usetalkie-brand.eshv1");
    expect(renderScoutAgentCard(card).split("\n").slice(0, 4)).toEqual([
      "Usetalkie Brand",
      "Contact: @usetalkie-brand.eshv1",
      "Agent: usetalkie-brand.brand-refresh-v1.mini",
      "Project: /Users/guest/dev/usetalkie.com",
    ]);
  });

  test("falls back to the session id when no branch qualifier is available", () => {
    expect(formatScoutAgentCardContact(makeCard({
      selector: undefined,
      branch: undefined,
      sessionId: "session-ref-ABC123DEF456",
    }))).toBe("@usetalkie-brand.ef456");
  });
});
