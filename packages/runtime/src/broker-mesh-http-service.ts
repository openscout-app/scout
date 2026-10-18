import { readRuntimeMessage } from "./broker-message-records.js";
import { isDeepStrictEqual } from "node:util";
import { canonicalMessageRecord } from "./message-record-canonical.js";
import type {
  AgentDefinition,
  AgentEndpoint,
  DeliveryIntent,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";

import type { BrokerDurableCommitOptions } from "./broker-durable-store.js";
import {
  createInvocationDispatchJob,
  type BrokerInvocationDispatchJob,
} from "./broker-dispatch-job.js";
import type { BrokerJournalEntry } from "./broker-journal.js";
import type {
  MeshCollaborationEventBundle,
  MeshCollaborationRecordBundle,
  MeshInvocationBundle,
  MeshMessageBundle,
} from "./mesh-forwarding.js";

export type BrokerMeshHttpRuntime = {
  message(messageId: string): MessageRecord | undefined;
  readMessage?(messageId:string):Promise<MessageRecord|undefined>;
  planMessage(message: MessageRecord, options?: { localOnly?: boolean }): DeliveryIntent[];
  commitMessage(message: MessageRecord, deliveries: DeliveryIntent[]): Promise<void>;
  agent(agentId: string): AgentDefinition | undefined;
  flightForInvocation(invocationId: string): FlightRecord | undefined;
  planInvocation(invocation: InvocationRequest): FlightRecord;
  commitInvocation(invocation: InvocationRequest, flight: FlightRecord): Promise<void>;
  collaborationRecord(recordId: string): unknown;
};

export type BrokerMeshHttpServiceDeps = {
  nodeId: string;
  runtime: BrokerMeshHttpRuntime;
  runDurableWrite: <T>(work: () => Promise<T>) => Promise<T>;
  applyMeshBundle: (
    bundle: MeshMessageBundle | MeshInvocationBundle | MeshCollaborationRecordBundle | MeshCollaborationEventBundle,
    options?: BrokerDurableCommitOptions,
  ) => Promise<BrokerJournalEntry[]>;
  commitEntries: (
    entries: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options?: BrokerDurableCommitOptions,
  ) => Promise<BrokerJournalEntry[]>;
  applyProjectedEntries: (entries: BrokerJournalEntry[]) => Promise<void>;
  // Cache absence is not canonical absence: rotated records must remain
  // available to the duplicate fence without rehydrating the working set.
  invocationSnapshotFor: (invocationId: string) => Promise<{
    invocation: InvocationRequest | undefined;
    flight: FlightRecord | undefined;
  }>;
  messageFor: (messageId: string) => Promise<MessageRecord | undefined>;
  rememberInvocation: (invocation: InvocationRequest) => void;
  completeInvocationsForBrokerReply?: (message: MessageRecord) => Promise<void>;
  /**
   * Cardless session targets carry no agent card, so authority rides on the
   * endpoint instead: a forwarded invocation is accepted when this node owns a
   * live endpoint for the session actor id (registered by a mesh session wake).
   */
  localEndpointForActor?: (actorId: string) => AgentEndpoint | undefined;
  runDispatchJob?: (
    job: BrokerInvocationDispatchJob,
    invocation: InvocationRequest,
  ) => Promise<void>;
  warn?: (message: string, detail?: unknown) => void;
  now?: () => number;
};

export type BrokerMeshHttpResult = {
  status: number;
  body: unknown;
};

export class BrokerMeshHttpService {
  constructor(private readonly deps: BrokerMeshHttpServiceDeps) {}

  readonly receiveMessageBundle = async (bundle: MeshMessageBundle): Promise<BrokerMeshHttpResult> => {
    const result = await this.deps.runDurableWrite(async () => {
      const existingMessage = await this.deps.messageFor(bundle.message.id);
      if (bundle.conversation.authorityNodeId === this.deps.nodeId
        && existingMessage && !sameCanonicalMessage(existingMessage, bundle.message)) {
        throw new Error(`mesh message ${bundle.message.id} conflicts with existing record`);
      }
      const bundleEntries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });

      if (bundle.conversation.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          bundleEntries,
          authorityNodeId: bundle.conversation.authorityNodeId,
        };
      }

      if (existingMessage) {
        return {
          kind: "duplicate" as const,
          message: existingMessage,
          bundleEntries,
          messageEntries: [] as BrokerJournalEntry[],
          deliveries: [] as DeliveryIntent[],
        };
      }

      const deliveries = this.deps.runtime.planMessage(bundle.message, { localOnly: true });
      const messageEntries = await this.deps.commitEntries(
        [
          { kind: "message.record", message: bundle.message },
          { kind: "deliveries.record", deliveries },
        ],
        async () => {
          await this.deps.runtime.commitMessage(bundle.message, deliveries);
        },
        { enqueueProjection: false },
      );
      const message = await readRuntimeMessage(this.deps.runtime, bundle.message.id);
      if (!message) {
        throw new Error(`mesh message ${bundle.message.id} was not committed`);
      }

      return {
        kind: "ok" as const,
        message,
        bundleEntries,
        messageEntries,
        deliveries,
      };
    });

    if (result.kind === "not_authority") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation.id} is owned by ${result.authorityNodeId}`,
        },
      };
    }

    await this.deps.applyProjectedEntries([...result.bundleEntries, ...result.messageEntries]);
    // Mesh-originated replies are canonical here just like local posts. Settle
    // matching work even if the executor's flight callback is unavailable.
    await this.deps.completeInvocationsForBrokerReply?.(result.message);
    return {
      status: 200,
      body: result.kind === "duplicate"
        ? { ok: true, duplicate: true, message: result.message }
        : { ok: true, deliveries: result.deliveries, message: result.message },
    };
  };

  readonly receiveInvocationBundle = async (bundle: MeshInvocationBundle): Promise<BrokerMeshHttpResult> => {
    if (bundle.message && (
      bundle.message.id !== bundle.invocation.messageId
      || bundle.message.conversationId !== bundle.invocation.conversationId
      || bundle.message.actorId !== bundle.invocation.requesterId
      || bundle.conversation?.id !== bundle.message.conversationId
    )) {
      throw new Error("mesh invocation message does not match its request anchor");
    }
    const result = await this.deps.runDurableWrite(async () => {
      // A retry may repair a missing anchor, but cannot replace the identity
      // of the persisted request. Validate before applying any bundle records.
      const { invocation: persistedInvocation, flight: existing } = await this.deps.invocationSnapshotFor(bundle.invocation.id);
      if (existing && !persistedInvocation) {
        throw new Error(`mesh invocation ${bundle.invocation.id} has no persisted request anchor`);
      }
      if (persistedInvocation && (
        persistedInvocation.id !== bundle.invocation.id
        || persistedInvocation.messageId !== bundle.invocation.messageId
        || persistedInvocation.conversationId !== bundle.invocation.conversationId
        || persistedInvocation.requesterId !== bundle.invocation.requesterId
        || persistedInvocation.requesterNodeId !== bundle.invocation.requesterNodeId
        || persistedInvocation.targetAgentId !== bundle.invocation.targetAgentId
      )) {
        throw new Error(`mesh invocation ${bundle.invocation.id} conflicts with its persisted request anchor`);
      }
      if (persistedInvocation && !existing) {
        throw new Error(`mesh invocation ${bundle.invocation.id} has no persisted flight`);
      }
      if (existing && (
        existing.invocationId !== bundle.invocation.id
        || existing.requesterId !== persistedInvocation!.requesterId
        || existing.targetAgentId !== persistedInvocation!.targetAgentId
      )) {
        throw new Error(`mesh invocation ${bundle.invocation.id} conflicts with its persisted flight`);
      }
      const existingMessage = bundle.message ? await this.deps.messageFor(bundle.message.id) : undefined;
      if (bundle.message && existingMessage && !sameCanonicalMessage(existingMessage, bundle.message)) {
        throw new Error(`mesh invocation message ${bundle.message.id} conflicts with existing record`);
      }
      const bundleEntries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });

      const targetAgent = this.deps.runtime.agent(bundle.invocation.targetAgentId);
      if (!targetAgent) {
        const localEndpoint = this.deps.localEndpointForActor?.(bundle.invocation.targetAgentId);
        if (!localEndpoint) {
          throw new Error(`unknown target agent ${bundle.invocation.targetAgentId}`);
        }
      } else if (targetAgent.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          bundleEntries,
          targetAgent,
        };
      }

      // Keep the original request resolvable by `tell --ref msg-...` on the
      // executor. It is already dispatched by this invocation: no deliveries.
      // Do this on duplicate receipts too, so retries can repair old bundles.
      if (bundle.message) {
        if (!existingMessage) {
          const message = bundle.message;
          bundleEntries.push(...await this.deps.commitEntries(
            { kind: "message.record", message },
            async () => { await this.deps.runtime.commitMessage(message, []); },
            { enqueueProjection: false },
          ));
        }
      }

      if (existing) {
        return {
          kind: "duplicate" as const,
          bundleEntries,
          flight: existing,
        };
      }

      const flight = this.deps.runtime.planInvocation(bundle.invocation);
      const dispatchJob = createInvocationDispatchJob(
        bundle.invocation,
        flight,
        this.now(),
      );
      this.deps.rememberInvocation(bundle.invocation);
      const invocationEntries = await this.deps.commitEntries(
        [
          { kind: "invocation.record", invocation: bundle.invocation },
          { kind: "invocation.dispatch_job.record", job: dispatchJob },
          { kind: "flight.record", flight },
        ],
        async () => {
          await this.deps.runtime.commitInvocation(bundle.invocation, flight);
        },
        { enqueueProjection: false },
      );

      return {
        kind: "ok" as const,
        bundleEntries,
        invocationEntries,
        dispatchJob,
        flight,
      };
    });

    if (result.kind === "not_authority") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `agent ${result.targetAgent.id} is owned by ${result.targetAgent.authorityNodeId}`,
        },
      };
    }

    if (result.kind === "duplicate") {
      await this.deps.applyProjectedEntries(result.bundleEntries);
      return {
        status: 200,
        body: { ok: true, duplicate: true, flight: result.flight },
      };
    }

    await this.deps.applyProjectedEntries([...result.bundleEntries, ...result.invocationEntries]);
    if (this.deps.runDispatchJob) {
      this.deps.runDispatchJob(result.dispatchJob, bundle.invocation).catch((error) => {
        this.deps.warn?.(
          `[openscout-runtime] mesh dispatch job failed for invocation ${bundle.invocation.id}`,
          error,
        );
      });
    }
    return {
      status: 200,
      body: { ok: true, flight: result.flight },
    };
  };

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  readonly receiveCollaborationRecordBundle = async (
    bundle: MeshCollaborationRecordBundle,
  ): Promise<BrokerMeshHttpResult> => {
    const result = await this.deps.runDurableWrite(async () => {
      if (bundle.conversation && bundle.conversation.authorityNodeId !== this.deps.nodeId) {
        return {
          kind: "not_authority" as const,
          authorityNodeId: bundle.conversation.authorityNodeId,
          entries: [] as BrokerJournalEntry[],
          existing: null as unknown,
        };
      }

      const existing = this.deps.runtime.collaborationRecord(bundle.record.id);
      const entries = await this.deps.applyMeshBundle(bundle, {
        enqueueProjection: false,
      });
      return { kind: "ok" as const, existing, entries };
    });

    if (result.kind === "not_authority") {
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation?.id ?? bundle.record.conversationId ?? bundle.record.id} is owned by ${result.authorityNodeId}`,
        },
      };
    }

    await this.deps.applyProjectedEntries(result.entries);
    return {
      status: 200,
      body: result.existing ? { ok: true, duplicate: true } : { ok: true },
    };
  };

  readonly receiveCollaborationEventBundle = async (
    bundle: MeshCollaborationEventBundle,
  ): Promise<BrokerMeshHttpResult> => {
    if (bundle.conversation && bundle.conversation.authorityNodeId !== this.deps.nodeId) {
      return {
        status: 409,
        body: {
          error: "not_authority",
          detail: `conversation ${bundle.conversation.id} is owned by ${bundle.conversation.authorityNodeId}`,
        },
      };
    }

    const entries = await this.deps.runDurableWrite(async () => this.deps.applyMeshBundle(bundle, {
      enqueueProjection: false,
    }));
    await this.deps.applyProjectedEntries(entries);
    return {
      status: 200,
      body: { ok: true },
    };
  };
}

function sameCanonicalMessage(existing: MessageRecord, incoming: MessageRecord): boolean {
  // SQL/history reads normalize optional fields and child-table ordering.
  // Compare the same persisted representation on both sides of a retry.
  return isDeepStrictEqual(canonicalMessageRecord(existing), canonicalMessageRecord(incoming));
}
