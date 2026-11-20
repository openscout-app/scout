import { decodeJournalLine } from "./broker-journal-framing.js";
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { namedChannelNaturalKey } from "@openscout/protocol";

import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();

describe("broker daemon durability routes", () => {
  test("keeps projection-backed reads behind the startup boundary", async () => {
    const harness = await broker.startBroker({
      waitForMutationReady: false,
      env: {
        OPENSCOUT_TEST_STARTUP_BOUNDARY_DELAY_MS: "1500",
      },
    });

    // Listener readiness must not wait for SQLite construction or migrations.
    // The projection opens the one shared store after this test-only boundary;
    // route aliases and mesh trust reuse it instead of opening eager copies.
    expect(existsSync(join(harness.controlHome, "control-plane.sqlite"))).toBe(false);

    const restoringActivity = await fetch(`${harness.baseUrl}/v1/activity?limit=1`);
    expect(restoringActivity.status).toBe(503);
    expect(await restoringActivity.json()).toEqual(expect.objectContaining({
      error: "broker_restoring",
      retryable: true,
    }));

    await broker.waitFor(
      async () => broker.getJson<{
        projection?: { state?: string };
      }>(harness.baseUrl, "/health"),
      (health) => health.projection?.state === "ready",
      { attempts: 50, intervalMs: 100 },
    );

    const liveNode = await broker.getJson<{
      id: string;
      meshId: string;
      name: string;
      hostName?: string;
      advertiseScope: string;
      brokerUrl?: string;
      lastSeenAt?: number;
      registeredAt: number;
    }>(harness.baseUrl, "/v1/node");
    const database = new Database(join(harness.controlHome, "control-plane.sqlite"), {
      readonly: true,
    });
    try {
      const finalJournalNode = readFileSync(
        join(harness.controlHome, "broker-journal.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .flatMap(decodeJournalLine).map((entry) => entry as {
          kind?: string;
          node?: typeof liveNode;
        })
        .reverse()
        .find((entry) => entry.kind === "node.upsert" && entry.node?.id === harness.nodeId)
        ?.node;
      expect(finalJournalNode).toBeDefined();
      expect(database.query(`
        SELECT
          id,
          mesh_id AS meshId,
          name,
          host_name AS hostName,
          advertise_scope AS advertiseScope,
          broker_url AS brokerUrl,
          last_seen_at AS lastSeenAt,
          registered_at AS registeredAt
        FROM nodes
        WHERE id = ?
      `).get(harness.nodeId)).toEqual({
        id: finalJournalNode?.id,
        meshId: finalJournalNode?.meshId,
        name: finalJournalNode?.name,
        hostName: finalJournalNode?.hostName ?? null,
        advertiseScope: finalJournalNode?.advertiseScope,
        brokerUrl: finalJournalNode?.brokerUrl ?? null,
        lastSeenAt: finalJournalNode?.lastSeenAt ?? null,
        registeredAt: finalJournalNode?.registeredAt,
      });
      expect(finalJournalNode?.brokerUrl).toBe(liveNode.brokerUrl);
      expect(finalJournalNode?.advertiseScope).toBe(liveNode.advertiseScope);
      expect(database.query("SELECT id FROM actors WHERE id = 'system'").get()).toBeDefined();
    } finally {
      database.close();
    }
  }, 15_000);

  test("keeps web control reachable while the projection is restoring", async () => {
    const existingWeb = Bun.serve({
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/api/health"
          ? Response.json({ ok: true, surface: "openscout-web" })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const harness = await broker.startBroker({
        waitForMutationReady: false,
        env: {
          OPENSCOUT_TEST_STARTUP_BOUNDARY_DELAY_MS: "1500",
          OPENSCOUT_WEB_PORT: String(existingWeb.port),
        },
      });

      expect(existsSync(join(harness.controlHome, "control-plane.sqlite"))).toBe(false);
      const health = await broker.getJson<{
        ok: boolean;
        startup?: { state?: string; mutationsAdmitted?: boolean };
      }>(harness.baseUrl, "/health");
      expect(health).toEqual(expect.objectContaining({
        ok: true,
        startup: expect.objectContaining({ state: "restoring", mutationsAdmitted: false }),
      }));

      const webStatus = await broker.getJson<{
        ok: boolean;
        running: boolean;
      }>(harness.baseUrl, "/v1/web/status");
      expect(webStatus).toEqual(expect.objectContaining({
        ok: true,
        running: true,
      }));

      const webStart = await broker.requestJson(harness.baseUrl, "/v1/web/start", {
        method: "POST",
      });
      expect(webStart.status).toBe(200);
      expect(webStart.body).toEqual(expect.objectContaining({
        ok: true,
        running: true,
      }));

      const restoringActivity = await fetch(`${harness.baseUrl}/v1/activity?limit=1`);
      expect(restoringActivity.status).toBe(503);
      expect(await restoringActivity.json()).toEqual(expect.objectContaining({
        error: "broker_restoring",
        retryable: true,
      }));

      const restoringMutation = await broker.requestJson(harness.baseUrl, "/v1/messages", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(restoringMutation.status).toBe(503);
      expect(restoringMutation.body).toEqual(expect.objectContaining({
        error: "broker_restoring",
        retryable: true,
      }));
    } finally {
      existingWeb.stop(true);
    }
  }, 15_000);

  test("accepted registration survives process interruption during progressive fill", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "scout-progressive-interruption-"));
    const first = await broker.startBroker({ controlHome, waitForMutationReady: false, env: {
      OPENSCOUT_BROKER_DISK_HISTORY: "1", OPENSCOUT_TEST_STARTUP_BOUNDARY_DELAY_MS: "1500",
      OPENSCOUT_CORE_AGENTS: "", OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "0",
    } });
    await broker.waitFor(
      () => broker.getJson<{ startup?: { coreReady?: boolean } }>(first.baseUrl, "/health"),
      health => health.startup?.coreReady === true,
    );
    const actor = { id: "interrupted-registration", kind: "agent", displayName: "Accepted before fill" };
    const accepted = await broker.requestJson(first.baseUrl, "/v1/actors", {
      method: "POST", body: JSON.stringify(actor),
    });
    expect(accepted.status).toBe(200);
    const pending = await broker.requestJson(first.baseUrl, "/v1/messages", {
      method: "POST", body: JSON.stringify({ id: "not-accepted" }),
    });
    expect(pending.status).toBe(503);
    // Deliberate owned-process fault injection: recovery must use the journal,
    // including startup events whose SQLite projection never ran.
    first.child.kill("SIGKILL");
    await first.child.exited;
    broker.harnesses.delete(first);
    await Promise.all(first.outputDrain);
    const second = await broker.startBroker({ controlHome, env: {
      OPENSCOUT_BROKER_DISK_HISTORY: "1", OPENSCOUT_CORE_AGENTS: "",
      OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "0",
    } });
    const snapshot = await broker.getJson<{ actors: Record<string, unknown>; messages: Record<string, unknown> }>(second.baseUrl, "/v1/snapshot");
    // Registrations are stamped with first-registration createdAt at the
    // durable upsert funnel, so the record now carries that field.
    expect(snapshot.actors[actor.id]).toEqual({ ...actor, createdAt: expect.any(Number) });
    expect(snapshot.messages["not-accepted"]).toBeUndefined();
    const db = new Database(join(controlHome, "control-plane.sqlite"), { readonly: true });
    try { expect(db.query("SELECT display_name FROM actors WHERE id = ?").get(actor.id)).toEqual({ display_name: actor.displayName }); }
    finally { db.close(); }
  }, 15_000);

  test("restores dispatch in the same broker after projection storage becomes writable again", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "scout-projection-retry-"));
    broker.temporaryDirectories.add(controlHome);
    // Obstruct only the worker's quarantine database. This also exercises a
    // worker that exits while preparing its health reply, as a full disk can.
    const blockedFile = join(controlHome, "broker-journal.jsonl.quarantine.sqlite");
    mkdirSync(blockedFile);
    const harness = await broker.startBroker({ controlHome, waitForMutationReady: false });
    type Health = { startup: { mutationsAdmitted: boolean; state: string; nextRetryAt?: number; error?: string | null } };
    const health = () => broker.getJson<Health>(harness.baseUrl, "/health");
    const first = await broker.waitFor(health, row => row.startup.nextRetryAt !== undefined);
    expect(first.startup).toMatchObject({ state: "degraded", mutationsAdmitted: false });
    const actor = { id: "registered-during-retry", kind: "agent", displayName: "Recovery" };
    await broker.postJson(harness.baseUrl, "/v1/actors", actor);
    const second = await broker.waitFor(health, row => (row.startup.nextRetryAt ?? 0) > first.startup.nextRetryAt!);
    expect(second.startup.mutationsAdmitted).toBe(false);
    expect((await broker.requestJson(harness.baseUrl, "/v1/invocations", { method: "POST", body: "{}" })).status).toBe(503);
    rmdirSync(blockedFile);
    const ready = await broker.waitFor(health, row => row.startup.mutationsAdmitted, { attempts: 120 });
    expect(ready.startup).toMatchObject({ state: "ready", error: null });
    expect(ready.startup.nextRetryAt).toBeUndefined();
    expect(harness.child.exitCode).toBeNull();
    await broker.seedBasicConversation(harness);
    await broker.postJson(harness.baseUrl, "/v1/messages", {
      id: "after-projection-recovery", conversationId: "channel.shared",
      actorId: "operator", originNodeId: harness.nodeId, class: "agent",
      body: "Recovered", visibility: "workspace", policy: "durable", createdAt: Date.now(),
    });
    const messages = await broker.getJson<Array<{ id: string }>>(harness.baseUrl, "/v1/messages?conversationId=channel.shared");
    expect(messages.some(message => message.id === "after-projection-recovery")).toBe(true);
    const db = new Database(join(controlHome, "control-plane.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT display_name FROM actors WHERE id = ?").get(actor.id)).toEqual({ display_name: actor.displayName });
    } finally { db.close(); }
  }, 25_000);

  test("keeps canonical registration available after a historical projection failure", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "scout-degraded-startup-"));
    const env = { OPENSCOUT_CORE_AGENTS: "", OPENSCOUT_RUNTIME_CATALOG_REFRESH_MS: "0" };
    const original = await broker.startBroker({ controlHome, env: { ...env, OPENSCOUT_DISABLE_SQLITE: "1" } });
    // This shape was accepted by the existing API; do not silently rewrite
    // canonical history to make a derived SQLite constraint succeed.
    await broker.postJson(original.baseUrl, "/v1/agents", { id: "legacy-no-kind", displayName: "Legacy agent" });
    original.child.kill(); await original.child.exited; await Promise.all(original.outputDrain); broker.harnesses.delete(original);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const degraded = await broker.startBroker({ controlHome, waitForMutationReady: false, env });
      const health = await broker.waitFor(
        () => broker.getJson<{ startup: { phase: string; coreReady: boolean; historyReady: boolean; mutationsAdmitted: boolean; error?: string } }>(degraded.baseUrl, "/health"),
        value => value.startup.phase === "degraded",
      );
      expect(health.startup).toMatchObject({ phase: "degraded", coreReady: true, historyReady: true, mutationsAdmitted: false });
      expect(health.startup.error).toBeTruthy();
      expect(degraded.child.exitCode).toBeNull();
      for (const path of ["/v1/activity", "/v1/home", "/v1/thread-events"]) expect((await fetch(degraded.baseUrl + path)).status).toBe(503);
      for (const path of ["/v1/messages", "/v1/invocations"]) expect((await broker.requestJson(degraded.baseUrl, path, { method: "POST", body: "{}" })).status).toBe(503);
      if (attempt === 0) await broker.postJson(degraded.baseUrl, "/v1/actors", { id: "accepted-while-degraded", kind: "agent", displayName: "Durable" });
      const snapshot = await broker.getJson<{ actors: Record<string, { displayName: string }> }>(degraded.baseUrl, "/v1/snapshot");
      expect(snapshot.actors["accepted-while-degraded"]?.displayName).toBe("Durable");
      degraded.child.kill(); await degraded.child.exited; await Promise.all(degraded.outputDrain); broker.harnesses.delete(degraded);
    }
    broker.temporaryDirectories.add(controlHome);
  }, 15_000);

  test("keeps route-alias authority stable when the live hostname suffix changes", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-stable-authority-test-"));
    const projectRoot = "/work/studio";
    const first = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_NODE_ID: undefined,
        OPENSCOUT_NODE_NAME: "Arts-Mac-mini-372.local",
      },
    });
    expect(first.nodeId).toBe("arts-mac-mini-local-openscout");

    const studioAgentId = "studio.main.arts-mac-mini-372-local";
    await broker.postJson(first.baseUrl, "/v1/agents", {
      id: studioAgentId,
      kind: "agent",
      definitionId: "studio",
      displayName: "Studio",
      handle: "studio",
      selector: "@studio",
      defaultSelector: "@studio",
      metadata: { projectRoot },
      agentClass: "general",
      capabilities: ["chat", "invoke"],
      wakePolicy: "on_demand",
      homeNodeId: first.nodeId,
      authorityNodeId: first.nodeId,
      advertiseScope: "local",
    });
    await broker.postJson(first.baseUrl, "/v1/aliases", {
      alias: "studio-agent",
      target: { kind: "agent_id", agentId: studioAgentId },
      scope: { projectRoot },
      caller: { actorId: "operator", currentDirectory: projectRoot },
    });

    first.child.kill();
    await first.child.exited.catch(() => {});
    broker.harnesses.delete(first);

    const restarted = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_NODE_ID: undefined,
        OPENSCOUT_NODE_NAME: "Arts-Mac-mini-419.local",
      },
    });
    expect(restarted.nodeId).toBe(first.nodeId);

    const resolved = await broker.postJson<{
      resolved: boolean;
      binding?: { scopeNodeId: string; target: { agentId?: string } };
    }>(restarted.baseUrl, "/v1/aliases/resolve", {
      alias: "studio-agent",
      scope: { projectRoot },
      caller: { actorId: "operator", currentDirectory: projectRoot },
    });
    expect(resolved.resolved).toBe(true);
    expect(resolved.binding?.scopeNodeId).toBe(first.nodeId);
    expect(resolved.binding?.target.agentId).toBe(studioAgentId);
  }, 20_000);

  test("journals durable action heartbeats through the HTTP surface", async () => {
    const harness = await broker.startBroker();
    const initialAction = {
      id: "action-heartbeat-1",
      kind: "message_delivery",
      subjectId: "delivery-1",
      authorityCellId: "node-1",
      state: "leased",
      leaseOwner: "worker-a",
      leaseGeneration: 1,
      leaseExpiresAt: 1_000,
      createdAt: 100,
      updatedAt: 100,
    };
    await broker.postJson(harness.baseUrl, "/v1/nodes", {
      id: "node-1",
      meshId: "openscout",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: 1,
    });
    await broker.postJson(harness.baseUrl, "/v1/durable-actions", initialAction);

    const result = await broker.postJson<{
      ok: boolean;
      actionId: string;
      leaseOwner: string;
      leaseGeneration: number;
      leaseExpiresAt: number;
    }>(
      harness.baseUrl,
      "/v1/durable-actions/action-heartbeat-1/heartbeat",
      {
        owner: "worker-a",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 2_000,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      actionId: "action-heartbeat-1",
      leaseOwner: "worker-a",
      leaseGeneration: 1,
      leaseExpiresAt: 7_000,
    });
    expect(readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8"))
      .toContain('"kind":"durable.action.heartbeat"');

    const stale = await broker.postJsonStatus(
      harness.baseUrl,
      "/v1/durable-actions/action-heartbeat-1/heartbeat",
      {
        owner: "worker-b",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 3_000,
      },
    );
    expect(stale.status).toBe(409);

    const missing = await broker.postJsonStatus(
      harness.baseUrl,
      "/v1/durable-actions/action-missing/heartbeat",
      {
        owner: "worker-a",
        generation: 1,
        leaseMs: 5_000,
        heartbeatAt: 3_000,
      },
    );
    expect(missing.status).toBe(404);

  }, 15_000);

  test("rebuilds the sqlite projection from the file journal after degraded writes", async () => {
    const controlHome = mkdtempSync(join(tmpdir(), "openscout-runtime-test-"));
    const degradedHarness = await broker.startBroker({
      controlHome,
      env: {
        OPENSCOUT_DISABLE_SQLITE: "1",
      },
    });
    await broker.seedBasicConversation(degradedHarness);

    await broker.postJson(degradedHarness.baseUrl, "/v1/messages", {
      id: "msg-journal-replay-1",
      conversationId: "channel.shared",
      actorId: "operator",
      originNodeId: degradedHarness.nodeId,
      class: "agent",
      body: "@fabric recover projection",
      mentions: [{ actorId: "fabric", label: "@fabric" }],
      audience: {
        notify: ["fabric"],
      },
      visibility: "workspace",
      policy: "durable",
      createdAt: Date.now(),
    });

    degradedHarness.child.kill();
    await degradedHarness.child.exited.catch(() => {});
    broker.harnesses.delete(degradedHarness);

    const recoveredHarness = await broker.startBroker({ controlHome });
    const activity = await broker.waitFor(
      async () => broker.getJson<Array<{ messageId?: string }>>(recoveredHarness.baseUrl, "/v1/activity?limit=20"),
      (items) => items.some((item) => item.messageId === "msg-journal-replay-1"),
    );

    expect(activity.some((item) => item.messageId === "msg-journal-replay-1")).toBe(true);
  }, 15_000);

  test("skips redundant durable agent upserts", async () => {
    const harness = await broker.startBroker();

    const agent = {
      id: "agent-dedupe",
      kind: "agent" as const,
      definitionId: "agent-dedupe",
      displayName: "Agent Dedupe",
      handle: "agent-dedupe",
      agentClass: "builder" as const,
      capabilities: ["chat"] as const,
      wakePolicy: "on_demand" as const,
      homeNodeId: harness.nodeId,
      authorityNodeId: harness.nodeId,
      advertiseScope: "local" as const,
      metadata: {
        workspace: "/tmp/agent-dedupe",
      },
    };

    await broker.postJson(harness.baseUrl, "/v1/agents", agent);
    await broker.postJson(harness.baseUrl, "/v1/agents", agent);

    const journal = readFileSync(join(harness.controlHome, "broker-journal.jsonl"), "utf8");
    const journalLines = journal
      .trim()
      .split("\n")
      .filter(Boolean);
    const lines = journalLines.flatMap((line, lineIndex) => {
      try {
        return decodeJournalLine(line);
      } catch (error) {
        console.error("Journal decode failed (zero-based line index):", JSON.stringify({
          lineIndex,
          totalLineCount: journalLines.length,
          lineByteLength: Buffer.byteLength(line, "utf8"),
          fileEndsWithNewline: journal.endsWith("\n"),
          first200Bytes: Buffer.from(line, "utf8").subarray(0, 200).toString("utf8"),
        }));
        throw error;
      }
    }).map((entry) => entry as { kind: string; actor?: { id?: string }; agent?: { id?: string } });

    expect(lines.filter((entry) => entry.kind === "actor.upsert" && entry.actor?.id === agent.id)).toHaveLength(1);
    expect(lines.filter((entry) => entry.kind === "agent.upsert" && entry.agent?.id === agent.id)).toHaveLength(1);
  }, 15_000);
});
