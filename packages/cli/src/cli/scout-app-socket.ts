// The Scout app's local socket (ScoutAppControlServer.swift), for CLI verbs
// that need the app itself: one JSON line in, one out. Same contract as the
// web bridge's client in packages/web/server/core/mobile/scout-app-socket.ts.

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenScoutHomeForEnv } from "@openscout/runtime/config";

export type ScoutAppReply =
  | { ok: true; [field: string]: unknown }
  | { ok: false; code: string; message: string };

export function scoutAppSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENSCOUT_APP_SOCKET?.trim();
  if (explicit) return explicit;
  return join(resolveOpenScoutHomeForEnv(env), "run", "scout-app.sock");
}

export function askScoutApp(
  request: { op: string; [field: string]: unknown },
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ScoutAppReply> {
  const unavailable = (message: string): ScoutAppReply => ({ ok: false, code: "scout_app_unavailable", message });
  return new Promise((resolve) => {
    const socket = createConnection(scoutAppSocketPath(options.env));
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
    socket.on("connect", () => socket.write(`${JSON.stringify({ schema: "scout-app.request.v1", ...request })}\n`));
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
