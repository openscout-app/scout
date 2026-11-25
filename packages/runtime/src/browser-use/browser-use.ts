/**
 * External `browser-use` CLI adapter: wraps an installed `browser-use` binary
 * behind Scout's BrowserAdapter contract using async child processes (never sync exec).
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BrowserActionRequest,
  BrowserAdapterHealth,
  BrowserLease,
  BrowserReceipt,
} from "@openscout/protocol";
import type { BrowserAdapter } from "./adapter.js";

const RUN_TIMEOUT_MS = 60_000;

async function findExecutable(name: string): Promise<string | null> {
  const dirs = [
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH ?? "").split(":"),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return null;
}

function runAsync(command: string, args: string[], timeoutMs = RUN_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export type BrowserUseAdapterOptions = {
  binary?: string | null;
  runImpl?: typeof runAsync;
};

export function createBrowserUseAdapter(options: BrowserUseAdapterOptions = {}): BrowserAdapter {
  const runImpl = options.runImpl ?? runAsync;
  const resolveBinary = async () => (options.binary !== undefined ? options.binary : findExecutable("browser-use"));

  return {
    id: "browser-use",

    async health(): Promise<BrowserAdapterHealth> {
      const bin = await resolveBinary();
      return {
        id: "browser-use",
        available: Boolean(bin),
        mode: "managed",
        reason: bin ? undefined : "browser-use CLI not found on PATH.",
      };
    },

    async execute(request: BrowserActionRequest, lease?: BrowserLease): Promise<BrowserReceipt> {
      const at = Date.now();
      const bin = await resolveBinary();
      if (!bin) {
        return {
          ok: false,
          action: request.action,
          adapter: "browser-use",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: "browser-use CLI is not installed.",
          at,
        };
      }

      const args: string[] = [];
      if (request.action === "open" && request.url) {
        args.push("open", request.url);
      } else if (request.action === "goal" && request.goal) {
        args.push("run", request.goal);
      } else if (request.action === "snapshot") {
        args.push("state");
      } else if (request.action === "screenshot") {
        args.push("screenshot");
      } else {
        return {
          ok: false,
          action: request.action,
          adapter: "browser-use",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: true,
          error: `Unsupported browser-use action: ${request.action}`,
          at,
        };
      }

      try {
        const result = await runImpl(bin, args);
        if (result.code !== 0) {
          return {
            ok: false,
            action: request.action,
            adapter: "browser-use",
            mode: "managed",
            leaseId: lease?.leaseId,
            url: request.url,
            controlAvailable: true,
            error: (result.stderr || result.stdout).trim().slice(0, 300) || `browser-use exited with code ${result.code}`,
            at,
          };
        }
        return {
          ok: true,
          action: request.action,
          adapter: "browser-use",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: true,
          data: { output: result.stdout.trim() },
          at,
        };
      } catch (error) {
        return {
          ok: false,
          action: request.action,
          adapter: "browser-use",
          mode: "managed",
          leaseId: lease?.leaseId,
          url: request.url,
          controlAvailable: false,
          error: error instanceof Error ? error.message : "browser-use execution failed.",
          at,
        };
      }
    },
  };
}
