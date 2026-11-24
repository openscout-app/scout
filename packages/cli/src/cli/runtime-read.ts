import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";
import type { ObservedSessionIdentity, ObservedSessionMaterials } from "@openscout/protocol";
import type { ScoutCommandContext } from "./context.ts";
import { ScoutCliError } from "./errors.ts";

/** Read the selected broker only. No web cookie, app startup, or local fallback. */
export async function readScoutRuntimeJson<T>(context: Pick<ScoutCommandContext, "env">, path: string): Promise<T> {
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  try {
    return await requestScoutBrokerJson<T>(baseUrl, path, {
      socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (!(error instanceof ScoutBrokerHttpError)) throw error;
    let code: unknown;
    try { code = JSON.parse(/returned \d+: (.*)$/s.exec(error.message)?.[1] ?? "").error; } catch {}
    // Status is part of the materials contract: identity_unverified at 409 and
    // 503 are not interchangeable. Never turn unavailable into empty data.
    throw new ScoutCliError(`Scout runtime API request failed: HTTP ${error.status}${typeof code === "string" ? ` ${code}` : ""}`);
  }
}

/** Only explicit tuples can establish identity while link domains are incomplete. */
export function parseObservedSessionSelector(args: string[]): ObservedSessionIdentity {
  let nativeSessionId: string | undefined, nodeId: string | undefined, harness: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--node" || arg === "--harness") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new ScoutCliError(`${arg} needs a value`);
      if (arg === "--node") {
        if (nodeId !== undefined) throw new ScoutCliError("--node may appear only once");
        nodeId = value;
      } else {
        if (harness !== undefined) throw new ScoutCliError("--harness may appear only once");
        harness = value;
      }
    } else if (arg.startsWith("-")) throw new ScoutCliError(`unknown session selector option: ${arg}`);
    else if (nativeSessionId !== undefined) throw new ScoutCliError(`unexpected extra session id: ${arg}`);
    else nativeSessionId = arg;
  }
  if (!nativeSessionId || !nodeId || !harness) throw new ScoutCliError("Use <native-session-id> --node <node-id> --harness <claude|codex|pi>; unqualified refs cannot prove session identity.");
  if (![nodeId, nativeSessionId].every(value => value.length <= 1024 && !/[\x00-\x1f]/u.test(value)) || !["claude", "codex", "pi"].includes(harness)) throw new ScoutCliError("invalid observed-session tuple");
  return { nodeId, harness, nativeSessionId };
}

export async function readObservedSessionMaterials(context: ScoutCommandContext, identity: ObservedSessionIdentity): Promise<ObservedSessionMaterials> {
  const params = new URLSearchParams(identity);
  const result = await readScoutRuntimeJson<ObservedSessionMaterials>(context, `/v1/observed-sessions/materials?${params}`);
  if (result.schema !== "scout.session-materials/v1" || result.identity?.nodeId !== identity.nodeId || result.identity?.harness !== identity.harness || result.identity?.nativeSessionId !== identity.nativeSessionId) throw new ScoutCliError("session_materials_identity_mismatch");
  return result;
}
