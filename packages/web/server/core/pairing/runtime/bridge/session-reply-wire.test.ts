import { expect, test } from "bun:test";
import { initTRPC } from "@trpc/server";
import { bridgeRouter } from "./router.ts";
import { bridgeRouter as legacyDesktopRouter } from "../../../../../../../apps/desktop/src/core/pairing/runtime/bridge/router.ts";

test("versioned native-session replies use the same receipt-owned acceptance procedure", async () => {
  expect(bridgeRouter._def.procedures["mobile.askSessionDurable"])
    .toBe(bridgeRouter._def.procedures["mobile.askSession"]);
  const caller = bridgeRouter.createCaller({ bridge: {} as never, cwd: "/tmp/scout-wire-test" });
  expect(await caller.mobile.askSessionDurable({ sessionId: "native", harness: "claude", body: "hello" }))
    .toMatchObject({ ok: false, code: "request_id_required" });
});

test("a legacy bridge refuses the versioned call without touching an input adapter", async () => {
  let touched = false;
  const bridge = new Proxy({}, { get: () => { touched = true; throw new Error("adapter must not run"); } });
  const caller = legacyDesktopRouter.createCaller({ bridge: bridge as never, cwd: "/tmp/scout-wire-test" });
  expect(await caller.mobile.askSessionDurable({ sessionId: "native", harness: "claude", body: "hello", clientMessageId: "stable" }))
    .toMatchObject({ ok: false, code: "session_input_receipts_unsupported" });
  expect(touched).toBe(false);
});

test("an old wire router cannot reinterpret the durable method as its unreceipted ask", async () => {
  let inputs = 0;
  const t = initTRPC.create();
  const old = t.router({ mobile: t.router({ askSession: t.procedure.mutation(() => { inputs++; }) }) });
  // Mirrors a newer native caller connecting to an older bridge binary.
  const caller = old.createCaller({}) as unknown as { mobile: { askSessionDurable(input: unknown): Promise<unknown> } };
  await expect(caller.mobile.askSessionDurable({ sessionId: "native", body: "hello", clientMessageId: "stable" }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(inputs).toBe(0);
});
