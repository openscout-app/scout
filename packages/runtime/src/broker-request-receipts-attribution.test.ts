import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerRequestReceipts } from "./broker-request-receipts.js";

test("runtime attribution changes do not change request receipt identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "receipt-attribution-"));
  try {
    const receipts = new BrokerRequestReceipts(directory);
    const payload = {
      caller: { actorId: "worker" },
      body: "retry",
      intent: "consult",
      context: { attribution: { source: "application-data" } },
      messageMetadata: { attribution: { actorId: "worker", rootActorId: "worker", source: "unverified" } },
      workItem: { title: "Retry", metadata: { attribution: { actorId: "worker", rootActorId: "worker", source: "unverified" } } },
    };
    const first = await receipts.run("worker", "retry-1", "deliver", payload, async () => ({ accepted: true }));
    expect(first).toEqual({ accepted: true });
    const upgraded = {
      ...payload,
      messageMetadata: { attribution: { actorId: "worker", rootActorId: "worker", source: "local-admin" } },
      workItem: { title: "Retry", metadata: { attribution: { actorId: "worker", rootActorId: "worker", source: "local-admin" } } },
    };
    const second = await receipts.run("worker", "retry-1", "deliver", upgraded, async () => {
      throw new Error("replayed request executed twice");
    });
    expect(second).toEqual({ accepted: true });
    await expect(receipts.run("worker", "retry-1", "deliver", {
      ...upgraded, context: { attribution: { source: "changed-application-data" } },
    }, async () => ({ accepted: false }))).rejects.toThrow("request id already assigned to different content");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
