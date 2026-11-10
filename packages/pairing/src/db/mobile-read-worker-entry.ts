/** Synchronous SQLite belongs here, never on the encrypted bridge's event loop. */
import { parentPort } from "node:worker_threads";
import { queryFleet } from "./fleet.ts";
import { queryMobileAgentDetail } from "./mobile/agents.ts";
import { queryTerminalSessions } from "./terminal-sessions.ts";
import { queryHeartrate } from "./activity.ts";

parentPort!.on("message", ({ id, kind, options }) => {
  try {
    let value: unknown;
    switch (kind) {
      case "fleet": value = queryFleet(options); break;
      case "heartrate": value = queryHeartrate(); break;
      case "agentDetail": value = queryMobileAgentDetail(options); break;
      case "terminalSessions": value = queryTerminalSessions(options); break;
      default: throw new Error(`Unknown mobile read: ${kind}`);
    }
    parentPort!.postMessage({ id, value });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
