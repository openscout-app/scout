import { resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  loadScoutBrokerContext,
  resolveScoutBrokerUrl,
  resolveScoutSenderId,
  replyToScoutMessage,
  sendScoutMessage,
  sendScoutMessageToAgentIds,
  askScoutAgentById,
  type ScoutBrokerContext,
} from "../broker/service.ts";
import { SCOUT_APP_VERSION } from "../../shared/product.ts";
import {
  isInboxClaimableDeliveryStatus,
  type AgentEndpoint,
  type InboxItem,
  type MessageRecord,
} from "@openscout/protocol";
import { waitForStdioServerClosure } from "./stdio-server-lifecycle.ts";

type InboxStreamEvent = {
  item?: InboxItem;
  items?: InboxItem[];
};

const scoutChannelStartedAt = Date.now();

async function resolveAgentId(
  currentDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return resolveScoutSenderId(undefined, currentDirectory, env);
}

function startBrokerSubscription(
  broker: ScoutBrokerContext,
  agentId: string,
  onMessage: (message: MessageRecord) => Promise<boolean> | boolean,
  signal: AbortSignal,
): void {
  const connect = async () => {
    while (!signal.aborted) {
      try {
        const streamUrl = new URL("/v1/inbox/stream", broker.baseUrl);
        streamUrl.searchParams.set("targetId", agentId);
        const response = await fetch(
          streamUrl,
          { headers: { accept: "text/event-stream" }, signal },
        );
        if (!response.ok || !response.body) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let delimiterIndex: number;
          while ((delimiterIndex = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, delimiterIndex).trim();
            buffer = buffer.slice(delimiterIndex + 2);
            if (!block) continue;

            let eventName = "";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:"))
                eventName = line.slice("event:".length).trim();
              if (line.startsWith("data:"))
                dataLines.push(line.slice("data:".length).trim());
            }

            if (!["snapshot", "inbox.item", "inbox.item.updated"].includes(eventName) || dataLines.length === 0)
              continue;

            let event: InboxStreamEvent | InboxItem;
            try {
              event = JSON.parse(dataLines.join("\n")) as InboxStreamEvent | InboxItem;
            } catch {
              continue;
            }

            const items = eventName === "snapshot"
              ? ((event as InboxStreamEvent).items ?? [])
              : [("item" in (event as InboxStreamEvent) ? (event as InboxStreamEvent).item : event as InboxItem)]
                .filter((item): item is InboxItem => Boolean(item));

            for (const item of items) {
              if (!isInboxClaimableDeliveryStatus(item.status)) {
                continue;
              }
              if (!item.message || item.message.actorId === agentId) {
                continue;
              }
              const claim = await claimInboxItem(broker, {
                itemId: item.id,
                targetId: agentId,
              });
              if (!claim?.message) {
                continue;
              }
              const delivered = await onMessage(claim.message);
              if (delivered) {
                await ackInboxItem(broker, {
                  itemId: claim.id,
                  leaseOwner: `scout-channel:${agentId}`,
                  leaseGeneration: claim.leaseGeneration,
                });
              } else {
                await nackInboxItem(broker, {
                  itemId: claim.id,
                  leaseOwner: `scout-channel:${agentId}`,
                  leaseGeneration: claim.leaseGeneration,
                  reason: "channel notification was not accepted by host",
                });
              }
            }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        const msg =
          error instanceof Error ? error.message : String(error);
        if (msg.includes("AbortError")) return;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  void connect();
}

function displayNameForChannelActor(
  broker: ScoutBrokerContext,
  message: MessageRecord,
): string {
  return (
    broker.snapshot.agents[message.actorId]?.displayName?.trim()
    || broker.snapshot.actors[message.actorId]?.displayName?.trim()
    || message.mentions?.find((mention) => mention.actorId === message.actorId)?.label?.trim()
    || message.actorId
  );
}

async function postBrokerJson<T>(
  broker: ScoutBrokerContext,
  path: string,
  payload: unknown,
): Promise<T | null> {
  try {
    const response = await fetch(new URL(path, broker.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

async function claimInboxItem(
  broker: ScoutBrokerContext,
  input: {
    itemId: string;
    targetId: string;
  },
): Promise<InboxItem | null> {
  const result = await postBrokerJson<{ claimed?: InboxItem | null }>(
    broker,
    "/v1/inbox/claim",
    {
      itemId: input.itemId,
      targetId: input.targetId,
      leaseOwner: `scout-channel:${input.targetId}`,
      leaseMs: 30_000,
    },
  );
  return result?.claimed ?? null;
}

async function ackInboxItem(
  broker: ScoutBrokerContext,
  input: { itemId: string; leaseOwner: string; leaseGeneration?: number },
): Promise<void> {
  await postBrokerJson(broker, "/v1/inbox/ack", input);
}

async function nackInboxItem(
  broker: ScoutBrokerContext,
  input: { itemId: string; leaseOwner: string; leaseGeneration?: number; reason?: string },
): Promise<void> {
  await postBrokerJson(broker, "/v1/inbox/nack", input);
}

function scoutChannelEndpointId(agentId: string): string {
  return `claude-channel:${agentId}:${process.pid}`;
}

function buildScoutChannelEndpoint(input: {
  broker: ScoutBrokerContext;
  agentId: string;
  currentDirectory: string;
  state: AgentEndpoint["state"];
}): AgentEndpoint {
  const now = Date.now();
  return {
    id: scoutChannelEndpointId(input.agentId),
    agentId: input.agentId,
    nodeId: input.broker.node.id,
    harness: "claude",
    transport: "claude_channel",
    state: input.state,
    sessionId: process.env.CLAUDE_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? String(process.pid),
    cwd: input.currentDirectory,
    projectRoot: input.currentDirectory,
    metadata: {
      source: "scout-channel",
      processId: process.pid,
      startedAt: scoutChannelStartedAt,
      lastSeenAt: now,
    },
  };
}

async function upsertScoutChannelEndpoint(input: {
  broker: ScoutBrokerContext;
  agentId: string;
  currentDirectory: string;
  state: AgentEndpoint["state"];
}): Promise<void> {
  await postBrokerJson(input.broker, "/v1/endpoints", buildScoutChannelEndpoint(input));
}

function startScoutChannelHeartbeat(input: {
  broker: ScoutBrokerContext;
  agentId: string;
  currentDirectory: string;
  signal: AbortSignal;
}): void {
  const heartbeat = async () => {
    if (input.signal.aborted) return;
    await upsertScoutChannelEndpoint({ ...input, state: "active" });
  };

  void heartbeat();
  const interval = setInterval(() => void heartbeat(), 15_000);
  input.signal.addEventListener("abort", () => {
    clearInterval(interval);
    void upsertScoutChannelEndpoint({ ...input, state: "offline" });
  }, { once: true });
}

export async function runScoutChannelServer(options: {
  defaultCurrentDirectory: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = options.env ?? process.env;
  const currentDirectory = resolve(
    options.defaultCurrentDirectory || process.cwd(),
  );

  const agentId = await resolveAgentId(currentDirectory, env);
  const brokerUrl =
    env.OPENSCOUT_BROKER_URL?.trim() || resolveScoutBrokerUrl();
  const broker = await loadScoutBrokerContext(brokerUrl);
  if (!broker) {
    throw new Error("Scout broker is not reachable. Run 'scout doctor' to check.");
  }

  const server = new Server(
    { name: "scout", version: SCOUT_APP_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: [
        "You are connected to the Scout agent mesh.",
        "Incoming messages from other agents arrive as <channel source=\"scout\" ...> tags.",
        "Read them and respond. Use the scout_reply tool with conversation_id and message_id to send threaded acknowledgements, progress, and completions back through the mesh.",
        "Use scout_send for unprompted messages to other agents.",
        `Your agent ID is ${agentId}.`,
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "scout_reply",
        description:
          "Reply to a Scout message through the mesh. Use this when responding to an incoming channel message.",
        inputSchema: {
          type: "object" as const,
          properties: {
            to: {
              type: "string",
              description:
                "The agent ID to reply to (from the channel message's from_agent_id attribute)",
            },
            text: {
              type: "string",
              description: "The reply message body",
            },
            conversation_id: {
              type: "string",
              description:
                "The conversation ID from the incoming message (from the channel message's conversation_id attribute). Optional.",
            },
            message_id: {
              type: "string",
              description:
                "The incoming message ID to reply to (from the channel message's message_id attribute). Optional.",
            },
          },
          required: ["to", "text"],
        },
      },
      {
        name: "scout_send",
        description:
          "Send a new message to another Scout agent. Use this for initiating contact, not for replies.",
        inputSchema: {
          type: "object" as const,
          properties: {
            to: {
              type: "string",
              description: "The target agent ID or @handle",
            },
            text: {
              type: "string",
              description: "The message body",
            },
          },
          required: ["to", "text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, string>;

    if (req.params.name === "scout_reply") {
      const to = args.to?.trim();
      const text = args.text?.trim();
      if (!to || !text) {
        return {
          content: [{ type: "text", text: "Missing 'to' or 'text' argument." }],
          isError: true,
        };
      }

      const conversationId = args.conversation_id?.trim();
      const replyToMessageId = args.message_id?.trim();
      if (conversationId && replyToMessageId) {
        const result = await replyToScoutMessage({
          senderId: agentId,
          body: text,
          conversationId,
          replyToMessageId,
          currentDirectory,
          source: "scout-channel",
        });

        if (result.routingError || !result.usedBroker) {
          return {
            content: [
              {
                type: "text",
                text: `Scout reply was not sent: ${result.routingError ?? "broker is not reachable"}.`,
              },
            ],
            isError: true,
          };
        }
      } else {
        await sendScoutMessageToAgentIds({
          senderId: agentId,
          body: text,
          targetAgentIds: [to],
          currentDirectory,
          source: "scout-channel",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Replied to ${to}.`,
          },
        ],
      };
    }

    if (req.params.name === "scout_send") {
      const to = args.to?.trim();
      const text = args.text?.trim();
      if (!to || !text) {
        return {
          content: [{ type: "text", text: "Missing 'to' or 'text' argument." }],
          isError: true,
        };
      }

      await sendScoutMessageToAgentIds({
        senderId: agentId,
        body: text,
        targetAgentIds: [to],
        currentDirectory,
        source: "scout-channel",
      });

      return {
        content: [
          {
            type: "text",
            text: `Sent to ${to}.`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const abortController = new AbortController();
  server.onclose = () => abortController.abort();

  startScoutChannelHeartbeat({
    broker,
    agentId,
    currentDirectory,
    signal: abortController.signal,
  });

  startBrokerSubscription(
    broker,
    agentId,
    async (message) => {
      const senderName = displayNameForChannelActor(broker, message);

      const meta: Record<string, string> = {
        from_agent_id: message.actorId,
        from_name: senderName,
        conversation_id: message.conversationId,
        message_id: message.id,
        message_class: message.class,
      };

      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[${senderName}] ${message.body}`,
            meta,
          },
        });
        return true;
      } catch {
        // Session may not be ready yet; drop silently.
        return false;
      }
    },
    abortController.signal,
  );

  try {
    await waitForStdioServerClosure({ server, transport });
  } finally {
    abortController.abort();
  }
}
