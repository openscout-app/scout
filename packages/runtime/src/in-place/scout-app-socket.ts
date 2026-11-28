// The Scout app's local socket (ScoutAppControlServer.swift): what the bridge
// asks of the app because only the app holds the permission. One JSON line
// in, one out, like scoutd's probe socket beside it in ~/.openscout/run.

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenScoutSocketDirectory } from "../instance.js";

const REQUEST_SCHEMA = "scout-app.request.v1";

export type ScoutAppReply =
  | { ok: true; [field: string]: unknown }
  | { ok: false; code: string; message: string };

export function scoutAppSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENSCOUT_APP_SOCKET?.trim();
  if (explicit) return explicit;
  const preferred = join(resolveOpenScoutSocketDirectory({ env }), "app.sock");
  if (existsSync(preferred)) return preferred;
  const legacy = join(env.OPENSCOUT_HOME?.trim() || join(homedir(), ".openscout"), "run", "scout-app.sock");
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/** Resolves with the app's reply; `scout_app_unavailable` when nothing answers. */
export function askScoutApp(
  request: { op: string; [field: string]: unknown },
  options: { timeoutMs?: number; socketPath?: string } = {},
): Promise<ScoutAppReply> {
  const unavailable = (message: string): ScoutAppReply => ({ ok: false, code: "scout_app_unavailable", message });
  return new Promise((resolve) => {
    const socket = createConnection(options.socketPath ?? scoutAppSocketPath());
    let buffer = "";
    let settled = false;
    const finish = (reply: ScoutAppReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(unavailable("The Scout app didn't answer in time.")), options.timeoutMs ?? 10_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ schema: REQUEST_SCHEMA, ...request })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as ScoutAppReply;
        finish(reply.ok === true || typeof reply.code === "string" ? reply : unavailable("The Scout app sent an unreadable reply."));
      } catch {
        finish(unavailable("The Scout app sent an unreadable reply."));
      }
    });
    socket.on("error", () => finish(unavailable("The Scout app isn't running.")));
    socket.on("close", () => finish(unavailable("The Scout app closed the socket without answering.")));
  });
}
