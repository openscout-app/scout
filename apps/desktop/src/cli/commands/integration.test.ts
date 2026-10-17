import { afterEach, expect, test } from "bun:test";
import { createScoutCommandContext } from "../context.ts";
import { INTEGRATION_HELP, parseIntegrationCommand, runIntegrationCommand } from "./integration.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("T3 commands use only the broker-configured connection and preserve opaque source selectors", () => {
  expect(parseIntegrationCommand(["t3", "inspect", "--connection", "local"], "/work")).toEqual({
    path: "/v1/integrations/t3/inspect", body: { connectionId: "local" },
  });
  for (const command of ["board", "refresh"]) {
    expect(parseIntegrationCommand(["t3", command, "--connection", "local", "--project", "../opaque/source id"], "/work")).toEqual({
      path: `/v1/integrations/t3/${command}`, body: { connectionId: "local", projectId: "../opaque/source id" },
    });
  }
  expect(parseIntegrationCommand(["t3", "attach", "--connection", "remote", "--thread", "thread/雪?1"], "/work")).toEqual({
    path: "/v1/integrations/t3/attach", body: { connectionId: "remote", threadId: "thread/雪?1" },
  });
  expect(parseIntegrationCommand(["t3", "run", "--connection", "local", "--project", "project-1", "--card", "card-1", "--request-id", "request-1"], "/work")).toEqual({
    path: "/v1/integrations/t3/run", body: { connectionId: "local", projectId: "project-1", cardId: "card-1", requestId: "request-1" },
  });
});

test("T3 rejects incomplete, duplicate, credential, URL, and unrelated options before IO", () => {
  for (const args of [
    ["t3"], ["t3", "run"], ["t3", "inspect"], ["t3", "inspect", "--connection"],
    ["t3", "inspect", "--connection", "  "],
    ["t3", "attach", "--connection", "local"],
    ["t3", "board", "--connection", "local"],
    ["t3", "refresh", "--connection", "local"],
    ["t3", "run", "--connection", "local", "--project", "project-1"],
    ["t3", "run", "--connection", "local", "--project", "project-1", "--card", "card-1"],
    ["t3", "inspect", "--connection", "a", "--connection", "b"],
    ["t3", "inspect", "--connection", "a", "--token", "credential"],
    ["t3", "inspect", "--connection", "a", "--url", "https://example.test"],
    ["t3", "attach", "--connection", "a", "--project", "project"],
    ["t3", "inspect", "--connection", "a", "extra"],
  ]) expect(() => parseIntegrationCommand(args, "/work")).toThrow();
});

test("T3 attach posts to the broker once and emits its structured session receipt", async () => {
  const requests: Request[] = [];
  const receipt = { ok: true, connectionId: "local", threadId: "thread-1", sessionId: "sess.t3-thread-1", provider: "codex" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(receipt);
  }) as unknown as typeof fetch;
  for (const outputMode of ["plain", "json"] as const) {
    const lines: string[] = [];
    const context = createScoutCommandContext({ outputMode, stdout: line => lines.push(line) });
    await runIntegrationCommand(context, ["t3", "attach", "--connection", "local", "--thread", "thread-1"]);
    expect(JSON.parse(lines[0]!)).toEqual(receipt);
  }
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/integrations/t3/attach");
    expect(await request.json()).toEqual({ connectionId: "local", threadId: "thread-1" });
    expect(request.headers.get("authorization")).toBeNull();
  }
});

test("T3 broker failures are returned without replaying the operation", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: "t3_connection_unavailable", detail: "Configured T3 connection is unreachable" }, { status: 503 });
  }) as unknown as typeof fetch;
  await expect(runIntegrationCommand(createScoutCommandContext(), ["t3", "refresh", "--connection", "local", "--project", "project-1"])).rejects.toThrow("Configured T3 connection is unreachable");
  expect(calls).toBe(1);
});

