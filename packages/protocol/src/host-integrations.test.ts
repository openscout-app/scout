import { describe, expect, test } from "bun:test";

import { AGENT_HARNESSES } from "./actors.js";
import {
  scoutHostIntegrationById,
  scoutHostIntegrationHasRole,
} from "./host-integrations.js";

describe("Scout host integration catalog", () => {
  test("represents T3 as an orchestrator host with its execution provider kept separate", () => {
    const t3 = scoutHostIntegrationById("t3-orchestrator");
    expect(t3).toBeTruthy();
    expect(t3?.harness).toBeUndefined();
    expect(AGENT_HARNESSES).not.toContain("t3-orchestrator");
    expect(t3 && scoutHostIntegrationHasRole(t3, "orchestrator")).toBe(true);
    expect(t3 && scoutHostIntegrationHasRole(t3, "agent_state_surface")).toBe(true);
    expect(t3 && scoutHostIntegrationHasRole(t3, "execution_harness")).toBe(false);
  });

  test("keeps Hermes and Herdr first-class without making them harnesses", () => {
    const hermes = scoutHostIntegrationById("hermes");
    const herdr = scoutHostIntegrationById("herdr");

    expect(hermes).toBeTruthy();
    expect(herdr).toBeTruthy();
    expect(hermes?.harness).toBeUndefined();
    expect(herdr?.harness).toBeUndefined();
    expect(AGENT_HARNESSES).not.toContain("hermes");
    expect(AGENT_HARNESSES).not.toContain("herdr");
    expect(hermes && scoutHostIntegrationHasRole(hermes, "mcp_host")).toBe(
      true,
    );
    expect(herdr && scoutHostIntegrationHasRole(herdr, "terminal_host")).toBe(
      true,
    );
    expect(
      herdr && scoutHostIntegrationHasRole(herdr, "agent_state_surface"),
    ).toBe(true);
  });
});
