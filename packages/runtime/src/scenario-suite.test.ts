import { describe, expect } from "bun:test";
import { isolateOpenScoutUserDataForTests } from "./test-user-data-isolation.ts";

isolateOpenScoutUserDataForTests();


import type {
  DeliveryIntent,
  MessageRecord,
  ScoutDeliverResponse,
} from "@openscout/protocol";
import {
  RuntimeScenarioHarness,
  runtimeScenario,
} from "./test-helpers/runtime-scenario-harness.test";

function deliverySummary(delivery: DeliveryIntent) {
  return {
    messageId: delivery.messageId ?? null,
    targetId: delivery.targetId,
    transport: delivery.transport,
    reason: delivery.reason,
  };
}

function sortSummaries(values: Array<Record<string, string | null>>) {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

describe("runtime scenario suite", () => {
  runtimeScenario(
    "runs a project routine across docs and OG review asks",
    async (scenario) => {
      const agents = [
        {
          id: "hudson.docs.claude",
          definitionId: "hudson",
          displayName: "Hudson",
          handle: "hudson",
          selector: "@hudson",
          harness: "claude" as const,
          transport: "claude_stream_json" as const,
          endpointId: "endpoint.hudson.docs",
          projectRoot: "/tmp/hudson",
          cwd: "/tmp/hudson",
        },
        {
          id: "talkie.docs.codex",
          definitionId: "talkie",
          displayName: "Talkie",
          handle: "talkie",
          selector: "@talkie",
          harness: "codex" as const,
          transport: "codex_app_server" as const,
          endpointId: "endpoint.talkie.docs",
          projectRoot: "/tmp/talkie",
          cwd: "/tmp/talkie",
        },
        {
          id: "linea.og.codex",
          definitionId: "linea",
          displayName: "Linea",
          handle: "linea",
          selector: "@linea",
          harness: "codex" as const,
          transport: "codex_app_server" as const,
          endpointId: "endpoint.linea.og",
          projectRoot: "/tmp/linea",
          cwd: "/tmp/linea",
        },
        {
          id: "lattices.og.claude",
          definitionId: "lattices",
          displayName: "Lattices",
          handle: "lattices",
          selector: "@lattices",
          harness: "claude" as const,
          transport: "claude_stream_json" as const,
          endpointId: "endpoint.lattices.og",
          projectRoot: "/tmp/lattices",
          cwd: "/tmp/lattices",
        },
      ];

      const tasks = [
        {
          recordId: "work.hudson.docs-state",
          targetAgentId: "hudson.docs.claude",
          label: "@hudson",
          title: "Check Hudson docs state",
          body: "Review Hudson docs and report stale setup steps, missing screenshots, and the current docs state.",
          response: "Hudson docs are usable, but install docs need the new broker direct-service wording and one screenshot refresh.",
          artifact: "docs",
          expectedTransport: "pairing_bridge",
        },
        {
          recordId: "work.talkie.docs-state",
          targetAgentId: "talkie.docs.codex",
          label: "@talkie",
          title: "Check Talkie docs state",
          body: "Review Talkie docs and summarize what is current, stale, or missing before the next release.",
          response: "Talkie docs cover the main voice loop, but onboarding still references the older pairing screen copy.",
          artifact: "docs",
          expectedTransport: "pairing_bridge",
        },
        {
          recordId: "work.linea.og-review",
          targetAgentId: "linea.og.codex",
          label: "@linea",
          title: "Review Linea OG images",
          body: "Review Linea Open Graph images for legibility, brand fit, and obvious export issues.",
          response: "Linea OG images read clearly at social-card size; the dark variant needs a stronger product signal.",
          artifact: "og-image",
          expectedTransport: "pairing_bridge",
        },
        {
          recordId: "work.lattices.og-review",
          targetAgentId: "lattices.og.claude",
          label: "@lattices",
          title: "Review Lattices OG images",
          body: "Review Lattices Open Graph images and call out any weak contrast, cropping, or stale claims.",
          response: "Lattices OG images have solid contrast, but the topology card crops too close on narrow previews.",
          artifact: "og-image",
          expectedTransport: "pairing_bridge",
        },
      ];

      // These are simulated reviewers, not live native processes. Route the
      // asks through the owned fake bridge and keep their harness provenance.
      const pairing = await scenario.startPairingBridgeServer({ sessions: agents.map(agent => ({
        id: agent.id, name: agent.displayName, adapterType: agent.harness, status: "idle",
        response: tasks.find(task => task.targetAgentId === agent.id)!.response,
      })) });
      const home = scenario.configurePairingHome(pairing.port);
      const broker = await scenario.startBroker({ env: {
        HOME: home,
        OPENSCOUT_SUPPORT_DIRECTORY: `${home}/Library/Application Support/OpenScout`,
        OPENSCOUT_RELAY_HUB: `${home}/.openscout/relay`,
        OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
      } });
      await scenario.seedOperator(broker);
      for (const agent of agents) {
        await scenario.registerAgent(broker, {
          ...agent,
          transport: "pairing_bridge",
          sessionId: agent.id,
          metadata: {
            routine: "docs-og-review",
          },
          endpointMetadata: {
            routine: "docs-og-review",
          },
        });
      }

      const registered = await scenario.snapshot<{ endpoints: Record<string, { harness: string; transport: string }> }>(broker);
      for (const agent of agents) expect(registered.endpoints[agent.endpointId]).toMatchObject({ harness: agent.harness, transport: "pairing_bridge" });

      const startedAt = Date.now();
      for (const [index, task] of tasks.entries()) {
        await scenario.post(broker, "/v1/collaboration/records", {
          id: task.recordId,
          kind: "work_item",
          state: "waiting",
          acceptanceState: "none",
          title: task.title,
          summary: task.body,
          createdById: "operator",
          ownerId: task.targetAgentId,
          nextMoveOwnerId: task.targetAgentId,
          requestedById: "operator",
          waitingOn: {
            kind: "actor",
            label: task.label,
            targetId: task.targetAgentId,
            metadata: {
              artifact: task.artifact,
            },
          },
          priority: task.artifact === "og-image" ? "normal" : "high",
          labels: ["routine", task.artifact],
          createdAt: startedAt + index,
          updatedAt: startedAt + index,
          metadata: {
            routine: "docs-og-review",
            targetLabel: task.label,
          },
        });
      }

      const deliveries: ScoutDeliverResponse[] = [];
      for (const [index, task] of tasks.entries()) {
        deliveries.push(await scenario.post<ScoutDeliverResponse>(
          broker,
          "/v1/deliver",
          {
            id: `deliver-routine-${index + 1}`,
            requesterId: "operator",
            requesterNodeId: broker.nodeId,
            body: task.body,
            intent: "consult",
            targetAgentId: task.targetAgentId,
            ensureAwake: true,
            createdAt: Date.now(),
            collaborationRecordId: task.recordId,
            messageMetadata: {
              routine: "docs-og-review",
              artifact: task.artifact,
            },
            invocationMetadata: {
              routine: "docs-og-review",
              artifact: task.artifact,
            },
          },
        ));
      }

      expect(deliveries.every((delivery) => delivery.kind === "delivery")).toBe(true);
      expect(deliveries.map((delivery) => delivery.targetAgentId)).toEqual(
        tasks.map((task) => task.targetAgentId),
      );
      expect(deliveries.map((delivery) => delivery.flight?.targetAgentId)).toEqual(
        tasks.map((task) => task.targetAgentId),
      );

      const requestMessageIds = deliveries.map((delivery) => delivery.kind === "delivery" ? delivery.message.id : "");
      const requestDeliveries = (await scenario.listDeliveries(broker))
        .filter((delivery) => requestMessageIds.includes(delivery.messageId ?? ""));
      const directRequestDeliveries = requestDeliveries.filter((delivery) => delivery.reason === "direct_message");
      const mentionRequestDeliveries = requestDeliveries.filter((delivery) => delivery.reason === "mention");
      expect(sortSummaries(directRequestDeliveries.map(deliverySummary))).toEqual(sortSummaries(
        tasks.map((task, index) => ({
          messageId: requestMessageIds[index] ?? null,
          targetId: task.targetAgentId,
          transport: task.expectedTransport,
          reason: "direct_message",
        })),
      ));
      expect(mentionRequestDeliveries).toEqual([]);

      for (const [index, task] of tasks.entries()) {
        const delivery = deliveries[index];
        if (delivery.kind !== "delivery") {
          throw new Error(`expected accepted delivery for ${task.recordId}`);
        }

        const answered = await scenario.waitFor(
          () => scenario.listMessages(broker, delivery.conversation.id),
          messages => messages.some(message => message.body === task.response),
        );
        expect(answered.map(message => message.body)).toContain(task.response);

        await scenario.post(broker, "/v1/collaboration/records", {
          id: task.recordId,
          kind: "work_item",
          state: "done",
          acceptanceState: "accepted",
          title: task.title,
          summary: task.response,
          createdById: "operator",
          ownerId: task.targetAgentId,
          requestedById: "operator",
          conversationId: delivery.conversation.id,
          priority: task.artifact === "og-image" ? "normal" : "high",
          labels: ["routine", task.artifact],
          progress: {
            completedSteps: 1,
            totalSteps: 1,
            checkpoint: "reviewed",
            summary: task.response,
            percent: 100,
          },
          createdAt: startedAt + index,
          updatedAt: startedAt + 200 + index,
          completedAt: startedAt + 200 + index,
          metadata: {
            routine: "docs-og-review",
            targetLabel: task.label,
          },
        });
      }

      for (const [index, task] of tasks.entries()) {
        const delivery = deliveries[index];
        if (delivery.kind !== "delivery") {
          throw new Error(`expected accepted delivery for ${task.recordId}`);
        }
        const messages = await scenario.listMessages(broker, delivery.conversation.id);
        expect(messages.map((message) => message.body)).toEqual([
          task.body,
          task.response,
        ]);
      }

      const snapshot = await scenario.snapshot<{
        collaborationRecords: Record<string, {
          state: string;
          ownerId?: string;
          conversationId?: string;
          progress?: { percent?: number; checkpoint?: string };
          metadata?: Record<string, unknown>;
        }>;
      }>(broker);

      for (const [index, task] of tasks.entries()) {
        const delivery = deliveries[index];
        if (delivery.kind !== "delivery") {
          throw new Error(`expected accepted delivery for ${task.recordId}`);
        }
        expect(snapshot.collaborationRecords[task.recordId]).toEqual(expect.objectContaining({
          state: "done",
          ownerId: task.targetAgentId,
          conversationId: delivery.conversation.id,
          progress: expect.objectContaining({
            checkpoint: "reviewed",
            percent: 100,
          }),
          metadata: expect.objectContaining({
            routine: "docs-og-review",
          }),
        }));
      }
    },
  );

  runtimeScenario(
    "routes an e2e ask through a pairing adapter session",
    async (scenario) => {
      const pairing = await scenario.startPairingBridgeServer({
        sessions: [
          {
            id: "session.e2e.echo",
            name: "E2E Adapter",
            adapterType: "echo",
            status: "idle",
            cwd: "/tmp/openscout-e2e",
            adapterBacked: true,
            adapterOptions: {
              stepDelay: 0,
            },
          },
        ],
      });
      const home = scenario.configurePairingHome(pairing.port);
      const broker = await scenario.startBroker({
        env: {
          HOME: home,
          OPENSCOUT_SUPPORT_DIRECTORY: `${home}/Library/Application Support/OpenScout`,
          OPENSCOUT_RELAY_HUB: `${home}/.openscout/relay`,
          OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
        },
      });
      await scenario.seedOperator(broker);

      const attached = await scenario.post<{
        ok: boolean;
        agentId: string;
        selector: string;
        endpointId: string;
      }>(broker, "/v1/pairing/attach", {
        externalSessionId: "session.e2e.echo",
        alias: "@e2e-adapter",
        displayName: "E2E Adapter",
      });

      expect(attached.ok).toBe(true);
      expect(attached.selector).toBe("@e2e-adapter");

      const body = "Review docs freshness and OG image readiness for an OpenScout e2e pass. Keep the reply short.";
      const delivery = await scenario.post<ScoutDeliverResponse>(broker, "/v1/deliver", {
        id: "deliver-e2e-adapter",
        requesterId: "operator",
        requesterNodeId: broker.nodeId,
        body,
        intent: "consult",
        targetAgentId: attached.agentId,
        ensureAwake: true,
        createdAt: Date.now(),
        messageMetadata: {
          routine: "agent-e2e",
        },
        invocationMetadata: {
          routine: "agent-e2e",
        },
      });

      if (delivery.kind !== "delivery" || !delivery.flight) {
        throw new Error("expected e2e delivery with a flight");
      }

      const invocationId = delivery.flight.invocationId;
      const completed = await scenario.waitFor(
        () => scenario.get<{
          flight: {
            state: string;
            output?: string;
          } | null;
        }>(broker, `/v1/invocations/${encodeURIComponent(invocationId)}`),
        (snapshot) => snapshot.flight?.state === "completed",
        8_000,
      );

      expect(completed.flight?.output).toBe(`Echo: ${body}`);

      const messages = await scenario.waitFor(
        () => scenario.listMessages(broker, delivery.conversation.id),
        (records) => records.some((record) => record.actorId === attached.agentId && record.body === `Echo: ${body}`),
        8_000,
      );
      expect(messages.map((message) => message.body)).toEqual([
        body,
        `Echo: ${body}`,
      ]);

      const reply = messages.find((message) => message.actorId === attached.agentId);
      expect(reply?.metadata).toEqual(expect.objectContaining({
        invocationId,
        responderHarness: "bridge",
        responderTransport: "pairing_bridge",
        responderSessionId: "session.e2e.echo",
      }));

      const requestDeliveries = (await scenario.listDeliveries(broker))
        .filter((record) => record.messageId === delivery.message.id);
      expect(requestDeliveries.map(deliverySummary)).toContainEqual({
        messageId: delivery.message.id,
        targetId: attached.agentId,
        transport: "pairing_bridge",
        reason: "direct_message",
      });

      const snapshot = await scenario.snapshot<{
        endpoints: Record<string, {
          transport: string;
          sessionId?: string;
          metadata?: Record<string, unknown>;
        }>;
      }>(broker);
      expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
        transport: "pairing_bridge",
        sessionId: "session.e2e.echo",
        metadata: expect.objectContaining({
          managedByScout: true,
          pairingAdapterType: "echo",
          sessionBacked: true,
        }),
      }));
    },
  );

  runtimeScenario(
    "wakes a docs reviewer from a collaboration record and hands findings to an editor",
    async (scenario) => {
      const broker = await scenario.startBroker();
      await scenario.seedOperator(broker);

      await scenario.registerAgent(broker, {
        id: "docs.review.claude",
        definitionId: "docs-review",
        displayName: "Docs Review",
        handle: "docs-review",
        selector: "@docs-review",
        harness: "claude",
        transport: "claude_stream_json",
        endpointId: "endpoint.docs.review",
        sessionId: "docs-review-session",
        branch: "release/docs-pass",
        projectRoot: "/tmp/product-docs",
        cwd: "/tmp/product-docs",
      });
      await scenario.registerAgent(broker, {
        id: "docs.edit.codex",
        definitionId: "docs-edit",
        displayName: "Docs Edit",
        handle: "docs-edit",
        selector: "@docs-edit",
        harness: "codex",
        transport: "codex_app_server",
        endpointId: "endpoint.docs.edit",
        sessionId: "docs-edit-session",
        branch: "release/docs-fixes",
        projectRoot: "/tmp/product-docs",
        cwd: "/tmp/product-docs",
      });

      const conversation = await scenario.ensureDirectConversation(broker, {
        sourceId: "docs.review.claude",
        targetId: "docs.edit.codex",
        title: "Docs Review Handoff",
      });

      const now = Date.now();
      await scenario.post(broker, "/v1/collaboration/records", {
        id: "work.docs.review.1",
        kind: "work_item",
        state: "waiting",
        acceptanceState: "none",
        title: "Review the quickstart docs",
        summary: "Check the quickstart for missing setup steps and confusing language before release.",
        createdById: "operator",
        ownerId: "docs.review.claude",
        nextMoveOwnerId: "docs.review.claude",
        requestedById: "operator",
        waitingOn: {
          kind: "actor",
          label: "docs review",
          targetId: "docs.review.claude",
        },
        conversationId: conversation.id,
        createdAt: now,
        updatedAt: now,
      });

      const wake = await scenario.post<{
        ok: boolean;
        recordId: string;
        targetAgentId: string;
        wakeReason: string;
        invocation: {
          targetAgentId: string;
          metadata?: {
            collaborationRecordId?: string;
            wakeReason?: string;
          };
          context?: {
            collaboration?: {
              recordId?: string;
              nextMoveOwnerId?: string;
              waitingOn?: { targetId?: string };
            };
          };
        };
        flight: {
          targetAgentId: string;
          state: string;
        };
      }>(broker, "/v1/collaboration/records/work.docs.review.1/invoke", {
        requesterId: "operator",
      });

      expect(wake.ok).toBe(true);
      expect(wake.recordId).toBe("work.docs.review.1");
      expect(wake.targetAgentId).toBe("docs.review.claude");
      expect(wake.wakeReason).toBe("next_move_owner");
      expect(wake.invocation.targetAgentId).toBe("docs.review.claude");
      expect(wake.invocation.metadata?.collaborationRecordId).toBe("work.docs.review.1");
      expect(wake.invocation.metadata?.wakeReason).toBe("next_move_owner");
      expect(wake.invocation.context?.collaboration?.recordId).toBe("work.docs.review.1");
      expect(wake.invocation.context?.collaboration?.nextMoveOwnerId).toBe("docs.review.claude");
      expect(wake.invocation.context?.collaboration?.waitingOn?.targetId).toBe("docs.review.claude");
      expect(wake.flight.targetAgentId).toBe("docs.review.claude");
      expect(wake.flight.state).toBe("queued");

      await scenario.postMessage(broker, {
        id: "msg-docs-review-1",
        conversationId: conversation.id,
        actorId: "docs.review.claude",
        body: "The quickstart needs a prerequisites section and a clearer API key setup step.",
      });
      await scenario.postMessage(broker, {
        id: "msg-docs-review-2",
        conversationId: conversation.id,
        actorId: "docs.edit.codex",
        body: "Updated. I added prerequisites and split the API key setup into its own numbered step.",
      });

      const messages = await scenario.listMessages(broker, conversation.id);
      expect(messages.map((message) => message.body)).toEqual([
        "The quickstart needs a prerequisites section and a clearer API key setup step.",
        "Updated. I added prerequisites and split the API key setup into its own numbered step.",
      ]);

      const deliveries = (await scenario.listDeliveries(broker))
        .filter((delivery) => new Set(["msg-docs-review-1", "msg-docs-review-2"]).has(delivery.messageId ?? ""));
      expect(deliveries).toHaveLength(2);

      const reviewToEdit = deliveries.find((delivery) => delivery.messageId === "msg-docs-review-1");
      expect(deliverySummary(reviewToEdit!)).toEqual({
        messageId: "msg-docs-review-1",
        targetId: "docs.edit.codex",
        transport: "codex_app_server",
        reason: "direct_message",
      });

      const editToReview = deliveries.find((delivery) => delivery.messageId === "msg-docs-review-2");
      expect(editToReview).toEqual(expect.objectContaining({
        messageId: "msg-docs-review-2",
        targetId: "docs.review.claude",
        reason: "direct_message",
      }));
      expect(["claude_stream_json", "local_socket"]).toContain(editToReview?.transport);
    },
  );

  runtimeScenario(
    "scripts a multi-turn direct conversation across Codex and Claude branches",
    async (scenario) => {
      const broker = await scenario.startBroker();

      await scenario.registerAgent(broker, {
        id: "lattices.main.codex",
        definitionId: "lattices",
        displayName: "Lattices",
        handle: "lattices",
        selector: "@lattices",
        harness: "codex",
        transport: "codex_app_server",
        endpointId: "endpoint.lattices.codex",
        sessionId: "lattices-codex",
        branch: "main",
        projectRoot: "/tmp/lattices",
        cwd: "/tmp/lattices",
      });
      await scenario.registerAgent(broker, {
        id: "vox.feature-qa.claude",
        definitionId: "vox",
        displayName: "Vox",
        handle: "vox",
        selector: "@vox",
        harness: "claude",
        transport: "claude_stream_json",
        endpointId: "endpoint.vox.claude",
        sessionId: "vox-claude",
        branch: "feature/qa-followups",
        projectRoot: "/tmp/vox/.scout-worktrees/qa-followups",
        cwd: "/tmp/vox/.scout-worktrees/qa-followups",
      });

      const conversation = await scenario.ensureDirectConversation(broker, {
        sourceId: "lattices.main.codex",
        targetId: "vox.feature-qa.claude",
        title: "Lattices <> Vox",
      });

      await scenario.postMessage(broker, {
        id: "msg-dm-1",
        conversationId: conversation.id,
        actorId: "lattices.main.codex",
        body: "Can you sanity-check the handoff before I merge?",
      });
      await scenario.postMessage(broker, {
        id: "msg-dm-2",
        conversationId: conversation.id,
        actorId: "vox.feature-qa.claude",
        body: "Yes. I want one more follow-up on the timeout path.",
      });
      await scenario.postMessage(broker, {
        id: "msg-dm-3",
        conversationId: conversation.id,
        actorId: "lattices.main.codex",
        body: "Done. I tightened the timeout handling and reran the scenario.",
      });

      const messages = await scenario.listMessages(broker, conversation.id);
      expect(messages.map((message) => message.body)).toEqual([
        "Can you sanity-check the handoff before I merge?",
        "Yes. I want one more follow-up on the timeout path.",
        "Done. I tightened the timeout handling and reran the scenario.",
      ]);

      const deliveries = (await scenario.listDeliveries(broker))
        .filter((delivery) => new Set(["msg-dm-1", "msg-dm-2", "msg-dm-3"]).has(delivery.messageId ?? ""));
      expect(sortSummaries(deliveries.map(deliverySummary))).toEqual(sortSummaries([
        {
          messageId: "msg-dm-1",
          targetId: "vox.feature-qa.claude",
          transport: "claude_stream_json",
          reason: "direct_message",
        },
        {
          messageId: "msg-dm-2",
          targetId: "lattices.main.codex",
          transport: "codex_app_server",
          reason: "direct_message",
        },
        {
          messageId: "msg-dm-3",
          targetId: "vox.feature-qa.claude",
          transport: "claude_stream_json",
          reason: "direct_message",
        },
      ]));

      const snapshot = await scenario.snapshot<{
        endpoints: Record<string, { harness: string; transport: string; metadata?: Record<string, unknown> }>;
      }>(broker);
      expect(snapshot.endpoints["endpoint.lattices.codex"]).toMatchObject({
        harness: "codex",
        transport: "codex_app_server",
        metadata: expect.objectContaining({
          branch: "main",
        }),
      });
      expect(snapshot.endpoints["endpoint.vox.claude"]).toMatchObject({
        harness: "claude",
        transport: "claude_stream_json",
        metadata: expect.objectContaining({
          branch: "feature/qa-followups",
        }),
      });
    },
  );

  runtimeScenario(
    "scripts a three-agent group_direct conversation and verifies direct fan-out",
    async (scenario) => {
      const broker = await scenario.startBroker();

      await scenario.registerAgent(broker, {
        id: "vox.review",
        definitionId: "vox",
        displayName: "Vox",
        handle: "vox",
        selector: "@vox",
        harness: "claude",
        transport: "claude_stream_json",
        endpointId: "endpoint.vox.review",
      });
      await scenario.registerAgent(broker, {
        id: "lattices.review",
        definitionId: "lattices",
        displayName: "Lattices",
        handle: "lattices",
        selector: "@lattices",
        harness: "codex",
        transport: "codex_app_server",
        endpointId: "endpoint.lattices.review",
      });
      await scenario.registerAgent(broker, {
        id: "newell.review",
        definitionId: "newell",
        displayName: "Newell",
        handle: "newell",
        selector: "@newell",
        harness: "codex",
        transport: "codex_app_server",
        endpointId: "endpoint.newell.review",
      });

      const conversation = await scenario.registerConversation(broker, {
        id: "group.release.review",
        kind: "group_direct",
        title: "Release Review",
        participantIds: ["vox.review", "lattices.review", "newell.review"],
      });

      const postedAt = Date.now();
      await scenario.postMessage(broker, {
        createdAt: postedAt,
        id: "msg-group-1",
        conversationId: conversation.id,
        actorId: "vox.review",
        body: "I am checking the timeout semantics.",
      });
      await scenario.postMessage(broker, {
        createdAt: postedAt + 1,
        id: "msg-group-2",
        conversationId: conversation.id,
        actorId: "lattices.review",
        body: "I am taking the branch and worktree path.",
      });
      await scenario.postMessage(broker, {
        createdAt: postedAt + 2,
        id: "msg-group-3",
        conversationId: conversation.id,
        actorId: "newell.review",
        body: "I will verify the pairing-session attach flow.",
      });

      const messages = await scenario.listMessages(broker, conversation.id);
      expect(messages.map((message) => message.body)).toEqual([
        "I am checking the timeout semantics.",
        "I am taking the branch and worktree path.",
        "I will verify the pairing-session attach flow.",
      ]);

      const deliveries = (await scenario.listDeliveries(broker))
        .filter((delivery) => new Set(["msg-group-1", "msg-group-2", "msg-group-3"]).has(delivery.messageId ?? ""));
      expect(sortSummaries(deliveries.map(deliverySummary))).toEqual(sortSummaries([
        {
          messageId: "msg-group-1",
          targetId: "lattices.review",
          transport: "codex_app_server",
          reason: "direct_message",
        },
        {
          messageId: "msg-group-1",
          targetId: "newell.review",
          transport: "codex_app_server",
          reason: "direct_message",
        },
        {
          messageId: "msg-group-2",
          targetId: "newell.review",
          transport: "codex_app_server",
          reason: "direct_message",
        },
        {
          messageId: "msg-group-2",
          targetId: "vox.review",
          transport: "claude_stream_json",
          reason: "direct_message",
        },
        {
          messageId: "msg-group-3",
          targetId: "lattices.review",
          transport: "codex_app_server",
          reason: "direct_message",
        },
        {
          messageId: "msg-group-3",
          targetId: "vox.review",
          transport: "claude_stream_json",
          reason: "direct_message",
        },
      ]));
    },
  );

  runtimeScenario(
    "keeps authority-owned history canonical when a remote broker writes into the thread",
    async (scenario) => {
      const authority = await scenario.startBroker();
      const remote = await scenario.startBroker();

      await scenario.registerNode(remote, {
        id: authority.nodeId,
        name: "Authority",
        brokerUrl: authority.baseUrl,
      });

      await scenario.registerAgent(authority, {
        id: "remote-agent",
        definitionId: "remote-agent",
        displayName: "Remote Agent",
        handle: "remote-agent",
        selector: "@remote-agent",
        homeNodeId: remote.nodeId,
        authorityNodeId: remote.nodeId,
      });
      await scenario.registerAgent(remote, {
        id: "remote-agent",
        definitionId: "remote-agent",
        displayName: "Remote Agent",
        handle: "remote-agent",
        selector: "@remote-agent",
        homeNodeId: remote.nodeId,
        authorityNodeId: remote.nodeId,
      });

      const conversation = {
        id: "channel.shared.remote-runtime-scenario",
        kind: "channel" as const,
        title: "shared remote runtime scenario",
        visibility: "workspace" as const,
        shareMode: "shared" as const,
        authorityNodeId: authority.nodeId,
        participantIds: ["remote-agent"],
        metadata: { surface: "scenario" },
      };
      await scenario.registerConversation(authority, conversation);
      await scenario.registerConversation(remote, conversation);

      const response = await scenario.post<{
        ok: boolean;
        forwarded?: boolean;
        authorityNodeId?: string;
      }>(remote, "/v1/messages", {
        id: "msg-remote-authority-1",
        conversationId: conversation.id,
        actorId: "remote-agent",
        originNodeId: remote.nodeId,
        class: "agent",
        body: "remote-authority handoff message",
        visibility: "workspace",
        policy: "durable",
        createdAt: Date.now(),
      });
      expect(response.ok).toBe(true);
      expect(response).toEqual(expect.objectContaining({
        forwarded: true,
        authorityNodeId: authority.nodeId,
      }));

      const authorityMessages = await scenario.waitFor(
        () => scenario.listMessages(authority, conversation.id),
        (messages) => messages.some((message) => message.id === "msg-remote-authority-1"),
      );
      expect(authorityMessages.map((message) => message.body)).toContain("remote-authority handoff message");

      const remoteSnapshot = await scenario.snapshot<{
        messages: Record<string, MessageRecord>;
      }>(remote);
      expect(remoteSnapshot.messages["msg-remote-authority-1"]).toBeUndefined();
    },
  );

  runtimeScenario(
    "attaches a Codex local session and routes direct messages through pairing_bridge",
    async (scenario) => {
      const pairing = await scenario.startPairingBridgeServer({ sessions: [] });
      const home = scenario.configurePairingHome(pairing.port);
      const broker = await scenario.startBroker({
        env: {
          HOME: home,
        },
      });

      await scenario.seedOperator(broker);

      const attached = await scenario.post<{
        ok: boolean;
        agentId: string;
        selector: string;
        endpointId: string;
        sessionId: string;
      }>(broker, "/v1/local-sessions/attach", {
        externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
        transport: "codex_app_server",
        cwd: "/tmp/codex-here",
        alias: "@codex-here",
        displayName: "Codex Here",
      });

      expect(attached.ok).toBe(true);
      expect(attached.selector).toBe("@codex-here");
      expect(attached.sessionId).toBe("pairing-019d9762");

      const conversation = await scenario.ensureDirectConversation(broker, {
        sourceId: "operator",
        targetId: attached.agentId,
        title: "Operator <> Codex Here",
      });

      await scenario.postMessage(broker, {
        id: "msg-local-session-1",
        conversationId: conversation.id,
        actorId: "operator",
        body: "Please take a second pass on the runtime harness.",
      });

      const deliveries = (await scenario.listDeliveries(broker))
        .filter((delivery) => delivery.messageId === "msg-local-session-1");
      expect(deliveries.map(deliverySummary)).toEqual([
        {
          messageId: "msg-local-session-1",
          targetId: attached.agentId,
          transport: "pairing_bridge",
          reason: "direct_message",
        },
      ]);

      const snapshot = await scenario.snapshot<{
        agents: Record<string, { selector?: string; displayName: string }>;
        endpoints: Record<string, {
          transport: string;
          sessionId?: string;
          metadata?: Record<string, unknown>;
        }>;
      }>(broker);
      expect(snapshot.agents[attached.agentId]).toEqual(expect.objectContaining({
        displayName: "Codex Here",
        selector: "@codex-here",
      }));
      expect(snapshot.endpoints[attached.endpointId]).toEqual(expect.objectContaining({
        transport: "pairing_bridge",
        sessionId: "pairing-019d9762",
        metadata: expect.objectContaining({
          externalSessionId: "019d9762-19f7-7792-8962-90d924ce7faa",
          threadId: "019d9762-19f7-7792-8962-90d924ce7faa",
        }),
      }));
    },
  );
});
