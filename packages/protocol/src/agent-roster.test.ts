import { describe, expect, test } from "bun:test";

import {
  agentRosterTag,
  cleanHeldProjectCode,
  cleanProjectCode,
  parseRosterAddress,
  parseRosterNumber,
  projectCodeRefusal,
  rosterBoardCandidates,
  rosterCode,
  rosterIdentityMonogram,
  rosterLabel,
  rosterProjectCodeCandidates,
} from "./agent-roster.js";

describe("roster project codes", () => {
  test("default codes follow the apps' ident rule", () => {
    expect(rosterIdentityMonogram("openscout")).toBe("OS");
    expect(rosterIdentityMonogram("OpenScout")).toBe("OS");
    expect(rosterIdentityMonogram("peal-bach")).toBe("PB");
    expect(rosterIdentityMonogram("fabric-ops")).toBe("FO");
    expect(rosterIdentityMonogram("talkie")).toBe("TL");
    expect(rosterIdentityMonogram("")).toBe("AG");
    expect(rosterBoardCandidates("fabric-ops").slice(0, 3)).toEqual(["FO", "FB", "FR"]);
  });

  test("candidates start with the default and are all valid codes", () => {
    const candidates = rosterProjectCodeCandidates("openscout-labs");
    expect(candidates[0]).toBe("OL");
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every((code) => cleanProjectCode(code) === code)).toBe(true);
    expect(candidates.some((code) => code.length === 3)).toBe(true);
  });

  test("a code the operator or an import sets is two or three letters only", () => {
    expect(cleanProjectCode(" os ")).toBe("OS");
    expect(cleanProjectCode("pbx")).toBe("PBX");
    expect(cleanProjectCode("3t")).toBeNull();
    expect(cleanProjectCode("O5")).toBeNull();
    expect(cleanProjectCode("123")).toBeNull();
    expect(cleanProjectCode("O")).toBeNull();
    expect(cleanProjectCode("ABCD")).toBeNull();
    expect(cleanProjectCode("O-S")).toBeNull();
    expect(projectCodeRefusal("O5")).toBe('"O5" is not a project code: project codes are letters only, two or three of them');
    expect(projectCodeRefusal("P")).toBe('"P" is not a project code: use two or three letters');
  });

  test("only the apps' default can have a digit, and later candidates are letters only", () => {
    expect(rosterIdentityMonogram("app-2")).toBe("A2");
    expect(rosterIdentityMonogram("3d-tools")).toBe("3T");
    expect(parseRosterAddress("A2-003")).toEqual({ projectCode: "A2", number: 3 });
    const candidates = rosterProjectCodeCandidates("app-2");
    expect(candidates[0]).toBe("A2");
    expect(candidates.slice(1).every((code) => /^[A-Z]{2,3}$/u.test(code))).toBe(true);
    expect(cleanHeldProjectCode("a2")).toBe("A2");
    expect(cleanHeldProjectCode("12")).toBeNull();
  });
});

describe("roster addresses", () => {
  test("OS-003, os003, OS 003, @OS-003 and 003 parse", () => {
    expect(parseRosterAddress("OS-003")).toEqual({ projectCode: "OS", number: 3 });
    expect(parseRosterAddress("os003")).toEqual({ projectCode: "OS", number: 3 });
    expect(parseRosterAddress("OS 003")).toEqual({ projectCode: "OS", number: 3 });
    expect(parseRosterAddress("@OS-003")).toEqual({ projectCode: "OS", number: 3 });
    expect(parseRosterAddress("pbx-120")).toEqual({ projectCode: "PBX", number: 120 });
    expect(parseRosterAddress("003")).toEqual({ projectCode: null, number: 3 });
  });

  test("other text is not a roster address", () => {
    for (const text of ["03", "0003", "000", "OS-03", "123-003", "claude", "agent.os003", "", "  "]) {
      expect(parseRosterAddress(text)).toBeNull();
    }
  });

  test("formats codes and labels", () => {
    expect(rosterCode("OS", 3)).toBe("OS-003");
    expect(rosterLabel("OS", 3)).toBe("OS 003");
    expect(rosterCode(null, 42)).toBe("042");
    expect(agentRosterTag({ number: 7, projectCode: "PB" })).toEqual({
      number: 7,
      numberText: "007",
      projectCode: "PB",
      code: "PB-007",
      label: "PB 007",
    });
  });

  test("import numbers accept 3 and \"003\"", () => {
    expect(parseRosterNumber(3)).toBe(3);
    expect(parseRosterNumber("003")).toBe(3);
    expect(parseRosterNumber("0")).toBeNull();
    expect(parseRosterNumber("1000")).toBeNull();
    expect(parseRosterNumber(2.5)).toBeNull();
  });
});
