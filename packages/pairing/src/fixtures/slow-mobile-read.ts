import { parentPort } from "node:worker_threads";
parentPort!.on("message", ({ id, options }) => {
  // Deliberately block this thread, as a cold SQLite page-in would.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  if (options?.limit === 2) throw new Error("fixture read failure");
  parentPort!.postMessage({ id, value: { done: true } });
});
