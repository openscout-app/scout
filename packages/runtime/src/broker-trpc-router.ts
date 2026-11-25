import { tailEventMatches } from "./tail/recent-filter.js";
// Broker tRPC router — typed surface for cross-process consumers (bridge, web).
//
// Today: tail.events plus topology snapshots/events. Future: agent-activity,
// control events, etc. Each new firehose endpoint adds a procedure here;
// consumers get full type inference end-to-end via `BrokerRouter`.
//
// The router is mounted by broker-daemon.ts via @trpc/server/adapters/ws onto
// the existing http server's upgrade event for path /trpc.
//
// See docs/tail-firehose.md.

import { initTRPC, tracked } from "@trpc/server";
// Importing this side-effect-free type pulls the internal tRPC module path
// into our import graph, which lets `tsc --declaration` reference it without
// emitting the "inferred type cannot be named" error (TS2742).
import type {} from "@trpc/server/unstable-core-do-not-import";
import type { ControlEvent } from "@openscout/protocol";
import { z } from "zod";

import {
  snapshotPresenceControlEvents,
  snapshotRecentControlEvents,
  subscribeControlEvents,
} from "./broker-control-events.js";
import {
  getTailDiscovery,
  refreshTailDiscovery,
  readRecentLiveEvents,
  readTailEventsForSession,
  readRecentTranscriptEvents,
  type TailEvent,
} from "./tail/index.js";
import {
  getHarnessTopologySnapshot,
  snapshotRecentHarnessTopologyEvents,
  subscribeHarnessTopology,
  type HarnessTopologyEvent,
} from "./harness-topology/index.js";

import { boundedEventIterable, StreamResyncRequired } from "./bounded-event-iterable.js";
import { attachTailReplay, tailReplayEpoch } from "./tail/service.js";
import type { TailReplayCapture } from "./tail/replay-buffer.js";

import {
  tailReplaySelection,
  tailResyncData,
  TailResyncRequired,
  type TailSubscriptionStatus,
} from "./tail/wire-contract.js";

const t = initTRPC.create({
  errorFormatter({ shape, error, path }) {
    const tail = tailResyncData(path, error);
    return tail ? { ...shape, data: { ...shape.data, tail } } : shape;
  },
});

const CONTROL_BACKLOG_LIMIT = 500;
const TAIL_BACKLOG_LIMIT = 500;
const TOPOLOGY_BACKLOG_LIMIT = 200;

const controlEventsInput = z
  .object({
    since: z.string().optional(),
    kinds: z.array(z.string()).optional(),
  })
  .optional();

const tailEventsInput = z
  .object({
    since: z.string().optional(),
    sources: z.array(z.string()).optional(),
    tailProtocol: z.literal(1).optional(),
    sinceEpoch: z.string().uuid().optional(),
  })
  .refine(
    input => input.sinceEpoch === undefined ||
      (input.tailProtocol === 1 && !!input.since),
    { message: "sinceEpoch requires tailProtocol 1 and a nonempty since." },
  )
  .optional();

const tailRecentInput = z
  .object({
    limit: z.number().int().min(1).max(1_000).optional(),
    sources: z.array(z.string()).optional(),
    kinds: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
    project: z.string().optional(),
    cwd: z.string().optional(),
    query: z.string().optional(),
    transcripts: z.boolean().optional(),
  })
  .optional();

const topologyEventsInput = z
  .object({
    since: z.string().optional(),
    sources: z.array(z.string()).optional(),
  })
  .optional();

function controlEventIterable(kinds: string[] | undefined, signal?: AbortSignal): AsyncIterable<ControlEvent> {
  const filter = kinds?.length ? new Set(kinds) : null;
  return boundedEventIterable({ subscribe: subscribeControlEvents, signal,
    accepts: event => !filter || filter.has(event.kind), id: event => event.id });
}

function topologyEventIterable(sources: string[] | undefined, signal?: AbortSignal): AsyncIterable<HarnessTopologyEvent> {
  const filter = sources?.length ? new Set(sources) : null;
  return boundedEventIterable({ subscribe: subscribeHarnessTopology, signal,
    accepts: event => !filter || filter.has(event.source), id: event => event.id });
}


const controlRouter = t.router({
  events: t.procedure
    .input(controlEventsInput)
    .subscription(async function* ({ input, signal }) {
      const kinds = input?.kinds;
      const filter = kinds && kinds.length > 0 ? new Set(kinds) : null;

      const backlog = snapshotRecentControlEvents(CONTROL_BACKLOG_LIMIT);
      let startIdx = 0;
      if (input?.since) {
        const idx = backlog.findIndex((event: ControlEvent) => event.id === input.since);
        if (idx >= 0) startIdx = idx + 1;
      }
      for (let i = startIdx; i < backlog.length; i++) {
        const event = backlog[i];
        if (!event) continue;
        if (filter && !filter.has(event.kind)) continue;
        yield tracked(event.id, event);
      }

      // Presence is snapshot, not replayed: the latest-per-agent map is the
      // whole state a new subscriber needs, and it is sent regardless of
      // `since` because a resumed stream still missed every transition while it
      // was disconnected. Sent after the backlog so current presence wins.
      for (const event of snapshotPresenceControlEvents()) {
        if (filter && !filter.has(event.kind)) continue;
        yield tracked(event.id, event);
      }

      for await (const event of controlEventIterable(kinds, signal)) {
        yield tracked(event.id, event);
      }
    }),
});

