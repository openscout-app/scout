import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExternalSessionTransportError, normalizeDevinSessionId,
  type ExternalSessionConnection, type ExternalSessionTransport,
} from "./external-session-transport.js";
import { buildUserSpawnEnvironment } from "./instance.js";

type Observation = { nativeSessionId: string; state: string };

/** Operator-owned CLI login; callers cannot supply executable paths or flags. */
export function devinCloudCliTransport(
  connection: ExternalSessionConnection,
  env: NodeJS.ProcessEnv = process.env,
): ExternalSessionTransport {
  const executable = env.OPENSCOUT_DEVIN_CLI_BIN || "devin";
  // The Devin CLI is a harness the operator drives: a user-facing spawn.
  const childEnv = buildUserSpawnEnvironment(env) as NodeJS.ProcessEnv;
  const inspect = async (nativeId: string): Promise<Observation> => {
    const id = normalizeDevinSessionId(nativeId);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ["acp", "--cloud"], { env: childEnv, stdio: ["pipe", "pipe", "ignore"] });
      let done = false;
      let buffer = "";
      const kill = () => {
        child.kill("SIGTERM");
        const escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
        escalation.unref();
        child.once("close", () => clearTimeout(escalation));
      };
      const finish = (error?: string, value?: Observation) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        kill();
        if (error) reject(new ExternalSessionTransportError(false, error));
        else resolve(value!);
      };
      const timer = setTimeout(() => finish("devin_cli_inspect_timeout"), 30_000);
      const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
      child.stdin.on("error", () => finish("devin_cli_inspect_unavailable"));
      child.on("error", () => finish("devin_cli_unavailable"));
      child.on("close", () => finish("devin_cli_inspect_unavailable"));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        // A loaded conversation may replay history. Drop it; only inspect the load response.
        if (buffer.length > 4 * 1024 * 1024) return finish("devin_cli_response_too_large");
        let newline: number;
        while (!done && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message: any;
          try { message = JSON.parse(line); } catch { return finish("devin_cli_invalid_response"); }
          if (message.method === "session/request_permission") {
            send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
          } else if (message.id === 1) {
            if (message.error || message.result?.agentCapabilities?.loadSession !== true) return finish("devin_cli_load_unsupported");
            send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: id, cwd: tmpdir(), mcpServers: [] } });
          } else if (message.id === 2) {
            const meta = message.result?._meta;
            if (message.error || !meta || meta["cognition.ai/orgId"] !== connection.organizationId) return finish("devin_cli_session_identity_mismatch");
            // Cloud ACP reports the loaded identity via its canonical URL, not sessionId.
            const expectedUrl = `https://app.devin.ai/sessions/${id.slice(6)}`;
            if (meta["cognition.ai/url"] !== expectedUrl) return finish("devin_cli_session_identity_mismatch");
            const state = meta["cognition.ai/sessionStatus"];
            if (typeof state !== "string" || meta["cognition.ai/readOnly"] === true || meta["cognition.ai/isArchived"] === true || ["exit", "error"].includes(state)) return finish("devin_cli_session_unavailable");
            finish(undefined, { nativeSessionId: id, state });
          }
        }
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openscout", version: "1" } } });
    });
  };
  return {
    inspect,
    async send(nativeId, body) {
      // Recheck the login's organization before every delivery, including after account switches.
      const observed = await inspect(nativeId);
      const directory = await mkdtemp(join(tmpdir(), "openscout-devin-delivery-"));
      try {
        const path = join(directory, "prompt.txt");
        await writeFile(path, body, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, ["--cloud", "--resume", observed.nativeSessionId, "--prompt-file", path, "--print"], { env: childEnv, stdio: "ignore" });
          let expired = false;
          let escalation: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            expired = true;
            child.kill("SIGTERM");
            escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
            escalation.unref();
          }, 5 * 60_000);
          child.once("error", () => {
            clearTimeout(timer);
            reject(new ExternalSessionTransportError(false, "devin_cli_unavailable"));
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (escalation) clearTimeout(escalation);
            if (!expired && code === 0) resolve();
            else reject(new ExternalSessionTransportError(true, "devin_cli_delivery_unconfirmed"));
          });
        });
        // The correlated reply call, never CLI output or exit, completes the flight.
        return { nativeSessionId: observed.nativeSessionId, state: "accepted" };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
