import { describe, expect, test } from "bun:test";

import {
  parseScoutComposerRoute,
  parseScoutComposerRouteTarget,
  SCOUT_COMPOSER_ROUTE_OPERATOR,
} from "./scout-composer.js";

describe("Scout composer route operator", () => {
  test("exports the route operator token", () => {
    expect(SCOUT_COMPOSER_ROUTE_OPERATOR).toBe(">>");
  });

  test("parses a leading agent route", () => {
    const result = parseScoutComposerRoute(">> hudson review the docs");

    expect(result.diagnostics).toEqual([]);
    expect(result.body).toBe("review the docs");
    expect(result.route?.target).toEqual({
      kind: "agent_label",
      label: "hudson",
      value: "hudson",
    });
  });

  test("parses an inline no-space agent route", () => {
    const result = parseScoutComposerRoute("please >>hudson#codex?5.5 take this");

    expect(result.body).toBe("please take this");
    expect(result.route?.token).toBe("hudson#codex?5.5");
    expect(result.route?.target).toEqual({
      kind: "agent_label",
      label: "hudson#codex?5.5",
      value: "hudson#codex?5.5",
    });
  });

  test("parses prefixed target kinds", () => {
    expect(parseScoutComposerRouteTarget("agent:hudson")).toEqual({
      kind: "agent_label",
      label: "hudson",
      value: "hudson",
    });
    expect(parseScoutComposerRouteTarget("alias:Review")).toEqual({
      kind: "route_alias",
      alias: "review",
      value: "alias:review",
    });
    expect(parseScoutComposerRouteTarget("review")).toEqual({
      kind: "agent_label",
      label: "review",
      value: "review",
    });
    expect(parseScoutComposerRouteTarget("target:mw-talkie")).toEqual({
      kind: "target_handle",
      handle: "mw-talkie",
      value: "target:mw-talkie",
    });
    expect(parseScoutComposerRouteTarget("⌖mw-talkie")).toEqual({
      kind: "target_handle",
      handle: "mw-talkie",
      value: "target:mw-talkie",
    });
    expect(parseScoutComposerRouteTarget("ref:8kj4pd")).toEqual({
      kind: "binding_ref",
      ref: "8kj4pd",
      value: "ref:8kj4pd",
    });
    expect(parseScoutComposerRouteTarget("project:/Users/guest/dev/talkie")).toEqual({
      kind: "project_path",
      projectPath: "/Users/guest/dev/talkie",
      value: "project:/Users/guest/dev/talkie",
    });
    expect(parseScoutComposerRouteTarget("id:agent-123")).toEqual({
      kind: "agent_id",
      agentId: "agent-123",
      value: "id:agent-123",
    });
    expect(parseScoutComposerRouteTarget("sid:session-123")).toEqual({
      kind: "session_id",
      sessionId: "session-123",
      value: "session:session-123",
    });
    expect(parseScoutComposerRouteTarget("session:codex:codex-native-123")).toEqual({
      kind: "session_id",
      sessionId: "codex-native-123",
      harness: "codex",
      value: "session:codex:codex-native-123",
    });
    expect(parseScoutComposerRouteTarget("session:grok-acp:grok-native-123")).toEqual({
      kind: "session_id",
      sessionId: "grok-native-123",
      harness: "grok-acp",
      value: "session:grok-acp:grok-native-123",
    });
    expect(parseScoutComposerRouteTarget("channel:ops")).toEqual({
      kind: "channel",
      channel: "ops",
      value: "channel:ops",
    });
    expect(parseScoutComposerRouteTarget("broadcast")).toEqual({
      kind: "broadcast",
      value: "broadcast",
    });
  });

  test("parses target handle shorthand routes", () => {
    const result = parseScoutComposerRoute("please >> ⌖mw-talkie continue here");

    expect(result.body).toBe("please continue here");
    expect(result.route?.target).toEqual({
      kind: "target_handle",
      handle: "mw-talkie",
      value: "target:mw-talkie",
    });
  });

  test("ignores non-standalone operators", () => {
    const result = parseScoutComposerRoute("a>>b is payload");

    expect(result.route).toBeNull();
    expect(result.body).toBe("a>>b is payload");
    expect(result.diagnostics).toEqual([]);
  });

  test("returns diagnostics for malformed route operators", () => {
    expect(parseScoutComposerRoute("please >>").diagnostics).toEqual([{
      code: "missing_target",
      message: "route operator requires a target after >>",
      start: 7,
      end: 9,
    }]);

    expect(parseScoutComposerRoute(">> @ please").diagnostics).toEqual([{
      code: "invalid_target",
      message: "invalid route target: @",
      start: 3,
      end: 4,
    }]);
  });
});
