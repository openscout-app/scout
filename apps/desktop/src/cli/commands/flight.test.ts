import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import {
  buildFlightLinks,
  parseFlightCommandOptions,
  renderFlightCommandHelp,
  renderFlightCommandResult,
  runFlightCommand,
} from "./flight.ts";

describe("renderFlightCommandHelp", () => {
  test("documents get and wait follow-up commands", () => {
    const help = renderFlightCommandHelp();

    expect(help).toContain("Usage: scout flight <command>");
    expect(help).toContain("get <flightId>");
    expect(help).toContain("wait <flightId> [--timeout <sec>]");
  });
});

describe("parseFlightCommandOptions", () => {
  test("parses wait timeout locally", () => {
    expect(parseFlightCommandOptions(["wait", "flight-1", "--timeout", "45"])).toEqual({
      command: "wait",
      flightId: "flight-1",
      timeoutSeconds: 45,
    });
  });

  test("rejects timeout on get", () => {
    expect(() => parseFlightCommandOptions(["get", "flight-1", "--timeout", "1"]))
      .toThrow("flight get does not accept --timeout");
  });
});

describe("renderFlightCommandResult", () => {
  test("renders state, output, and follow handles plainly", () => {
    const output = renderFlightCommandResult({
      flightId: "flight-1",
      found: true,
      timedOut: false,
      terminal: true,
      flight: {
        id: "flight-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        state: "completed",
        summary: "Hudson replied.",
        output: "Done.",
      },
      output: "Done.",
      summary: "Hudson replied.",
      error: null,
      follow: {
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main",
        bindingRef: "flight-1",
        conversationId: "dm.operator.hudson",
        messageId: "msg-1",
        workId: null,
        sessionId: null,
        links: {
          work: null,
          follow: "http://scout.test/follow?flightId=flight-1",
          tail: "http://scout.test/follow?flightId=flight-1",
          session: null,
          agent: "http://scout.test/agents/hudson.main?tab=message",
        },
      },
      nextAction: null,
    });

    expect(output).toContain("Flight: flight-1");
    expect(output).toContain("State: completed");
    expect(output).toContain("Target: hudson.main");
    expect(output).toContain("Conversation: dm.operator.hudson");
    expect(output).toContain("Output:\nDone.");
    expect(output).toContain("Follow the task: http://scout.test/follow?flightId=flight-1");
  });
});

describe("task sharing links", () => {
  const env = { OPENSCOUT_WEB_PUBLIC_ORIGIN: "https://scout.test/" };
  test("work ticket wins over session and tail, preserving the configured origin", () => {
    const links = buildFlightLinks({ workId: "work/a b", flightId: "flt-1", sessionId: "session-1" }, env);
    expect(links.follow).toBe("https://scout.test/work/work%2Fa%20b");
    expect(links.work).toBe(links.follow);
    expect(new URL(links.tail!).searchParams.get("view")).toBe("tail");
    expect(new URL(links.tail!).searchParams.get("workId")).toBe("work/a b");
  });
  test("missing work falls back to session observation without inventing a ticket", () => {
    const links = buildFlightLinks({ flightId: "flt-1" }, env);
    expect(links.work).toBeNull();
    expect(links.follow).toBe(links.session);
    expect(buildFlightLinks({}, env).follow).toBeNull();
  });
});

describe("runFlightCommand", () => {
  test("prints namespace help", async () => {
    const stdout: string[] = [];
    const context = createScoutCommandContext({
      stdout: (line) => stdout.push(line),
    });

    await runFlightCommand(context, []);

    expect(stdout.join("\n")).toContain("Usage: scout flight <command>");
  });

  test("prints subcommand help", async () => {
    const stdout: string[] = [];
    const context = createScoutCommandContext({
      stdout: (line) => stdout.push(line),
    });

    await runFlightCommand(context, ["wait", "--help"]);

    expect(stdout.join("\n")).toContain("Usage: scout flight wait <flightId>");
    expect(stdout.join("\n")).toContain("On timeout, Scout prints the latest known state");
  });
});

test("cancel accepts one flight and no wait timeout", () => {
  expect(parseFlightCommandOptions(["cancel", "flight-queued"])).toEqual({ command: "cancel", flightId: "flight-queued" });
  expect(() => parseFlightCommandOptions(["cancel", "flight-queued", "--timeout", "10"])).toThrow("does not accept --timeout");
  expect(() => parseFlightCommandOptions(["cancel"])).toThrow("requires <flightId>");
});