test("integration help describes T3 source IDs, credential configuration, and exact session continuation", () => {
  expect(INTEGRATION_HELP).toContain("t3 inspect --connection");
  expect(INTEGRATION_HELP).toContain("OPENSCOUT_T3_CONNECTIONS");
  expect(INTEGRATION_HELP).toContain("opaque source IDs");
  expect(INTEGRATION_HELP).toContain("scout ask --to session:<id>");
  expect(INTEGRATION_HELP).toContain("--card <t3-card-id> --request-id <id>");
});

test("setup uses the working project and preserves explicit selectors", () => {
  expect(parseIntegrationCommand(["setup", "slack", "--agent", "alpha", "--workspace", "T123"], "/work/alpha")).toEqual({
    path: "/v1/integrations/setup", body: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha", agentId: "alpha", workspaceId: "T123" },
  });
});
test("rejects unknown/token options and ambiguous resume actions before network IO", () => {
  expect(() => parseIntegrationCommand(["setup", "slack", "--bot-token", "secret"], "/work")).toThrow("Unknown");
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "2", "--workspace", "T123", "--app", "A123"], "/work")).toThrow("exactly one");
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "2oops", "--app", "A123"], "/work")).toThrow("positive integer");
});
test("authority attestation requires an explicit dedicated flag", () => {
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "1"], "/work")).toThrow("exactly one");
  expect(parseIntegrationCommand(["resume", "op", "--if-revision", "1", "--confirm-workspace-authority"], "/work").body).toEqual({ action: "confirm_authority", expectedRevision: 1 });
});

test("credential attachment passes references and explicit admission policy", () => {
  expect(parseIntegrationCommand(["credentials", "op", "--if-revision", "3", "--app-token-key", "APP_KEY", "--bot-token-key", "BOT_KEY", "--allowed-users", "U1,U2", "--allowed-channels", "C1"], "/work")).toEqual({ path: "/v1/integrations/setup/op/credentials", body: {
    expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP_KEY", botTokenKey: "BOT_KEY" }, allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"],
  } });
  expect(() => parseIntegrationCommand(["credentials", "op", "--if-revision", "3", "--app-token-key", "APP_KEY", "--bot-token-key", "BOT_KEY"], "/work")).toThrow("explicit allowed-user");
});

test("credential file backend is explicit and unknown backends fail before IO", () => {
  const args = ["credentials", "operation", "--if-revision", "1", "--app-token-key", "APP", "--bot-token-key", "BOT", "--allowed-users", "U123", "--credential-backend"];
  expect(parseIntegrationCommand([...args, "private_file"], "/repo").body).toMatchObject({ reference: { backend: "private_file" } });
  expect(() => parseIntegrationCommand([...args, "untrusted"], "/repo")).toThrow("backend");
});

 test("verify checks evidence at the current revision without manual pass flags", () => {
  expect(parseIntegrationCommand(["verify", "op", "--if-revision", "5"], "/repo")).toEqual({ path: "/v1/integrations/setup/op/verify", body: { expectedRevision: 5 } });
  expect(() => parseIntegrationCommand(["verify", "op", "--verified", "true"], "/repo")).toThrow();
});

test("credential rotation is explicit and carries only replacement entry names", () => {
  const parsed = parseIntegrationCommand(["rotate-credentials", "op", "--if-revision", "6", "--app-token-key", "NEW_APP", "--bot-token-key", "NEW_BOT", "--allowed-users", "U123", "--credential-backend", "private_file"], "/repo");
  expect(parsed.body).toMatchObject({ expectedRevision: 6, rotate: true, reference: { backend: "private_file", appTokenKey: "NEW_APP", botTokenKey: "NEW_BOT" } });
});

test("rebind requires an explicit project and revision", () => {
  expect(parseIntegrationCommand(["rebind", "op", "--project", "../beta", "--if-revision", "6"], "/work/alpha")).toEqual({ path: "/v1/integrations/setup/op/rebind", body: { expectedRevision: 6, projectPath: "/work/beta" } });
  expect(() => parseIntegrationCommand(["rebind", "op", "--if-revision", "6"], "/work/alpha")).toThrow();
});
