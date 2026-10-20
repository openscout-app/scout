import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { shouldEnsureBrokerUptodateForCommand } from "../uptodate.ts";
import { createScoutCommandContext } from "../context.ts";
import { parseMeshGuestsArgs, runMeshGuestsCommand } from "./mesh-guests.ts";

const future = Date.now() + 60_000;
const grantArgs = ["grant", "public-key", "--label", "guest", "--agent", "agent-a", "--expires-at", String(future)];

describe("guest grant arguments", () => {
  test("defaults to list and supports explicit list", () => {
    expect(parseMeshGuestsArgs([])).toEqual({ kind: "list" });
    expect(parseMeshGuestsArgs(["list"])).toEqual({ kind: "list" });
  });
  test("positional key, repeated agents, ISO expiry and stable request ID", () => {
    expect(parseMeshGuestsArgs([
      ...grantArgs, "--agent=agent-b", "--request-id=retry-1",
    ])).toEqual({ kind: "grant", body: {
      requestId: "retry-1", clientPublicKey: "public-key", label: "guest",
      allowedTargets: ["agent-a", "agent-b"], expiresAt: future,
    } });
    const command = parseMeshGuestsArgs(["grant", "--public-key=key", "--label=guest", "--agent=a", `--expires-at=${new Date(future).toISOString()}`]);
    expect(command.kind).toBe("grant");
    if (command.kind === "grant") {
      expect(command.body.expiresAt).toBe(future);
      expect(command.body.requestId).toMatch(/^[a-z0-9-]+$/);
    }
  });
  test("requires explicit scope, label and expiry; refuses ambiguous or unknown input", () => {
    for (const args of [
      ["grant"], grantArgs.slice(0, -2), [...grantArgs, "--public-key=other"],
      [...grantArgs, "--expires-at=0"], [...grantArgs, "--label=other"],
      [...grantArgs, "--tier=control"], [...grantArgs, "--request-id"],
      ["list", "extra"], ["list", "--all"], ["unknown"],
      ["grant", "key", "--label", "--agent", "a"],
      ["grant", "key", "--label=x", "--expires-at=9999999999999"],
    ]) expect(() => parseMeshGuestsArgs(args)).toThrow();
    expect(() => parseMeshGuestsArgs(["grant", "key", "--label=x", "--agent=a", "--expires-at=invalid"])).toThrow("future");
    expect(() => parseMeshGuestsArgs(["grant", "key", "--label=x", "--agent=a", "--expires-at=0"])).toThrow("future");
  });
  test("revoke takes exactly one grant ID or request ID", () => {
    expect(parseMeshGuestsArgs(["revoke", "gg_one"])).toEqual({ kind: "revoke", body: { grantId: "gg_one" } });
    expect(parseMeshGuestsArgs(["revoke", "--request-id=one"])).toEqual({ kind: "revoke", body: { requestId: "one" } });
    for (const args of [["revoke"], ["revoke", "one", "two"], ["revoke", "one", "--request-id=two"]]) {
      expect(() => parseMeshGuestsArgs(args)).toThrow();
    }
  });
});

function output(mode: "plain" | "json" = "json") {
  const lines: string[] = [];
  return { lines, context: createScoutCommandContext({ outputMode: mode, stdout: (line) => lines.push(line) }) };
}

test("help performs no network operation and production command has no runtime import", async () => {
  const out = output("plain");
  await runMeshGuestsCommand(out.context, ["--help"], { brokerUrl: "not-a-url" });
  expect(out.lines.join("\n")).toContain("--public-key");
  const source = readFileSync(new URL("./mesh-guests.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from ["'][^"']*(?:@openscout\/runtime|core\/)[^"']*["']/);
});

test("HTTP and connection errors preserve status, details and retry identity", async () => {
  for (const status of [400, 403, 404, 409, 503]) {
    const out = output();
    const fetchImpl = (async () => Response.json({ error: "denied", detail: "fixture denial" }, { status }));
    await expect(runMeshGuestsCommand(out.context, [...grantArgs, "--request-id=retry-1"], {
      brokerUrl: "http://127.0.0.1:1", fetchImpl,
    })).rejects.toThrow(`HTTP ${status}`);
    expect(out.lines).toEqual([]);
  }
  const fetchImpl = (async () => { throw new Error("connection refused"); });
  await expect(runMeshGuestsCommand(output().context, [...grantArgs, "--request-id=retry-1"], {
    brokerUrl: "http://127.0.0.1:1", fetchImpl,
  })).rejects.toThrow("--request-id retry-1");
});

test("guest commands never request runtime startup maintenance", () => {
  for (const action of ["list", "grant", "revoke"]) {
    expect(shouldEnsureBrokerUptodateForCommand("mesh", ["guests", action])).toBe(false);
  }
});
