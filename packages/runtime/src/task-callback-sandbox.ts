import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";

/**
 * Runs a callback's JavaScript in QuickJS compiled to wasm. The code reaches
 * nothing on the host: no files, processes, network, timers or modules. Its
 * only way out is the async functions passed in as `scout`. Each run gets its
 * own wasm instance, so nothing is shared between runs and whatever a failed
 * run leaves behind is dropped with that instance.
 */
export type SandboxFunction = (...args: unknown[]) => Promise<unknown>;

export type SandboxLimits = {
  memoryBytes: number;
  stackBytes: number;
  /** Wall-clock budget for the whole run, including time spent awaiting host functions. */
  timeoutMs: number;
  logLines: number;
  logLineChars: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  timeoutMs: 10_000,
  logLines: 20,
  logLineChars: 500,
};

export type SandboxRun = { ok: true; logs: string[] } | { ok: false; error: string; logs: string[] };

function describeGuestError(context: QuickJSContext, handle: QuickJSHandle): string {
  const value = context.dump(handle);
  if (value && typeof value === "object") {
    const name = typeof value.name === "string" ? value.name : "Error";
    const message = typeof value.message === "string" ? value.message : JSON.stringify(value);
    return `${name}: ${message}`;
  }
  return String(value);
}

function toGuest(context: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return context.undefined;
  const json = context.newString(JSON.stringify(value));
  try {
    const parse = context.unwrapResult(context.evalCode("JSON.parse"));
    try {
      return context.unwrapResult(context.callFunction(parse, context.undefined, json));
    } finally {
      parse.dispose();
    }
  } finally {
    json.dispose();
  }
}

function drainJobs(runtime: QuickJSRuntime): void {
  if (!runtime.alive) return;
  const result = runtime.executePendingJobs();
  if (result.error) result.error.dispose();
}

/**
 * Evaluates `code` as a function expression and calls it with `data` plus a
 * `scout` object of the given functions. Resolves when the function's return
 * value settles, the code throws, or the time budget runs out.
 */
export async function runSandboxedFunction(input: {
  code: string;
  data: Record<string, unknown>;
  scout: Record<string, SandboxFunction>;
  limits?: Partial<SandboxLimits>;
}): Promise<SandboxRun> {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...input.limits };
  const logs: string[] = [];
  const deadline = Date.now() + limits.timeoutMs;
  // The single-file build carries its wasm inline, so the bundled runtime
  // needs no side file. It loads only when a callback runs.
  const quickjs = await newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-singlefile-mjs-release-sync"));
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const context = runtime.newContext();
  const inFlight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const consoleObject = context.newObject();
    const log = context.newFunction("log", (...args) => {
      if (logs.length >= limits.logLines) return;
      const line = args.map((arg) => {
        const value = context.dump(arg);
        return typeof value === "string" ? value : JSON.stringify(value);
      }).join(" ");
      logs.push(line.length > limits.logLineChars ? `${line.slice(0, limits.logLineChars)}…` : line);
    });
    context.setProp(consoleObject, "log", log);
    log.dispose();
    context.setProp(context.global, "console", consoleObject);
    consoleObject.dispose();

    const argument = toGuest(context, input.data);
    const scoutObject = context.newObject();
    for (const [name, fn] of Object.entries(input.scout)) {
      const handle = context.newFunction(name, (...argHandles) => {
        const args = argHandles.map((arg) => context.dump(arg));
        const deferred = context.newPromise();
        const call: Promise<void> = Promise.resolve()
          .then(() => fn(...args))
          .then(
            (value) => {
              if (!context.alive) return;
              const result = toGuest(context, value);
              deferred.resolve(result);
              if (result !== context.undefined) result.dispose();
            },
            (error: unknown) => {
              if (!context.alive) return;
              const guestError = context.newError(error instanceof Error ? error.message : String(error));
              deferred.reject(guestError);
              guestError.dispose();
            },
          )
          .finally(() => {
            inFlight.delete(call);
            drainJobs(runtime);
          });
        inFlight.add(call);
        return deferred.handle;
      });
      context.setProp(scoutObject, name, handle);
      handle.dispose();
    }
    context.setProp(argument, "scout", scoutObject);
    scoutObject.dispose();

    const compiled = context.evalCode(`(\n${input.code}\n)`, "callback.js");
    if (compiled.error) {
      const error = describeGuestError(context, compiled.error);
      compiled.error.dispose();
      argument.dispose();
      return { ok: false, error, logs };
    }
    const fn = compiled.value;
    if (context.typeof(fn) !== "function") {
      fn.dispose();
      argument.dispose();
      return { ok: false, error: "the callback must be a function", logs };
    }
    const called = context.callFunction(fn, context.undefined, argument);
    fn.dispose();
    argument.dispose();
    if (called.error) {
      const error = describeGuestError(context, called.error);
      called.error.dispose();
      return { ok: false, error, logs };
    }
    const returned = called.value;
    const settled = context.resolvePromise(returned);
    returned.dispose();
    drainJobs(runtime);
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const outcome = await Promise.race([settled, timedOut]);
    const tooLong = `the callback did not finish within ${limits.timeoutMs / 1000}s`;
    if (outcome === "timeout") return { ok: false, error: tooLong, logs };
    // Calls the code started but did not await still count toward the run.
    while (inFlight.size > 0) {
      if (await Promise.race([Promise.allSettled([...inFlight]), timedOut]) === "timeout") {
        if (!outcome.error) outcome.value.dispose();
        else outcome.error.dispose();
        return { ok: false, error: tooLong, logs };
      }
    }
    if (outcome.error) {
      const error = describeGuestError(context, outcome.error);
      outcome.error.dispose();
      return { ok: false, error, logs };
    }
    outcome.value.dispose();
    return { ok: true, logs };
  } finally {
    if (timer) clearTimeout(timer);
    // A run that timed out may still hold promise handles; the wasm instance
    // is discarded with this run, so a failed teardown is not an error.
    try {
      context.dispose();
      runtime.dispose();
    } catch {}
  }
}
