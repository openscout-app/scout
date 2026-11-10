import { Worker } from "node:worker_threads";
import {
  DEFAULT_SANDBOX_LIMITS,
  sliceError,
  timeoutError,
  type SandboxFunction,
  type SandboxHostMessage,
  type SandboxLimits,
  type SandboxRun,
  type SandboxWorkerMessage,
} from "./task-callback-sandbox-engine.js";

export { DEFAULT_SANDBOX_LIMITS, type SandboxFunction, type SandboxLimits, type SandboxRun };

/** Time past the budget the worker gets to report its own timeout before it is ended. */
const REPORT_GRACE_MS = 250;

/**
 * Evaluates `code` as an ES module and calls its default export with `data`
 * plus a `scout` object of the given functions. The guest runs in QuickJS on a
 * worker thread of its own; the `scout` functions run here. Resolves when the
 * function's return value settles, the code throws, or a limit runs out. A
 * guest that overruns is ended with `terminate()`, so no callback can hold the
 * runtime's thread or outlive its budget.
 */
export function runSandboxedFunction(input: {
  code: string;
  data: Record<string, unknown>;
  scout: Record<string, SandboxFunction>;
  limits?: Partial<SandboxLimits>;
  /** Tests point this at a fixture; the runtime uses the sibling entry. */
  workerUrl?: URL;
}): Promise<SandboxRun> {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...input.limits };
  // The bundled runtime ships the entry as a sibling .js file
  // (packages/cli/scripts/runtime-entrypoints.mjs).
  const url = input.workerUrl ?? new URL(import.meta.url.endsWith(".ts")
    ? "./task-callback-sandbox-worker-entry.ts" : "./task-callback-sandbox-worker-entry.js", import.meta.url);
  const logs: string[] = [];

  return new Promise<SandboxRun>((resolve) => {
    let finished = false;
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      resolve({ ok: false, error: `the callback sandbox did not start: ${error instanceof Error ? error.message : String(error)}`, logs });
      return;
    }
    const finish = (run: SandboxRun) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(run);
    };
    const fail = (error: string) => finish({ ok: false, error, logs: [...logs] });
    const timer = setTimeout(() => fail(timeoutError(limits)), limits.timeoutMs + REPORT_GRACE_MS);
    const send = (message: SandboxHostMessage) => {
      if (finished) return;
      try {
        worker.postMessage(message);
      } catch (error) {
        // Data or a host result the worker cannot be sent fails the run.
        fail(`the callback sandbox could not be sent its input: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    worker.on("message", (message: SandboxWorkerMessage) => {
      if (finished) return;
      switch (message.type) {
        case "log":
          if (logs.length < limits.logLines) logs.push(message.line);
          return;
        case "halted":
          fail(message.reason === "slice" ? sliceError(limits) : timeoutError(limits));
          return;
        case "done":
          finish(message.run);
          return;
        case "call": {
          const fn = Object.hasOwn(input.scout, message.name) ? input.scout[message.name] : undefined;
          if (!fn) {
            send({ type: "settled", id: message.id, ok: false, error: `scout.${message.name} is not a function` });
            return;
          }
          Promise.resolve()
            .then(() => fn(...message.args))
            .then(
              (value) => send({ type: "settled", id: message.id, ok: true, value }),
              (error: unknown) => send({ type: "settled", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
            )
            // A value that cannot be cloned to the worker fails that call only.
            .catch((error: unknown) => send({ type: "settled", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
          return;
        }
      }
    });
    worker.on("error", (error) => fail(`the callback sandbox failed: ${error instanceof Error ? error.message : String(error)}`));
    worker.on("exit", () => fail("the callback sandbox exited before the run finished"));
    send({ type: "run", code: input.code, data: input.data, functions: Object.keys(input.scout), limits });
  });
}
