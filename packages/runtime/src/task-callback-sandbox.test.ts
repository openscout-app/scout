import { describe, expect, test } from "bun:test";
import { runSandboxedFunction } from "./task-callback-sandbox.js";

const runModule = (code: string, scout: Record<string, (...args: unknown[]) => Promise<unknown>> = {}, timeoutMs = 2_000) =>
  runSandboxedFunction({ code, data: { result: { reply: "done", files: ["/tmp/a.html"] } }, scout, limits: { timeoutMs } });
/** Runs `fn` as the module's default export. */
const run = (fn: string, scout: Record<string, (...args: unknown[]) => Promise<unknown>> = {}, timeoutMs = 2_000) =>
  runModule(`export default ${fn};`, scout, timeoutMs);

describe("callback sandbox", () => {
  test("calls the default export with the data and awaits the host functions it calls", async () => {
    const calls: unknown[][] = [];
    const echo = async (...args: unknown[]) => { calls.push(args); return { got: args[0] }; };
    expect(await run(`async ({ result, scout }) => { const r = await scout.echo(result.files[0], 2); console.log("echo", r.got, { n: 1 }); }`, { echo }))
      .toEqual({ ok: true, logs: ['echo /tmp/a.html {"n":1}'] });
    expect(calls).toEqual([["/tmp/a.html", 2]]);
    expect(await run(`({ result }) => console.log(result.reply)`)).toEqual({ ok: true, logs: ["done"] });
  });

  test("a module file can hold helpers, top-level code and a named default function", async () => {
    const file = [
      `const first = (files) => files.find((file) => file.endsWith(".html"));`,
      `console.log("loaded");`,
      `export default async function openPage({ result }) { console.log("page", first(result.files)); }`,
    ].join("\n");
    expect(await runModule(file)).toEqual({ ok: true, logs: ["loaded", "page /tmp/a.html"] });
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
    expect(await runModule(`import { readFileSync } from "node:fs";\nexport default () => readFileSync("/etc/hosts");`))
      .toMatchObject({ ok: false });
  });

  test("errors, rejections and a missing default export fail the run with a message", async () => {
    const refuse = async () => { throw new Error("host said no"); };
    expect(await run(`() => { throw new TypeError("nope") }`)).toMatchObject({ ok: false, error: "TypeError: nope" });
    expect(await run(`async ({ scout }) => { await scout.refuse() }`, { refuse })).toMatchObject({ ok: false, error: "Error: host said no" });
    expect(await run(`async ({ scout }) => { try { await scout.refuse() } catch (e) { console.log("caught", e.message) } }`, { refuse }))
      .toEqual({ ok: true, logs: ["caught host said no"] });
    const noDefault = { ok: false, error: "the callback file must export a default function" };
    expect(await run(`42`)).toMatchObject(noDefault);
    expect(await runModule(`export const open = () => 1;`)).toMatchObject(noDefault);
    expect(await runModule(`({ result }) => result`)).toMatchObject(noDefault);
    expect(await run(`async ({ result ) => 1`)).toMatchObject({ ok: false, error: expect.stringContaining("SyntaxError") });
    expect(await runModule(`throw new Error("at load");\nexport default () => 1;`)).toMatchObject({ ok: false, error: "Error: at load" });
  });

  test("loops, promises that never settle and oversized allocations are stopped", async () => {
    const computing = "the callback computed for more than 100 ms without awaiting";
    expect(await run(`() => { for (;;) {} }`, {}, 300)).toMatchObject({ ok: false, error: computing });
    expect(await runModule(`for (;;) {}\nexport default () => 1;`, {}, 300)).toMatchObject({ ok: false, error: computing });
    expect(await run(`() => new Promise(() => {})`, {}, 300)).toMatchObject({ ok: false, error: "the callback did not finish within 0.3s" });
    expect(await runModule(`await new Promise(() => {});\nexport default () => 1;`, {}, 300))
      .toMatchObject({ ok: false, error: "the callback did not finish within 0.3s" });
    expect(await run(`() => new ArrayBuffer(256 * 1024 * 1024)`)).toMatchObject({ ok: false, error: "InternalError: out of memory" });
  });

  test("a loop holds the event loop for one slice, not the whole budget", async () => {
    const started = performance.now();
    expect(await run(`() => { for (;;) {} }`, {}, 10_000))
      .toMatchObject({ ok: false, error: "the callback computed for more than 100 ms without awaiting" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("guest code that catches its own interrupt is not resumed", async () => {
    const started = performance.now();
    const respin = `() => new Promise(() => { const spin = () => { (async () => { for (;;) {} })().catch(spin); }; spin(); })`;
    expect(await run(respin, {}, 1_500))
      .toMatchObject({ ok: false, error: "the callback computed for more than 100 ms without awaiting" });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("a guest that swallows its interrupt in a synchronous loop is ended", async () => {
    // QuickJS turns the interrupt into a rejection inside the async call or
    // executor, so the outer loop never returns; only the worker can be ended.
    const computing = "the callback computed for more than 100 ms without awaiting";
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    try {
      for (const code of [
        `export default () => { for (;;) { (async () => { for (;;) {} })(); } };`,
        `for (;;) { new Promise(() => { for (;;) {} }); }\nexport default () => 1;`,
      ]) {
        const started = performance.now();
        expect(await runModule(code, {}, 5_000)).toMatchObject({ ok: false, error: computing });
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    } finally {
      clearInterval(ticker);
    }
    // The runtime's own thread kept turning while the guest spun.
    expect(ticks).toBeGreaterThan(5);
  });

  test("guest code that replaces Promise.prototype.then fails the run, not the host", async () => {
    const result = await run(`() => { Promise.prototype.then = function () { throw new Error("hijacked"); }; return 1; }`);
    expect(result.ok).toBe(false);
  });

  test("logs written before a hang are kept", async () => {
    expect(await runModule(`console.log("before");\nfor (;;) { (async () => { for (;;) {} })(); }\nexport default () => 1;`, {}, 3_000))
      .toEqual({ ok: false, error: "the callback computed for more than 100 ms without awaiting", logs: ["before"] });
  });

  test("a host call that fails after a long wait still settles the run", async () => {
    const slow = async () => { await new Promise((resolve) => setTimeout(resolve, 150)); throw new Error("no such file"); };
    expect(await run(`async ({ scout }) => { try { await scout.slow(); } catch (error) { console.log(error.message); } }`, { slow }))
      .toEqual({ ok: true, logs: ["no such file"] });
  });

  test("work split by awaits may take longer than one slice in total", async () => {
    const tick = async () => undefined;
    const spin = `const until = Date.now() + 60; while (Date.now() < until) {}`;
    expect(await run(`async ({ scout }) => { for (let i = 0; i < 4; i++) { ${spin} await scout.tick(); } console.log("ok"); }`, { tick }))
      .toEqual({ ok: true, logs: ["ok"] });
  });

  test("unbounded recursion throws a stack overflow the code can catch", async () => {
    expect(await run(`() => { const f = () => f(); try { f(); } catch (e) { console.log(String(e)); } }`))
      .toEqual({ ok: true, logs: ["InternalError: stack overflow"] });
  });

  test("data the worker cannot be sent fails the run", async () => {
    const result = await runSandboxedFunction({ code: "export default () => 1;", data: { f: () => 1 }, scout: {} });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("could not be sent its input") });
  });

  test("a host result the guest cannot receive rejects that call", async () => {
    const big = async () => 1n;
    expect(await run(`async ({ scout }) => { try { await scout.big(); } catch (e) { console.log(e.message); } }`, { big }))
      .toEqual({ ok: true, logs: ["scout.big returned a value the callback cannot receive"] });
  });

  test("a host result the worker cannot be sent rejects that call only", async () => {
    const fn = async () => () => 1;
    expect(await run(`async ({ scout }) => { try { await scout.fn(); } catch (e) { console.log(e.message); } }`, { fn }))
      .toEqual({ ok: true, logs: ["scout.fn returned a value the callback cannot receive"] });
  });

  test("host calls are capped per run", async () => {
    let calls = 0;
    const tick = async () => { calls += 1; };
    expect(await run(`({ scout }) => { for (let i = 0; i < 1000; i++) scout.tick(); }`, { tick }))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most 100 times") });
    expect(calls).toBe(100);
  });

  test("log output is capped", async () => {
    const result = await run(`() => { for (let i = 0; i < 50; i++) console.log("x".repeat(600)) }`);
    expect(result.logs).toHaveLength(20);
    expect(result.logs[0]).toHaveLength(501);
  });
});
