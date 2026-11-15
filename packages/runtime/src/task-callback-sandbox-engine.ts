import {
  newQuickJSWASMModuleFromVariant,
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
 *
 * This engine runs inside a worker thread (task-callback-sandbox-worker-entry):
 * guest code that defeats the interrupt can stall only that thread, and the
 * host ends it with `terminate()`.
 */
export type SandboxFunction = (...args: unknown[]) => Promise<unknown>;

export type SandboxLimits = {
  memoryBytes: number;
  /**
   * QuickJS's own stack limit. It must stay under what the worker thread's
   * native stack allows, or deep recursion overflows the host stack inside the
   * wasm before QuickJS can throw a catchable error.
   */
  stackBytes: number;
  /** Wall-clock budget for the whole run, including time spent awaiting host functions. */
  timeoutMs: number;
  /** The longest the guest may compute without awaiting before the run fails. */
  sliceMs: number;
  /** Host function calls one run may make, awaited or not. */
  hostCalls: number;
  logLines: number;
  logLineChars: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  timeoutMs: 10_000,
  sliceMs: 100,
  hostCalls: 100,
  logLines: 20,
  logLineChars: 500,
};

export type SandboxRun = { ok: true; logs: string[] } | { ok: false; error: string; logs: string[] };

export type SandboxStopReason = "slice" | "timeout";

/** Host to worker. */
export type SandboxHostMessage =
  | { type: "run"; code: string; data: Record<string, unknown>; functions: string[]; limits: SandboxLimits }
  | { type: "settled"; id: number; ok: true; value: unknown }
  | { type: "settled"; id: number; ok: false; error: string };

/** Worker to host. */
export type SandboxWorkerMessage =
  | { type: "call"; id: number; name: string; args: unknown[] }
  | { type: "log"; line: string }
  | { type: "halted"; reason: SandboxStopReason }
  | { type: "done"; run: SandboxRun };

export const sliceError = (limits: Pick<SandboxLimits, "sliceMs">) =>
  `the callback computed for more than ${limits.sliceMs} ms without awaiting`;
export const timeoutError = (limits: Pick<SandboxLimits, "timeoutMs">) =>
  `the callback did not finish within ${limits.timeoutMs / 1000}s`;

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

/** Jobs run per turn of the host event loop, so a guest job chain cannot starve it. */
const JOB_BATCH = 256;

/**
 * Evaluates `code` as an ES module and calls its default export with `data`
 * plus a `scout` object of the given functions. Resolves when the function's
 * return value settles, the code throws, or the time budget runs out.
 */
export async function runInQuickJS(input: {
  code: string;
  data: Record<string, unknown>;
  scout: Record<string, SandboxFunction>;
  limits?: Partial<SandboxLimits>;
  /** Each kept log line, as the guest writes it. */
  onLog?: (line: string) => void;
  /** Called from the interrupt handler when the run is stopped for good. */
  onHalt?: (reason: SandboxStopReason) => void;
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
  // Every synchronous entry into the guest starts a slice. The interrupt
  // handler ends the run when a slice or the whole budget runs out.
  // An overrun ends the run for good: guest code that catches the interrupt
  // is not resumed, and the run settles through `stopped`.
  let sliceStartedAt = Date.now();
  let slicedOut = false;
  let halted = false;
  let stop: (reason: "slice" | "timeout") => void = () => {};
  const stopped = new Promise<"slice" | "timeout">((resolve) => { stop = resolve; });
  const halt = (reason: "slice" | "timeout") => {
    if (!halted) {
      halted = true;
      if (reason === "slice") slicedOut = true;
      stop(reason);
      input.onHalt?.(reason);
    }
    return true;
  };
  const enter = () => { sliceStartedAt = Date.now(); };
  runtime.setInterruptHandler(() => {
    if (halted) return true;
    const now = Date.now();
    if (now > deadline) return halt("timeout");
    if (now - sliceStartedAt > limits.sliceMs) return halt("slice");
    return false;
  });
  let drainScheduled = false;
  const drainJobs = (): void => {
    if (halted || !runtime.alive) return;
    enter();
    const result = runtime.executePendingJobs(JOB_BATCH);
    if (result.error) {
      result.error.dispose();
    } else if (result.value >= JOB_BATCH && !drainScheduled) {
      // More jobs may be queued: finish them on a later turn.
      drainScheduled = true;
      setImmediate(() => { drainScheduled = false; drainJobs(); });
    }
  };
  const slice = sliceError(limits);
  const tooLong = timeoutError(limits);
  const context = runtime.newContext();
  let hostCallCount = 0;
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
      const kept = line.length > limits.logLineChars ? `${line.slice(0, limits.logLineChars)}…` : line;
      logs.push(kept);
      input.onLog?.(kept);
    });
    context.setProp(consoleObject, "log", log);
    log.dispose();
    context.setProp(context.global, "console", consoleObject);
    consoleObject.dispose();

    enter();
    const argument = toGuest(context, input.data);
    const scoutObject = context.newObject();
    for (const [name, fn] of Object.entries(input.scout)) {
      const handle = context.newFunction(name, (...argHandles) => {
        if (++hostCallCount > limits.hostCalls) {
          return { error: context.newError(`a callback may call scout functions at most ${limits.hostCalls} times`) };
        }
        const args = argHandles.map((arg) => context.dump(arg));
        const deferred = context.newPromise();
        const call: Promise<void> = Promise.resolve()
          .then(() => fn(...args))
          .then(
            (value) => {
              if (halted || !context.alive) return;
              enter();
              let result: QuickJSHandle;
              try {
                result = toGuest(context, value);
              } catch {
                // A value JSON cannot carry (a BigInt, a cycle) rejects the call.
                const guestError = context.newError(`scout.${name} returned a value the callback cannot receive`);
                deferred.reject(guestError);
                guestError.dispose();
                return;
              }
              deferred.resolve(result);
              if (result !== context.undefined) result.dispose();
            },
            (error: unknown) => {
              if (halted || !context.alive) return;
              enter();
              const guestError = context.newError(error instanceof Error ? error.message : String(error));
              deferred.reject(guestError);
              guestError.dispose();
            },
          )
          // Settling into a halted guest can throw; the run reports through
          // `stopped`, and nothing here may reject unhandled.
          .catch(() => {})
          .finally(() => {
            inFlight.delete(call);
            drainJobs();
          });
        inFlight.add(call);
        return deferred.handle;
      });
      context.setProp(scoutObject, name, handle);
      handle.dispose();
    }
    context.setProp(argument, "scout", scoutObject);
    scoutObject.dispose();

    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { halt("timeout"); resolve("timeout"); }, Math.max(0, deadline - Date.now()));
    });
    const ended = stopped.then((reason) => reason === "slice" ? "slice" as const : "timeout" as const);
    const guestError = (handle: QuickJSHandle) => slicedOut ? slice : describeGuestError(context, handle);
    const stoppedError = (reason: "slice" | "timeout") => reason === "slice" ? slice : tooLong;

    // The callback file is an ES module whose default export is the function.
    // No module loader is set, so an import fails.
    enter();
    const evaluated = context.evalCode(input.code, "callback.js", { type: "module" });
    if (evaluated.error) {
      const error = guestError(evaluated.error);
      evaluated.error.dispose();
      argument.dispose();
      return { ok: false, error, logs };
    }
    // Evaluation returns the module's exports, or a promise for them.
    const loading = context.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    drainJobs();
    const loaded = await Promise.race([loading, timedOut, ended]);
    if (loaded === "timeout" || loaded === "slice") {
      argument.dispose();
      return { ok: false, error: stoppedError(loaded), logs };
    }
    if (loaded.error) {
      const error = guestError(loaded.error);
      loaded.error.dispose();
      argument.dispose();
      return { ok: false, error, logs };
    }
    const fn = context.getProp(loaded.value, "default");
    loaded.value.dispose();
    if (context.typeof(fn) !== "function") {
      fn.dispose();
      argument.dispose();
      return { ok: false, error: "the callback file must export a default function", logs };
    }
    enter();
    const called = context.callFunction(fn, context.undefined, argument);
    fn.dispose();
    argument.dispose();
    if (called.error) {
      const error = guestError(called.error);
      called.error.dispose();
      return { ok: false, error, logs };
    }
    const returned = called.value;
    const settled = context.resolvePromise(returned);
    returned.dispose();
    drainJobs();
    const outcome = await Promise.race([settled, timedOut, ended]);
    if (outcome === "timeout" || outcome === "slice") return { ok: false, error: stoppedError(outcome), logs };
    // Calls the code started but did not await still count toward the run.
    while (inFlight.size > 0) {
      const waited = await Promise.race([Promise.allSettled([...inFlight]), timedOut, ended]);
      if (waited === "timeout" || waited === "slice") {
        if (!outcome.error) outcome.value.dispose();
        else outcome.error.dispose();
        return { ok: false, error: stoppedError(waited), logs };
      }
    }
    if (halted) {
      if (!outcome.error) outcome.value.dispose();
      else outcome.error.dispose();
      return { ok: false, error: slicedOut ? slice : tooLong, logs };
    }
    if (outcome.error) {
      const error = guestError(outcome.error);
      outcome.error.dispose();
      return { ok: false, error, logs };
    }
    outcome.value.dispose();
    return { ok: true, logs };
  } catch (error) {
    // Guest code can break the host's promise handling, for example by
    // replacing Promise.prototype.then. That fails the run, not the host.
    if (halted) return { ok: false, error: slicedOut ? slice : tooLong, logs };
    return { ok: false, error: `the callback broke the sandbox: ${error instanceof Error ? error.message : String(error)}`, logs };
  } finally {
    halted = true;
    if (timer) clearTimeout(timer);
    // A run that timed out may still hold promise handles; the wasm instance
    // is discarded with this run, so a failed teardown is not an error.
    try {
      context.dispose();
      runtime.dispose();
    } catch {}
  }
}
