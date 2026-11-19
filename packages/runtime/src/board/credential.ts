import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { validateBoardCredentialReference, type BoardCredentialReference } from "@openscout/protocol";

export class BoardCredentialError extends Error {
  constructor(readonly code: "credential_unavailable" | "credential_unsafe", message: string) {
    super(message);
    this.name = "BoardCredentialError";
  }
}

const TOKEN = /^[\x21-\x7e]{8,4096}$/;

/** Read the credential from `secret get <key>`. Bounded, with process-group cleanup; the value never reaches argv or logs. */
function readSecretCli(key: string, options: { executable?: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? "secret", ["get", key], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    const kill = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new BoardCredentialError("credential_unavailable", `The secret helper did not return entry ${key}. Check it with: secret get ${key} >/dev/null && echo ok`));
    };
    const timer = setTimeout(fail, options.timeoutMs ?? 15_000);
    child.on("error", fail);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 8192) fail();
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) { fail(); return; }
      settled = true;
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

/**
 * Resolve a credential reference to the bearer value, and cache it briefly.
 * The value stays in this process: it never enters argv, logs, status or
 * records. There is no refresh: a Vercel access token is sent as it is, and a
 * 401 moves the connection to `auth_expired`.
 */
export class BoardCredential {
  private cached?: { value: string; until: number };
  constructor(
    private readonly reference: BoardCredentialReference,
    private readonly options: { env?: NodeJS.ProcessEnv; secretExecutable?: string; cacheMs?: number; now?: () => number } = {},
  ) {
    const errors = validateBoardCredentialReference(reference);
    if (errors.length) throw new BoardCredentialError("credential_unsafe", errors.join("; "));
  }

  invalidate(): void { this.cached = undefined; }

  async token(): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && this.cached.until > now) return this.cached.value;
    const value = await this.read();
    if (!TOKEN.test(value)) throw new BoardCredentialError("credential_unavailable", `Credential ${this.reference.backend}:${this.describeKey()} is empty or not a token.`);
    this.cached = { value, until: now + (this.options.cacheMs ?? 300_000) };
    return value;
  }

  private describeKey(): string {
    return this.reference.backend === "file" ? "<file>" : this.reference.key;
  }

  private async read(): Promise<string> {
    const { backend, key } = this.reference;
    if (backend === "env") {
      const value = (this.options.env ?? process.env)[key];
      if (!value) throw new BoardCredentialError("credential_unavailable", `Environment variable ${key} is not set for the broker.`);
      return value.trim();
    }
    if (backend === "file") {
      const info = await stat(key).catch(() => null);
      if (!info?.isFile()) throw new BoardCredentialError("credential_unavailable", "The credential file does not exist.");
      if ((info.mode & 0o077) !== 0) throw new BoardCredentialError("credential_unsafe", "The credential file is readable by others. Run chmod 600 on it.");
      return (await readFile(key, "utf8")).trim();
    }
    return readSecretCli(key, { executable: this.options.secretExecutable });
  }
}
