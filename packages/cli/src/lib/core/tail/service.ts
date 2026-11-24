import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { BrokerRouter } from "@openscout/runtime/client";
import type { TailEvent, TailEventKind } from "@openscout/runtime/harnesses";

import { resolveScoutBrokerUrl } from "../broker/service.ts";

export type ScoutTailRecentOptions = {
  limit?: number;
  sources?: string[];
  kinds?: TailEventKind[];
  sessionId?: string;
  project?: string;
  cwd?: string;
  query?: string;
  transcripts?: boolean;
  baseUrl?: string;
};

export type ScoutTailRecentResult = {
  generatedAt: number;
  limit: number;
  cursor: string | null;
  events: TailEvent[];
};

export type ScoutTailWatchOptions = {
  since?: string;
  sources?: string[];
  signal?: AbortSignal;
  baseUrl?: string;
  onEvent: (event: TailEvent) => void;
};

export type { TailEvent, TailEventKind };

function brokerWsUrl(baseUrl: string): string {
  const url = new URL("/trpc", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createTailClient(baseUrl: string) {
  const wsClient = createWSClient({ url: brokerWsUrl(baseUrl) });
  const trpc = createTRPCClient<BrokerRouter>({
    links: [wsLink({ client: wsClient })],
  });
  return { trpc, wsClient };
}

export async function readScoutTailEvents(
  options: ScoutTailRecentOptions = {},
): Promise<ScoutTailRecentResult> {
  const { trpc, wsClient } = createTailClient(options.baseUrl ?? resolveScoutBrokerUrl());
  try {
    return await trpc.tail.recent.query({
      limit: options.limit,
      sources: options.sources,
      kinds: options.kinds,
      sessionId: options.sessionId,
      project: options.project,
      cwd: options.cwd,
      query: options.query,
      transcripts: options.transcripts,
    });
  } finally {
    wsClient.close();
  }
}

export function watchScoutTailEvents(
  options: ScoutTailWatchOptions,
): Promise<void> {
  const { trpc, wsClient } = createTailClient(options.baseUrl ?? resolveScoutBrokerUrl());

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe: () => void } | null = null;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      wsClient.close();
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };

    const abort = () => finish();

    options.signal?.addEventListener("abort", abort, { once: true });

    subscription = trpc.tail.events.subscribe(
      {
        since: options.since,
        sources: options.sources,
      },
      {
        onData(data) {
          const event = (data as { data?: TailEvent }).data;
          if (event) {
            options.onEvent(event);
          }
        },
        onError(error) {
          finish(error);
        },
      },
    );
  });
}
