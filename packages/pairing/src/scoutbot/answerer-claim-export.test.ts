import { expect, test } from "bun:test";
import * as direct from "./answerer-claim.ts";
import * as published from "@openscout/pairing/answerer-claim";

// A standalone answerer outside this package (a separately supervised
// assistant process) holds its claim through the package name, not a path.
test("the answerer claim is published under @openscout/pairing/answerer-claim", () => {
  expect(published.startAssistantAnswerer).toBe(direct.startAssistantAnswerer);
  expect(published.assistantClaimHeaders).toBe(direct.assistantClaimHeaders);
  expect(published.bindAssistantClaim).toBe(direct.bindAssistantClaim);
  // Outside an answerer's scope, a write is ordinary posting and carries no token.
  expect(published.assistantClaimHeaders()).toEqual({});
});
