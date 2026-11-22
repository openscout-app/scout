import { describe, expect, test } from "bun:test";

import { MemoryInboxBucket } from "./memory-bucket.ts";
import { expireInbox, handleInboxRequest, type InboxEnv } from "./worker.ts";

const envelope = () => {
  const bytes = new Uint8Array(80);
  bytes[0] = 1;
  return bytes;
};

function setup(): InboxEnv & { INBOX: MemoryInboxBucket } {
  return { INBOX: new MemoryInboxBucket(), READ_TOKEN: "read-token", WRITE_TOKEN: "write-token" };
}

const call = (env: InboxEnv, method: string, path: string, token?: string, body?: Uint8Array) =>
  handleInboxRequest(new Request(`https://inbox.test${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body ? { body } : {}),
  }), env);

describe("Scout Hub inbox", () => {
  test("a reporter can add chunks; only the runtime can list, fetch and delete them", async () => {
    const env = setup();
    const added = await call(env, "POST", "/v1/inbox/chunks", "write-token", envelope());
    expect(added.status).toBe(201);
    const { key } = await added.json() as { key: string };

    expect((await call(env, "GET", "/v1/inbox/pending", "write-token")).status).toBe(401);
    expect((await call(env, "GET", `/v1/inbox/chunks/${encodeURIComponent(key)}`, "write-token")).status).toBe(401);
    expect((await call(env, "DELETE", `/v1/inbox/chunks/${encodeURIComponent(key)}`, "write-token")).status).toBe(401);
    expect((await call(env, "POST", "/v1/inbox/chunks", "read-token", envelope())).status).toBe(401);
    expect((await call(env, "POST", "/v1/inbox/chunks", undefined, envelope())).status).toBe(401);

    const pending = await (await call(env, "GET", "/v1/inbox/pending", "read-token")).json() as { items: Array<{ key: string; size: number }> };
    expect(pending.items).toEqual([expect.objectContaining({ key, size: 80 })]);
    const fetched = await call(env, "GET", `/v1/inbox/chunks/${encodeURIComponent(key)}`, "read-token");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(envelope());
    expect((await call(env, "DELETE", `/v1/inbox/chunks/${encodeURIComponent(key)}`, "read-token")).status).toBe(204);
    expect(env.INBOX.objects.size).toBe(0);
  });

  test("it refuses what is not an envelope and what is too large", async () => {
    const env = { ...setup(), MAX_CHUNK_BYTES: "100" };
    expect((await call(env, "POST", "/v1/inbox/chunks", "write-token", new Uint8Array(80))).status).toBe(400);
    expect((await call(env, "POST", "/v1/inbox/chunks", "write-token", new Uint8Array(200).fill(1))).status).toBe(413);
  });

  test("it pages oldest first and rejects keys outside its own", async () => {
    const env = setup();
    const keys: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      keys.push((await (await call(env, "POST", "/v1/inbox/chunks", "write-token", envelope())).json() as { key: string }).key);
    }
    const first = await (await call(env, "GET", "/v1/inbox/pending?limit=2", "read-token")).json() as { items: Array<{ key: string }>; cursor: string };
    expect(first.items).toHaveLength(2);
    const second = await (await call(env, "GET", `/v1/inbox/pending?limit=2&after=${first.cursor}`, "read-token")).json() as { items: Array<{ key: string }>; cursor: string | null };
    expect([...first.items, ...second.items].map((item) => item.key).sort()).toEqual([...keys].sort());
    expect(second.cursor).toBeNull();
    expect((await call(env, "GET", "/v1/inbox/chunks/..%2Fsecret", "read-token")).status).toBe(400);
  });

  test("chunks left longer than the hold time are deleted", async () => {
    const env = setup();
    await call(env, "POST", "/v1/inbox/chunks", "write-token", envelope());
    expect(await expireInbox(env, Date.now() + 6 * 86_400_000)).toBe(0);
    expect(await expireInbox(env, Date.now() + 8 * 86_400_000)).toBe(1);
    expect(env.INBOX.objects.size).toBe(0);
  });
});
