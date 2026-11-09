import {runPairHostBinding} from "./pair-host-binding.ts";
import { localConfigHome } from "@openscout/runtime/local-config";
import { createPendingPairRequestStore, pairRequestStatePath, type PairRequest } from "@openscout/pairing/pair-requests";
import { decideHostPairingRequest } from "@openscout/pairing/host";
import type { ScoutCommandContext } from "../context.ts";
import { startScoutPairingSession } from "@openscout/pairing";
import { renderScoutPairingEvent } from "@openscout/pairing/terminal";

type ScoutPairCommandOptions = {
  relayUrl?: string;
  forceManagedRelay: boolean;
};

function parsePairCommandOptions(args: string[]): ScoutPairCommandOptions {
  let relayUrl: string | undefined;
  let forceManagedRelay = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--managed") {
      forceManagedRelay = true;
      continue;
    }
    if (current === "--relay") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("missing value for --relay");
      }
      relayUrl = value;
      index += 1;
      continue;
    }
    if (current.startsWith("--relay=")) {
      relayUrl = current.slice("--relay=".length);
      continue;
    }
    throw new Error(`unexpected arguments for pair: ${args.join(" ")}`);
  }

  return {
    relayUrl,
    forceManagedRelay,
  };
}

export function renderPairCommandHelp(): string {
  return [
    "Usage: scout pair [--managed] [--relay URL]",
    "       scout pair bind-host <migration-id> --quiescent",
    "       scout pair requests [list]",
    "       scout pair requests show <token>",
    "       scout pair requests approve <token>",
    "       scout pair requests deny <token>",
    "",
    "Requests are host-local shared pairing rows, not Scout questions.",
    "Use --json for structured output. Account approval opens no QR window.",
  ].join("\n");
}

function renderRequest(request: PairRequest): string {
  return `${request.token}  ${request.status}  ${request.route ?? "network"}  ${request.requesterLabel ?? "A device"}\n`
    + `  Noise key: ${request.requesterPublicKey ?? "not supplied"}\n  Expires: ${new Date(request.expiresAt).toISOString()}`;
}

async function runPairRequests(context: ScoutCommandContext, args: string[]): Promise<void> {
  const action = args[0] ?? "list", token = args[1];
  if (!(action === "list" && args.length <= 1)
    && !(["show", "approve", "deny"].includes(action) && Boolean(token) && args.length === 2)) {
    throw new Error(renderPairCommandHelp());
  }
  const store = createPendingPairRequestStore({ statePath: pairRequestStatePath(localConfigHome()) });
  try {
    if (action === "list") {
      context.output.writeValue({ requests: store.list() }, value => value.requests.length
        ? value.requests.map(renderRequest).join("\n") : "No live pairing requests.");
      return;
    }
    if (action === "show") {
      const request = store.get(token!);
      if (!request) throw new Error("Unknown or expired pairing request");
      context.output.writeValue({ request }, value => renderRequest(value.request));
      return;
    }
    const result = await decideHostPairingRequest(store, token!, action as "approve" | "deny", context.cwd);
    if (!result.ok) throw new Error(result.error);
    context.output.writeValue({ request: result.request }, value => renderRequest(value.request));
  } finally { store.dispose(); }
}

export async function runPairCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) { context.stdout(renderPairCommandHelp()); return; }
  if (args[0] === "bind-host") return runPairHostBinding(context,args.slice(1));
  if (args[0] === "requests") return runPairRequests(context, args.slice(1));
  const options = parsePairCommandOptions(args);
  const session = await startScoutPairingSession({
    relayUrl: options.relayUrl,
    forceManagedRelay: options.forceManagedRelay,
    onEvent(event) {
      if (context.output.mode === "json") {
        context.stdout(JSON.stringify(event));
        return;
      }
      context.stdout(renderScoutPairingEvent(event));
    },
  });

  const controller = new AbortController();
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    controller.abort();
    await session.stop();
  };

  const handleSignal = () => {
    void stop();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}
