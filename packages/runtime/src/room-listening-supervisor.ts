import type { ChildProcess } from "node:child_process";

/** EX_CONFIG: shared with bin/openscout-runtime.mjs; never infer from stderr. */
export const UNSUPPORTED_RUNTIME_COMMAND_EXIT = 78;
/** A child that dies this soon after starting is crash-looping, not running. */
export const QUICK_EXIT_MS = 5_000;
export const QUICK_EXIT_LIMIT = 5;
/** A generic crash loop may not be version skew, so it gets a slow backstop retry. */
export const CRASH_LOOP_BACKSTOP_MS = 30 * 60_000;
export type RoomListeningStatus = { state: "starting" | "running" | "retrying" | "suspended" | "stopped"; detail?: string };

/** Owned by scout-base, never by scout-broker. Injectable process/time edges
 * keep supervision tests from touching the live supervisor or service. */
export function createRoomListeningSupervisor(options: {
  spawn: () => ChildProcess;
  terminate: (child: ChildProcess) => Promise<void>;
  warn: (message: string) => void;
  /** Changes only when installed runtime artifacts change. No network probe. */
  runtimeRevision?: () => string;
  statusChanged?: (status: RoomListeningStatus) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let child: ChildProcess | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, delay = 1000, suspendedRevision: string | undefined;
  // An older runtime paired with a newer base may never exit 78:
  // it prints a human error and exits 1. Consecutive quick exits catch that
  // without parsing stderr. suspendedAt/backstop only apply to that generic case.
  let quickExits = 0, suspendedAt = 0, backstop = false;
  let status: RoomListeningStatus = { state: "starting" };
  const now = options.now ?? Date.now;
  const revision = () => { try { return options.runtimeRevision?.() ?? "unknown"; } catch { return "unknown"; } };
  function publish(next: RoomListeningStatus) { status = next; options.statusChanged?.({ ...next }); }
  function schedule(callback: () => void, ms: number) {
    timer = (options.schedule ?? setTimeout)(() => { timer = undefined; callback(); }, ms);
    timer.unref?.();
  }
  function recheck() {
    if (stopped || status.state !== "suspended") return;
    const current = revision();
    const changed = current !== "unknown" && current !== suspendedRevision;
    if (changed || (backstop && now() - suspendedAt >= CRASH_LOOP_BACKSTOP_MS)) {
      suspendedRevision = undefined; delay = 1000; quickExits = 0; backstop = false;
      publish({ state: "starting" }); start();
    } else schedule(recheck, 30_000);
  }
  function retry() {
    if (stopped || timer) return;
    publish({ state: "retrying" });
    schedule(start, delay); delay = Math.min(delay * 2, 30_000);
  }
  function start() {
    if (stopped || child || timer || status.state === "suspended") return;
    try {
      const startedAt = now(), startedRevision = revision(), current = options.spawn(); child = current;
      publish({ state: "running" });
      let finished = false;
      const end = (code?: number | Error | null, signal?: NodeJS.Signals | null) => {
        if (finished) return; finished = true;
        if (child === current) child = undefined;
        if (stopped) return;
        const suspend = (detail: string, generic: boolean) => {
          suspendedRevision = startedRevision; suspendedAt = now(); backstop = generic;
          publish({ state: "suspended", detail }); options.warn(detail);
          schedule(recheck, 30_000);
        };
        if (code === UNSUPPORTED_RUNTIME_COMMAND_EXIT && !signal) {
          suspend("room listening suspended: runtime does not support `listening`; upgrade", false);
          return;
        }
        quickExits = now() - startedAt < QUICK_EXIT_MS ? quickExits + 1 : 0;
        if (quickExits >= QUICK_EXIT_LIMIT) {
          suspend(`room listening suspended: the child exited within ${QUICK_EXIT_MS / 1000}s on ${QUICK_EXIT_LIMIT} consecutive starts; `
            + "see room-listening.stderr.log. Resumes when the runtime is upgraded, or retries in 30 minutes", true);
          return;
        }
        if (now() - startedAt >= 30_000) delay = 1000;
        options.warn("room listening child stopped; retrying"); retry();
      };
      current.once("exit", end); current.once("error", end);
    } catch { options.warn("room listening child could not start; retrying"); retry(); }
  }
  return { start, status: () => ({ ...status }), async stop() {
    stopped = true; publish({ state: "stopped" });
    if (timer) (options.cancel ?? clearTimeout)(timer);
    timer = undefined;
    const current = child; child = undefined;
    if (current) await options.terminate(current);
  } };
}
