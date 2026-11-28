import { createServer, request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  assertUnixSocketPathLength,
  closeServer,
  createUnixSocketRebindGuard,
  isAddressInUse,
  listenTcp,
  listenUnixSocket,
  maxUnixSocketPathBytes,
  prepareBrokerSocketPath,
} from "./broker-server-lifecycle.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "openscout-broker-lifecycle-"));
}

async function getOverUnixSocket(socketPath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: "/" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("broker server lifecycle", () => {
  test("detects address-in-use errors conservatively", () => {
    expect(isAddressInUse({ code: "EADDRINUSE" })).toBe(true);
    expect(isAddressInUse({ code: "ECONNREFUSED" })).toBe(false);
    expect(isAddressInUse(new Error("EADDRINUSE"))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
  });

  test("enforces platform Unix socket byte-length limits and names path and limit", async () => {
    expect(maxUnixSocketPathBytes("darwin")).toBe(103);
    expect(maxUnixSocketPathBytes("linux")).toBe(107);

    const exactDarwin = "/" + "a".repeat(102);
    expect(() => assertUnixSocketPathLength(exactDarwin, "darwin")).not.toThrow();

    const tooLongDarwin = "/" + "a".repeat(103);
    expect(() => assertUnixSocketPathLength(tooLongDarwin, "darwin"))
      .toThrow(new RegExp(`104 bytes.*103-byte limit.*${tooLongDarwin}`));

    const exactLinux = "/" + "b".repeat(106);
    expect(() => assertUnixSocketPathLength(exactLinux, "linux")).not.toThrow();

    const tooLongLinux = "/" + "b".repeat(107);
    expect(() => assertUnixSocketPathLength(tooLongLinux, "linux"))
      .toThrow(new RegExp(`108 bytes.*107-byte limit.*${tooLongLinux}`));

    await expect(prepareBrokerSocketPath("/" + "c".repeat(120)))
      .rejects.toThrow(/exceeding the (103|107)-byte limit/);
  });

  test("prepares socket directories and rejects non-socket paths", async () => {
    const root = await tempDir();
    const socketPath = join(root, "nested", "broker.sock");
    const filePath = join(root, "nested", "not-a-socket");
    try {
      await prepareBrokerSocketPath(socketPath);
      await expect(stat(join(root, "nested"))).resolves.toBeTruthy();

      await writeFile(filePath, "not a socket");
      await expect(prepareBrokerSocketPath(filePath))
        .rejects.toThrow(`broker socket path exists but is not a socket: ${filePath}`);
      await expect(readFile(filePath, "utf8")).resolves.toBe("not a socket");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("listens on TCP and closes listening servers", async () => {
    const server = createServer((_request, response) => {
      response.end("ok");
    });

    await listenTcp(server, { host: "127.0.0.1", port: 0 });
    expect(server.listening).toBe(true);

    await closeServer(server, 100);
    expect(server.listening).toBe(false);
  });

  test("listens on Unix sockets after preparing the socket path", async () => {
    const root = await tempDir();
    const socketPath = join(root, "nested", "broker.sock");
    const server = createServer((_request, response) => {
      response.end("ok");
    });
    try {
      await listenUnixSocket(server, socketPath);
      expect(server.listening).toBe(true);
    } finally {
      await closeServer(server, 100);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rebind guard restores a vanished Unix socket and resumes serving requests", async () => {
    const root = await tempDir();
    const socketPath = join(root, "broker.sock");
    const server = createServer((_request, response) => {
      response.end("rebound-ok");
    });
    const logs: string[] = [];
    const guard = createUnixSocketRebindGuard({
      socketPath,
      getServer: () => server,
      rebind: async () => {
        await closeServer(server, 500);
        await listenUnixSocket(server, socketPath);
      },
      log: (msg) => logs.push(msg),
    });
    try {
      await listenUnixSocket(server, socketPath);
      expect(await guard.checkNow()).toBe("ok");

      // Simulate macOS cleaning an idle socket file out of DARWIN_USER_TEMP_DIR.
      await unlink(socketPath);
      expect(existsSync(socketPath)).toBe(false);

      expect(await guard.checkNow()).toBe("rebound");
      expect(existsSync(socketPath)).toBe(true);
      expect(await getOverUnixSocket(socketPath)).toBe("rebound-ok");
      expect(logs.some((line) => line.includes("rebinding"))).toBe(true);
    } finally {
      guard.stop();
      await closeServer(server, 100);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closeServer resolves immediately for non-listening servers", async () => {
    const server = createServer();
    await expect(closeServer(server, 100)).resolves.toBeUndefined();
  });
});
