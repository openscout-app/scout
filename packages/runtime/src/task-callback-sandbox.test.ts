import { describe, expect, test } from "bun:test";
import { runSandboxedFunction } from "./task-callback-sandbox.js";

const run = (code: string, scout: Record<string, (...args: unknown[]) => Promise<unknown>> = {}, timeoutMs = 2_000) =>
  runSandboxedFunction({ code, data: { result: { reply: "done", files: ["/tmp/a.html"] } }, scout, limits: { timeoutMs } });

describe("callback sandbox", () => {
  test("calls the function with the data and awaits the host functions it calls", async () => {
    const calls: unknown[][] = [];
    const echo = async (...args: unknown[]) => { calls.push(args); return { got: args[0] }; };
    expect(await run(`async ({ result, scout }) => { const r = await scout.echo(result.files[0], 2); console.log("echo", r.got, { n: 1 }); }`, { echo }))
      .toEqual({ ok: true, logs: ['echo /tmp/a.html {"n":1}'] });
    expect(calls).toEqual([["/tmp/a.html", 2]]);
    expect(await run(`({ result }) => console.log(result.reply)`)).toEqual({ ok: true, logs: ["done"] });
  });

  test("a host call the code does not await still finishes before the run reports", async () => {
    let finished = false;
    const slow = async () => { await Bun.sleep(30); finished = true; };
    expect(await run(`({ scout }) => { scout.slow(); }`, { slow })).toMatchObject({ ok: true });
    expect(finished).toBe(true);
  });

  test("the code reaches nothing on the host", async () => {
    const probe = ["process", "require", "fetch", "Bun", "setTimeout", "std", "os", "WebAssembly"]
      .map((name) => `typeof globalThis.${name}`).join(", ");
    expect(await run(`() => console.log([${probe}].join(" "))`))
      .toEqual({ ok: true, logs: [Array(8).fill("undefined").join(" ")] });
    expect(await run(`() => import("node:fs")`)).toMatchObject({ ok: false });
  });

  test("errors, rejections and non-functions fail the run with the guest's message", async () => {
    const refuse = async () => { throw new Error("host said no"); };
    expect(await run(`() => { throw new TypeError("nope") }`)).toMatchObject({ ok: false, error: "TypeError: nope" });
    expect(await run(`async ({ scout }) => { await scout.refuse() }`, { refuse })).toMatchObject({ ok: false, error: "Error: host said no" });
    expect(await run(`async ({ scout }) => { try { await scout.refuse() } catch (e) { console.log("caught", e.message) } }`, { refuse }))
      .toEqual({ ok: true, logs: ["caught host said no"] });
    expect(await run(`42`)).toMatchObject({ ok: false, error: "the callback must be a function" });
    expect(await run(`async ({ result ) => 1`)).toMatchObject({ ok: false, error: expect.stringContaining("SyntaxError") });
  });

  test("loops, promises that never settle and oversized allocations are stopped", async () => {
    expect(await run(`() => { for (;;) {} }`, {}, 300)).toMatchObject({ ok: false, error: "InternalError: interrupted" });
    expect(await run(`() => new Promise(() => {})`, {}, 300)).toMatchObject({ ok: false, error: "the callback did not finish within 0.3s" });
    expect(await run(`() => new ArrayBuffer(256 * 1024 * 1024)`)).toMatchObject({ ok: false, error: "InternalError: out of memory" });
  });

  test("log output is capped", async () => {
    const result = await run(`() => { for (let i = 0; i < 50; i++) console.log("x".repeat(600)) }`);
    expect(result.logs).toHaveLength(20);
    expect(result.logs[0]).toHaveLength(501);
  });
});
