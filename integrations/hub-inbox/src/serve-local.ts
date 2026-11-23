/**
 * Run the inbox on this machine with an in-memory bucket, for development and
 * end-to-end tests: READ_TOKEN=… WRITE_TOKEN=… bun src/serve-local.ts [port]
 */
import { MemoryInboxBucket } from "./memory-bucket.ts";
import { handleInboxRequest } from "./worker.ts";

export function serveLocalInbox(input: { port?: number; readToken: string; writeToken: string }) {
  const bucket = new MemoryInboxBucket();
  const server = Bun.serve({
    port: input.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (request) => handleInboxRequest(request, { INBOX: bucket, READ_TOKEN: input.readToken, WRITE_TOKEN: input.writeToken }),
  });
  return { server, bucket, url: `http://127.0.0.1:${server.port}` };
}

if (import.meta.main) {
  const readToken = process.env.READ_TOKEN;
  const writeToken = process.env.WRITE_TOKEN;
  if (!readToken || !writeToken) throw new Error("Set READ_TOKEN and WRITE_TOKEN");
  const { url } = serveLocalInbox({ port: Number(process.argv[2]) || 8787, readToken, writeToken });
  console.log(`Scout Hub inbox on ${url}`);
}
