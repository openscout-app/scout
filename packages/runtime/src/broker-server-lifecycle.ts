import type { RuntimeHttpServerLike } from "./portable-types.js";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Maximum byte length of a Unix domain socket path excluding the NUL terminator.
 * macOS `sockaddr_un.sun_path` is 104 bytes (103 usable); Linux is 108 (107 usable).
 */
export function maxUnixSocketPathBytes(platform: string = process.platform): number {
  return platform === "darwin" ? 103 : 107;
}

export function assertUnixSocketPathLength(
  socketPath: string,
  platform: string = process.platform,
): void {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  const limit = maxUnixSocketPathBytes(platform);
  if (bytes > limit) {
    throw new Error(
      `Unix socket path is ${bytes} bytes, exceeding the ${limit}-byte limit (${platform}): ${socketPath}`,
    );
  }
}

export function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "EADDRINUSE",
  );
}

export async function prepareBrokerSocketPath(socketPath: string): Promise<void> {
  assertUnixSocketPathLength(socketPath);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`broker socket path exists but is not a socket: ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function listenTcp(
  serverInstance: RuntimeHttpServerLike,
  options: { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: unknown) => {
      serverInstance.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      serverInstance.off("error", handleError);
      resolve();
    };

    serverInstance.once("error", handleError);
    serverInstance.once("listening", handleListening);
    serverInstance.listen(options.port, options.host);
  });
}

export async function listenUnixSocket(
  serverInstance: RuntimeHttpServerLike,
  socketPath: string,
): Promise<void> {
  await prepareBrokerSocketPath(socketPath);
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: unknown) => {
      serverInstance.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      serverInstance.off("error", handleError);
      resolve();
    };

    serverInstance.once("error", handleError);
    serverInstance.once("listening", handleListening);
    serverInstance.listen(socketPath);
  });
}

export type UnixSocketRebindGuard = {
  start(): void;
  stop(): void;
  checkNow(): Promise<"ok" | "rebound" | "skipped">;
};

/**
 * macOS removes files in the user temp dir that look idle, and a listening
 * Unix socket counts as idle. Periodically verify the socket path still exists
 * on disk and rebind the server if it vanished.
 */
export function createUnixSocketRebindGuard(options: {
  socketPath: string;
  getServer: () => RuntimeHttpServerLike;
  rebind: () => Promise<void>;
  intervalMs?: number;
  isStopping?: () => boolean;
  log?: (message: string) => void;
}): UnixSocketRebindGuard {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<"ok" | "rebound" | "skipped"> | null = null;
  let stopped = false;

  const check = async (): Promise<"ok" | "rebound" | "skipped"> => {
    if (stopped || options.isStopping?.()) return "skipped";
    const server = options.getServer();
    if (!server.listening) return "skipped";
    try {
      const info = await lstat(options.socketPath);
      if (info.isSocket()) return "ok";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        options.log?.(`unix socket check failed for ${options.socketPath}: ${error instanceof Error ? error.message : String(error)}`);
        return "skipped";
      }
    }
    if (stopped || options.isStopping?.()) return "skipped";
    options.log?.(`unix socket vanished; rebinding ${options.socketPath}`);
    await options.rebind();
    return "rebound";
  };

  return {
    checkNow() {
      if (inFlight) return inFlight;
      inFlight = check().finally(() => { inFlight = null; });
      return inFlight;
    },
    start() {
      if (stopped || timer) return;
      timer = setInterval(() => {
        void this.checkNow().catch((error) => {
          options.log?.(`unix socket rebind failed for ${options.socketPath}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, options.intervalMs ?? 30_000);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export function forceCloseServer(serverInstance: RuntimeHttpServerLike): void {
  const forceCloseable = serverInstance as RuntimeHttpServerLike & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  forceCloseable.closeAllConnections?.();
  forceCloseable.closeIdleConnections?.();
}

export function closeServer(serverInstance: RuntimeHttpServerLike, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    if (!serverInstance.listening) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      forceCloseServer(serverInstance);
      finish();
    }, timeoutMs);
    timeout.unref();
    serverInstance.close(() => finish());
  });
}
