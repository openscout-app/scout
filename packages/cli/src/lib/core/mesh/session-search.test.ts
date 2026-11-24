import { describe, expect, test } from "bun:test";
import type { NodeDefinition } from "@openscout/protocol";

import { searchSessionsOnMachine } from "./session-search.ts";

const here = { id: "here-openscout", name: "here", brokerUrl: "http://here:43110" } as NodeDefinition;
const mini = { id: "mini-openscout", name: "mini", brokerUrl: "http://mini:43110" } as NodeDefinition;
const ghost = { id: "mini-local-openscout", name: "mini", brokerUrl: "http://mini.local:43110" } as NodeDefinition;
const answer = (nodeId: string) => ({ nodeId, query: "needle", mode: "lexical", coverage: { kind: "warmed", spans: [], stale: false, staleAfterMs: 1 },
  searchedHours: null, hitCount: 1, hits: [{ title: "Remote session", snippet: "needle", facets: { harness: "codex" }, sourceRefs: [] }] });

function deps(peerFetch: (url: string, path: string) => Promise<Response>, nodes = [here, mini]) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      timeoutMs: 500,
      inventory: { localNode: here, knownNodes: Object.fromEntries(nodes.map((node) => [node.id, node])) },
      peerFetch: async (url: string, path: string) => { calls.push(`${url}${path}`); return peerFetch(url, path); },
      searchLocal: (input: { query: string }) => ({ query: input.query, mode: "lexical" as const, coverage: { kind: "empty_index" as const, suggestion: "" }, searchedHours: null, hitCount: 0, hits: [] }),
    },
  };
}

describe("cross-host session search", () => {
  test("asks the named host to search its own index and labels the answer with that host", async () => {
    const { deps: d, calls } = deps(async () => Response.json(answer(mini.id)));
    const result = await searchSessionsOnMachine("mini-openscout", { query: "needle", harness: ["codex"], hours: 48, limit: 5 }, d);
    expect(calls).toEqual(["http://mini:43110/v1/mesh/knowledge/search?q=needle&harness=codex&hours=48&limit=5"]);
    expect(result).toMatchObject({ nodeId: mini.id, nodeName: "mini", local: false, hitCount: 1 });
    expect(result.hits[0]!.title).toBe("Remote session");
  });

  test("answers the local host from its own index without a network hop", async () => {
    const { deps: d, calls } = deps(async () => { throw new Error("must not fetch"); });
    expect(await searchSessionsOnMachine("here", { query: "needle" }, d)).toMatchObject({ nodeId: here.id, local: true });
    expect(calls).toEqual([]);
  });

  test("refuses an ambiguous name and names the exact node ids", async () => {
    const { deps: d } = deps(async () => Response.json(answer(mini.id)), [here, mini, ghost]);
    await expect(searchSessionsOnMachine("mini", { query: "needle" }, d)).rejects.toThrow("use an exact node id: mini-openscout, mini-local-openscout");
  });

  test("rejects an answer from a different node, and says what an older peer lacks", async () => {
    const wrong = deps(async () => Response.json(answer("someone-else")));
    await expect(searchSessionsOnMachine("mini-openscout", { query: "needle" }, wrong.deps)).rejects.toThrow("identity mismatch");
    const old = deps(async () => Response.json({ error: "not_found" }, { status: 404 }));
    await expect(searchSessionsOnMachine("mini-openscout", { query: "needle" }, old.deps)).rejects.toThrow("predates cross-host search");
    const gated = deps(async () => Response.json({ error: "forbidden", detail: "route is local-only" }, { status: 403 }));
    await expect(searchSessionsOnMachine("mini-openscout", { query: "needle" }, gated.deps)).rejects.toThrow("predates cross-host search");
  });
});
