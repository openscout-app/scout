// Operator input for a thread already loaded by the local Codex daemon.
// A short-lived client reads and addresses the thread by id. It leaves the
// original client's subscription, turn settings and approval requests alone.
import { join } from "node:path";
import { connectCodexAppServerSocket, defaultCodexAppServerControlSocketPath } from "./codex-app-server-connection.js";

export type LoadedCodexThread =
  | { state: "idle" }
  | { state: "active"; turnId: string }
  | { state: "blocked"; reason: "approval" | "input" | "unavailable" };

type Request = <T>(method: string, params: unknown) => Promise<T>;
type SendResult = "accepted" | "changed" | "refused" | "unconfirmed";

function localSocket(): string {
  return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "app-server-control", "app-server-control.sock") : defaultCodexAppServerControlSocketPath();
}

class RpcRefusal extends Error {}

async function withDaemon<T>(socketPath: string, use: (request: Request) => Promise<T>): Promise<T> {
  // Calls on this connection run sequentially. Ignore notifications and
  // requests for the client that owns the session, even if their ids collide.
  let sequence = 0;
  let pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  const connection = await connectCodexAppServerSocket({ socketPath, connectTimeoutMs: 1200, handlers: {
    onMessage(text) {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (!pending || !message || message.method || message.id !== pending.id) return;
      if (message.error) pending.reject(new RpcRefusal("Codex refused the request."));
      else if ("result" in message) pending.resolve(message.result);
    },
    onClose() { pending?.reject(new Error("Codex disconnected.")); },
  } });
  const request: Request = async <R>(method: string, params: unknown) => {
    const id = String(++sequence);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<R>((resolve, reject) => {
        pending = { id, resolve: value => resolve(value as R), reject };
        timer = setTimeout(() => reject(new Error("Codex did not respond.")), 3000);
        connection.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer); pending = undefined; }
  };
  try {
    await request("initialize", { clientInfo: { name: "scout", version: "1" }, capabilities: { experimentalApi: true } });
    connection.send(JSON.stringify({ method: "initialized" }));
    return await use(request);
  } finally { await connection.close(); }
}

type Turn = { id: string; status: string };
type ThreadRead = { thread: { id: string; historyMode?: string; status: { type: string; activeFlags?: string[] }; turns?: Turn[] } };

async function readThread(request: Request, threadId: string): Promise<LoadedCodexThread | null> {
  const { thread } = await request<ThreadRead>("thread/read", { threadId });
  if (thread.id !== threadId || thread.status.type === "notLoaded") return null;
  if (thread.status.type === "idle") return { state: "idle" };
  if (thread.status.type === "active") {
    const flags = thread.status.activeFlags;
    if (flags?.includes("waitingOnApproval")) return { state: "blocked", reason: "approval" };
    if (flags?.includes("waitingOnUserInput")) return { state: "blocked", reason: "input" };
    if (flags?.length === 0) {
      let turn: Turn | undefined;
      if (thread.historyMode === "legacy") {
        // Legacy rollouts expose turns on thread/read instead of the paging API.
        const detail = await request<ThreadRead>("thread/read", { threadId, includeTurns: true }).catch(() => null);
        if (detail?.thread.id === threadId && detail.thread.status.type === "active" && detail.thread.status.activeFlags?.length === 0) {
          turn = detail.thread.turns?.at(-1);
        }
      } else {
        const page = await request<{ data: Turn[] }>("thread/turns/list", {
          threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        }).catch(() => null);
        turn = page?.data?.[0];
      }
      if (turn?.status === "inProgress" && turn.id) return { state: "active", turnId: turn.id };
    }
  }
  return { state: "blocked", reason: "unavailable" };
}

export async function inspectLoadedCodexThread(threadId: string, socketPath = localSocket()): Promise<LoadedCodexThread | null> {
  try { return await withDaemon(socketPath, request => readThread(request, threadId)); }
  catch { return null; }
}

export async function sendToLoadedCodexThread(threadId: string, expected: Exclude<LoadedCodexThread, { state: "blocked" }>, text: string, socketPath = localSocket()): Promise<SendResult> {
  let submitting = false;
  try {
    return await withDaemon(socketPath, async request => {
      const current = await readThread(request, threadId);
      if (current?.state !== expected.state) return "changed";
      if (current.state === "active" && expected.state === "active" && current.turnId !== expected.turnId) return "changed";
      const input = [{ type: "text", text, text_elements: [] }];
      submitting = true;
      if (expected.state === "active") {
        const result = await request<{ turnId: string }>("turn/steer", { threadId, expectedTurnId: expected.turnId, input });
        return result?.turnId === expected.turnId ? "accepted" : "unconfirmed";
      }
      const result = await request<{ turn?: { id?: string } }>("turn/start", { threadId, input });
      return result?.turn?.id ? "accepted" : "unconfirmed";
    });
  } catch (error) {
    if (!submitting) return "changed";
    return error instanceof RpcRefusal ? "refused" : "unconfirmed";
  }
}
