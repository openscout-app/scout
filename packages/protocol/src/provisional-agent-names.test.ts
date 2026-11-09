import { describe, expect, test } from "bun:test";

import {
  allocateProvisionalAgentName,
  collectOccupiedDefinitionIds,
  definitionIdFromOccupancyKey,
  isProvisionalAgentName,
  parseProvisionalAgentNamesJson,
  parseProvisionalAgentNamesText,
  provisionalAgentNameStartIndexForSeed,
  PROVISIONAL_AGENT_NAMES,
} from "./provisional-agent-names.js";

describe("provisional agent names", () => {
  test("recognizes pool members", () => {
    expect(isProvisionalAgentName("feynman")).toBe(true);
    expect(isProvisionalAgentName("@Darwin")).toBe(true);
    expect(isProvisionalAgentName("openscout")).toBe(false);
  });

  test("extracts definition ids from qualified agent ids", () => {
    expect(definitionIdFromOccupancyKey("feynman.main.mini")).toBe("feynman");
    expect(definitionIdFromOccupancyKey("@mozart.harness:codex")).toBe("mozart");
    expect(definitionIdFromOccupancyKey("openscout-card-abc12345")).toBe("openscout-card-abc12345");
  });

  test("allocates the first free pool name", () => {
    const occupied = collectOccupiedDefinitionIds([
      "darwin.main.mini",
      "@newton",
    ]);
    const name = allocateProvisionalAgentName(occupied);
    expect(name).not.toBe("darwin");
    expect(name).not.toBe("newton");
    expect(POSITIONAL_AGENT_NAMES.has(name)).toBe(true);
  });

  test("falls back to suffixed pool names when the pool is full", () => {
    const occupied = new Set<string>(PROVISIONAL_AGENT_NAMES);
    expect(allocateProvisionalAgentName(occupied, { startIndex: 0 })).toBe(
      `${PROVISIONAL_AGENT_NAMES[0]}-2`,
    );
  });

  test("allocates from a custom pool when provided", () => {
    const occupied = new Set(["ada"]);
    expect(allocateProvisionalAgentName(occupied, { pool: ["ada", "grace"] })).toBe("grace");
  });

  test("derives a deterministic pool offset from caller, receiver, and index seeds", () => {
    const seed = ["operator", "/Users/you/dev/openscout", "codex", 3];
    const first = provisionalAgentNameStartIndexForSeed(seed);
    expect(provisionalAgentNameStartIndexForSeed(seed)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(PROVISIONAL_AGENT_NAMES.length);

    const offsets = new Set(
      Array.from({ length: 8 }, (_, index) =>
        provisionalAgentNameStartIndexForSeed([
          "operator",
          "/Users/you/dev/openscout",
          "codex",
          index,
        ])
      ),
    );
    expect(offsets.size).toBeGreaterThan(1);
  });

  test("distributes project-session seed offsets across the name pool", () => {
    const sampleCount = PROVISIONAL_AGENT_NAMES.length * 20;
    const counts = new Map<string, number>();
    for (let index = 0; index < sampleCount; index += 1) {
      const name = PROVISIONAL_AGENT_NAMES[provisionalAgentNameStartIndexForSeed([
        "cardless-project-session",
        "operator",
        "/Users/you/dev/openscout",
        "codex",
        index,
      ])]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    const average = sampleCount / PROVISIONAL_AGENT_NAMES.length;
    const max = Math.max(...counts.values());
    expect(counts.size).toBe(PROVISIONAL_AGENT_NAMES.length);
    expect(counts.get("archimedes") ?? 0).toBeLessThan(average * 2);
    expect(max).toBeLessThanOrEqual(Math.ceil(average * 2));
  });

  test("parses json pool blobs", () => {
    expect(parseProvisionalAgentNamesText("# team\nada\n@grace\n")).toEqual(["ada", "grace"]);
    expect(parseProvisionalAgentNamesJson('["linus", "ada"]')).toEqual(["linus", "ada"]);
    expect(parseProvisionalAgentNamesJson('{"names":["curie","feynman"]}')).toEqual([
      "curie",
      "feynman",
    ]);
  });
});

const POSITIONAL_AGENT_NAMES = new Set<string>(PROVISIONAL_AGENT_NAMES);
