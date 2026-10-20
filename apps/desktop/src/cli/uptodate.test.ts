import { describe, expect, test } from "bun:test";

import {
  canCompareBrokerBuildIdentity,
  extractBuildIdentityPartsFromScoutdPayload,
  extractBuildIdentityFromScoutdPayload,
  normalizeCliBinaryMtimeMs,
  resolveCurrentCliBuildIdentity,
  resolveCurrentCliBuildIdentityParts,
  shouldEnsureBrokerUptodateForCommand,
  shouldRestartBrokerForBuildIdentity,
} from "./uptodate.ts";

describe("CLI broker update check", () => {
  test("normalizes fractional mtimes before persisting", () => {
    expect(normalizeCliBinaryMtimeMs(1776614055986.6323)).toBe(1776614055986);
  });

  test("skips broker maintenance for stdio MCP startup", () => {
    expect(shouldEnsureBrokerUptodateForCommand("mcp")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("statusline")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("search")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("who")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("recent")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("check")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("where", ["index"])).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("hosts")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("whoami")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("extensions")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("web", ["install"])).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("report")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("feedback")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("ask")).toBe(true);
    expect(shouldEnsureBrokerUptodateForCommand(null)).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("doctor")).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("ask", ["--help"])).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("setup", ["-h"])).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("mesh", ["bridge", "--config", "/tmp/x.json"])).toBe(false);
    expect(shouldEnsureBrokerUptodateForCommand("mesh", ["status"])).toBe(true);
  });

  test("extracts native scoutd build identities from tolerant payload shapes", () => {
    expect(extractBuildIdentityFromScoutdPayload({ version: "0.2.73" })).toBe("0.2.73");
    expect(extractBuildIdentityFromScoutdPayload({ build: { appVersion: "0.2.74" } })).toBe("0.2.74");
    expect(extractBuildIdentityFromScoutdPayload({ status: { build: { identity: "sha:abc123" } } })).toBe(
      "sha:abc123",
    );
    expect(extractBuildIdentityFromScoutdPayload({
      scoutdVersion: "0.1.0",
      scoutdBuild: { name: "scoutd", version: "0.1.0" },
      health: { build: { packageName: "@openscout/runtime", version: "0.2.75" } },
    })).toBe("0.2.75");
    expect(extractBuildIdentityFromScoutdPayload({ status: { loaded: true } })).toBeNull();
  });

  test("uses explicit build identity comparison when both sides report it", () => {
    expect(shouldRestartBrokerForBuildIdentity("0.2.74", "0.2.73")).toBe(true);
    expect(shouldRestartBrokerForBuildIdentity("0.2.74", "0.2.74")).toBe(false);
    expect(shouldRestartBrokerForBuildIdentity("0.2.74", null)).toBe(false);
    expect(shouldRestartBrokerForBuildIdentity(
      { display: "build-a", packageName: null, version: "0.2.74", commit: null, buildId: "build-a" },
      { display: "build-b", packageName: null, version: "0.2.74", commit: null, buildId: "build-b" },
    )).toBe(true);
    expect(shouldRestartBrokerForBuildIdentity(
      { display: "0.2.74", packageName: null, version: "0.2.74", commit: null, buildId: null },
      { display: "build-b", packageName: null, version: "0.2.74", commit: null, buildId: "build-b" },
    )).toBe(false);
    expect(canCompareBrokerBuildIdentity(
      { display: "native-only", packageName: null, version: null, commit: null, buildId: null },
      { display: "other-native-only", packageName: null, version: null, commit: null, buildId: null },
    )).toBe(false);
  });

  test("resolves the current CLI identity from env before the fallback version", () => {
    expect(resolveCurrentCliBuildIdentity({ OPENSCOUT_BUILD_ID: "build-1" }, "0.2.74")).toBe("build-1");
    expect(resolveCurrentCliBuildIdentity({ SCOUT_APP_VERSION: "0.2.75" }, "0.2.74")).toBe("0.2.75");
    expect(resolveCurrentCliBuildIdentity({}, "0.2.74")).toBe("0.2.74");

    expect(resolveCurrentCliBuildIdentityParts(
      { OPENSCOUT_BUILD_ID: "build-1", SCOUT_APP_VERSION: "0.2.75" },
      "0.2.74",
    )).toMatchObject({ buildId: "build-1", version: "0.2.75" });
  });

  test("extracts comparable identity parts from broker health build data", () => {
    expect(extractBuildIdentityPartsFromScoutdPayload({
      status: {
        health: {
          build: {
            packageName: "@openscout/runtime",
            version: "0.2.76",
            buildId: "build-2",
          },
        },
      },
    })).toMatchObject({
      packageName: "@openscout/runtime",
      version: "0.2.76",
      buildId: "build-2",
    });
  });
});
