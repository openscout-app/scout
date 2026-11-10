import { parentPort } from "node:worker_threads";
import {
  runInQuickJS,
  type SandboxFunction,
  type SandboxHostMessage,
  type SandboxWorkerMessage,
} from "./task-callback-sandbox-engine.js";

/**
 * One callback run per worker. The host sends `run`, answers each `call` with
 * `settled`, and terminates the worker once it reports `done` or `halted`.
 */
if (!parentPort) throw new Error("the callback sandbox requires a parent port");
const port = parentPort;
const post = (message: SandboxWorkerMessage) => port.postMessage(message);

let nextCallId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

port.on("message", (message: SandboxHostMessage) => {
  if (message.type === "settled") {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(message.error));
    return;
  }
  if (message.type !== "run") return;
  const scout: Record<string, SandboxFunction> = {};
  for (const name of message.functions) {
    scout[name] = (...args: unknown[]) => new Promise((resolve, reject) => {
      const id = ++nextCallId;
      pending.set(id, { resolve, reject });
      post({ type: "call", id, name, args });
    });
  }
  void runInQuickJS({
    code: message.code,
    data: message.data,
    scout,
    limits: message.limits,
    onLog: (line) => post({ type: "log", line }),
    // Sent from inside the interrupt handler: the guest may never give the
    // thread back, so the host must not wait for `done`.
    onHalt: (reason) => post({ type: "halted", reason }),
  }).then(
    (run) => post({ type: "done", run }),
    (error: unknown) => post({ type: "done", run: { ok: false, error: `the callback sandbox failed: ${error instanceof Error ? error.message : String(error)}`, logs: [] } }),
  );
});