// Closing the capture before returning wakes a generator blocked on live next.
// AsyncGenerator.return() alone queues behind that pending next operation.
function tailEvents(
  input: z.infer<typeof tailEventsInput>,
  signal?: AbortSignal,
): AsyncIterableIterator<ReturnType<typeof tracked<TailEvent>> | TailSubscriptionStatus> {
  let capture: TailReplayCapture | undefined;
  let lastDeliveredId: string | undefined;
  let epoch = tailReplayEpoch();
  const resync = () =>
    input?.tailProtocol === 1
      ? new TailResyncRequired(epoch, lastDeliveredId)
      : new StreamResyncRequired(lastDeliveredId);
  const iterator = (async function* () {
    const sources = input?.sources;
    const filter = sources && sources.length > 0 ? new Set(sources) : null;

    epoch = tailReplayEpoch();
    try {
      capture = attachTailReplay({ limit: TAIL_BACKLOG_LIMIT, sources, signal });
      const backlog = capture.image.entries;
      epoch = capture.image.epoch;
      const { startIndex: startIdx, status } = tailReplaySelection(capture.image, input);
      if (!capture.check()) return;
      // This untracked control frame is legal only first in a v1 generation.
      if (input?.tailProtocol === 1) yield status;
      for (let i = startIdx; i < backlog.length; i++) {
        if (!capture.check()) return;
        const event = backlog[i].event;
        if (filter && !filter.has(event.source)) continue;
        const frame = tracked(event.id, event);
        lastDeliveredId = event.id;
        yield frame;
      }
      // Resume is the explicit `since` input. tRPC lastEventId is not
      // automatically translated into it; neither implies durable history.
      for (;;) {
        const item = await capture.live.next();
        if (item.done || !capture.check()) return;
        const event = item.value.event;
        const frame = tracked(event.id, event);
        lastDeliveredId = event.id;
        yield frame;
      }
    } catch (error) {
      if (error instanceof StreamResyncRequired) throw resync();
      throw error;
    } finally {
      capture?.close();
    }
  })();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => iterator.next(),
    return: () => {
      capture?.close();
      return iterator.return();
    },
    throw: async (error) => {
      capture?.close();
      try {
        return await iterator.throw(error);
      } catch (cause) {
        if (cause instanceof StreamResyncRequired) throw resync();
        throw cause;
      }
    },
  };
}

const tailRouter = t.router({
  recent: t.procedure
    .input(tailRecentInput)
    .query(async ({ input }) => {
      const limit = input?.limit ?? TAIL_BACKLOG_LIMIT;
      const bufferedEvents = await readRecentLiveEvents(limit, { sources: input?.sources, sessionId: input?.sessionId });
      const eventsById = new Map<string, TailEvent>();

      if (input?.transcripts && input.sessionId) {
        const history = await readTailEventsForSession(input.sessionId, { limit, includeAllSources: true, sources: input.sources });
        for (const event of history?.events ?? []) eventsById.set(event.id, event);
      } else if (input?.transcripts) {
        const cached = await getTailDiscovery();
        const discovery = cached.readStatus?.initialized ? cached : await refreshTailDiscovery("shallow");
        const transcriptEvents = await readRecentTranscriptEvents(limit, {
          discovery, sources: input.sources,
          perTranscriptLineLimit: Math.min(200, Math.max(50, limit)),
        });
        for (const event of transcriptEvents) {
          eventsById.set(event.id, event);
        }
      }
      for (const event of bufferedEvents) {
        eventsById.set(event.id, event);
      }

      const events = [...eventsById.values()]
        .filter((event) => tailEventMatches(event, input))
        .sort((left, right) => {
          if (left.ts === right.ts) return left.id.localeCompare(right.id);
          return left.ts - right.ts;
        })
        .slice(-limit);

      return {
        generatedAt: Date.now(),
        limit,
        cursor: events.at(-1)?.id ?? null,
        events,
      };
    }),
  events: t.procedure
    .input(tailEventsInput)
    .subscription(({ input, signal }) => tailEvents(input, signal)),
});

const topologyRouter = t.router({
  snapshot: t.procedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(({ input }) => getHarnessTopologySnapshot(Boolean(input?.force))),
  events: t.procedure
    .input(topologyEventsInput)
    .subscription(async function* ({ input, signal }) {
      const sources = input?.sources;
      const filter = sources && sources.length > 0 ? new Set(sources) : null;

      const backlog = snapshotRecentHarnessTopologyEvents(TOPOLOGY_BACKLOG_LIMIT);
      let startIdx = 0;
      if (input?.since) {
        const idx = backlog.findIndex((e: HarnessTopologyEvent) => e.id === input.since);
        if (idx >= 0) startIdx = idx + 1;
      }
      for (let i = startIdx; i < backlog.length; i++) {
        const event = backlog[i];
        if (!event) continue;
        if (filter && !filter.has(event.source)) continue;
        yield tracked(event.id, event);
      }

      for await (const event of topologyEventIterable(sources, signal)) {
        yield tracked(event.id, event);
      }
    }),
});

export const brokerRouter = t.router({
  control: controlRouter,
  tail: tailRouter,
  topology: topologyRouter,
});

export type BrokerRouter = typeof brokerRouter;
