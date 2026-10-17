import { resolve } from "node:path";
import type { SlackSetupReceipt } from "@openscout/protocol";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { resolveScoutBrokerUrl } from "../../core/broker/service.ts";

export const INTEGRATION_HELP = [
  "scout integration t3 inspect --connection <id>",
  "scout integration t3 board|refresh --connection <id> --project <t3-project-id>",
  "scout integration t3 attach --connection <id> --thread <t3-thread-id>",
  "scout integration t3 run --connection <id> --project <t3-project-id> --card <t3-card-id> --request-id <id>",
  "scout integration setup slack --project <path> [--agent <id>] [--name <name>] [--workspace <team-id>] [--idempotency-key <key>]",
  "scout integration status <operation>",
  "scout integration rebind <operation> --if-revision <n> --project <path> [--agent <id>]",
  "scout integration verify <operation> --if-revision <n>",
  "scout integration start|pause|disconnect <operation> --if-revision <n>",
  "scout integration manifest <operation> --json",
  "scout integration credentials|rotate-credentials <operation> --if-revision <n> --app-token-key <entry> --bot-token-key <entry> --allowed-users U123 [--allowed-channels C123,C456] [--credential-backend secret_cli|private_file]",
  "scout integration resume <operation> --if-revision <n> --workspace <team-id>",
  "scout integration resume <operation> --if-revision <n> --confirm-workspace-authority",
  "scout integration resume <operation> --if-revision <n> --app <app-id>",
  "",
  "Local pilot setup. Uses an existing registered project agent; does not create or install a Slack app.",
  "Authority confirmation records the human operator's confirmation; agents must not infer it.",
  "Never pass credentials here. Status reports the next setup action, not a connected integration.",
  "T3 connections are configured on the broker through OPENSCOUT_T3_CONNECTIONS=[{id,url,tokenEnv}].",
  "T3 commands return JSON; attach returns a Scout session for normal scout ask --to session:<id> continuation.",
  "T3 project/thread IDs are opaque source IDs. Refresh records board observations in Scout work items.",
].join("\n");

function parseT3IntegrationCommand(args: string[]): { path: string; body: unknown } {
  const [command, ...rest] = args;
  if (!["inspect", "board", "attach", "refresh", "run"].includes(command ?? "")) {
    throw new ScoutCliError("Use scout integration t3 inspect, board, attach, refresh, or run. See scout integration --help.");
  }
  const allowed = ["--connection", ...(command === "attach" ? ["--thread"] : command !== "inspect" ? ["--project"] : []), ...(command === "run" ? ["--card", "--request-id"] : [])];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.includes(flag) || flags[flag] !== undefined) {
      throw new ScoutCliError("Unknown or duplicate T3 option. Use scout integration --help.");
    }
    const value = rest[++i];
    if (!value?.trim() || value.startsWith("--")) throw new ScoutCliError(`${flag} requires a value`);
    flags[flag] = value;
  }
  if (!flags["--connection"]) throw new ScoutCliError("T3 commands require --connection with a broker-configured connection ID.");
  if (command === "attach" && !flags["--thread"]) throw new ScoutCliError("T3 attach requires --thread with an exact T3 thread ID.");
  if (["board", "refresh", "run"].includes(command!) && !flags["--project"]) throw new ScoutCliError(`T3 ${command} requires --project with an exact T3 project ID.`);
  if (command === "run" && (!flags["--card"] || !flags["--request-id"])) throw new ScoutCliError("T3 run requires --card and --request-id. Reuse the request ID only to recover the same Scout receipt.");
  return {
    path: `/v1/integrations/t3/${command}`,
    body: {
      connectionId: flags["--connection"],
      ...(flags["--project"] ? { projectId: flags["--project"] } : {}),
      ...(flags["--thread"] ? { threadId: flags["--thread"] } : {}),
      ...(flags["--card"] ? { cardId: flags["--card"] } : {}),
      ...(flags["--request-id"] ? { requestId: flags["--request-id"] } : {}),
    },
  };
}

export function parseIntegrationCommand(args: string[], cwd: string): { path: string; body?: unknown } {
  const [command, target, ...rest] = args;
  if (command === "t3") return parseT3IntegrationCommand([target, ...rest].filter((value): value is string => value !== undefined));
  const allowed = command === "setup"
    ? ["--project", "--agent", "--name", "--workspace", "--idempotency-key"]
    : command === "rebind" ? ["--if-revision", "--project", "--agent"]
    : ["start", "pause", "disconnect", "verify"].includes(command ?? "") ? ["--if-revision"]
    : ["credentials", "rotate-credentials"].includes(command ?? "") ? ["--if-revision", "--app-token-key", "--bot-token-key", "--allowed-users", "--allowed-channels", "--credential-backend"]
    : command === "resume" ? ["--if-revision", "--workspace", "--app", "--confirm-workspace-authority"] : [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.includes(flag) || flags[flag] !== undefined) throw new ScoutCliError("Unknown or duplicate integration option. Use scout integration --help.");
    if (flag === "--confirm-workspace-authority") { flags[flag] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new ScoutCliError(`${flag} requires a value`);
    flags[flag] = value;
  }
  if (command === "setup" && target === "slack") {
    return { path: "/v1/integrations/setup", body: {
      provider: "slack", mode: "project_agent", projectPath: resolve(cwd, flags["--project"] as string ?? "."),
      ...(flags["--agent"] ? { agentId: flags["--agent"] } : {}),
      ...(flags["--name"] ? { displayName: flags["--name"] } : {}),
      ...(flags["--workspace"] ? { workspaceId: flags["--workspace"] } : {}),
      ...(flags["--idempotency-key"] ? { idempotencyKey: flags["--idempotency-key"] } : {}),
    } };
  }
  if (!target || target.startsWith("--")) throw new ScoutCliError("An integration operation ID is required.");
  const path = `/v1/integrations/setup/${encodeURIComponent(target)}`;
  if (command === "rebind") {
    const expectedRevision = Number(flags["--if-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !flags["--project"]) throw new ScoutCliError("Rebinding requires --project and the latest --if-revision.");
    return { path: `${path}/rebind`, body: { expectedRevision, projectPath: resolve(cwd, String(flags["--project"])), ...(flags["--agent"] ? { agentId: flags["--agent"] } : {}) } };
  }
  if (command === "status") return { path };
  if (command === "manifest") return { path: `${path}/manifest` };
  if (["start", "pause", "disconnect", "verify"].includes(command ?? "")) {
    const expectedRevision = Number(flags["--if-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ScoutCliError("--if-revision must be a positive integer from the latest status.");
    return command === "verify" ? { path: `${path}/verify`, body: { expectedRevision } } : { path: `${path}/lifecycle`, body: { action: command, expectedRevision } };
  }
  if (command === "credentials" || command === "rotate-credentials") {
    const expectedRevision = Number(flags["--if-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ScoutCliError("--if-revision must be a positive integer from the latest status.");
    if (!flags["--app-token-key"] || !flags["--bot-token-key"] || !flags["--allowed-users"]) throw new ScoutCliError("Credential attachment requires two local entry names and an explicit allowed-user list. Use secret set <entry> for hidden token input first.");
    if (flags["--credential-backend"] && !["secret_cli", "private_file"].includes(String(flags["--credential-backend"]))) throw new ScoutCliError("Unknown credential backend.");
    return { path: `${path}/credentials`, body: {
      expectedRevision, ...(command === "rotate-credentials" ? { rotate: true } : {}), reference: { backend: flags["--credential-backend"] ?? "secret_cli", appTokenKey: flags["--app-token-key"], botTokenKey: flags["--bot-token-key"] },
      allowedUserIds: String(flags["--allowed-users"]).split(","), allowedChannelIds: flags["--allowed-channels"] ? String(flags["--allowed-channels"]).split(",") : [],
    } };
  }
  if (command === "resume") {
    const expectedRevision = Number(flags["--if-revision"]);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ScoutCliError("--if-revision must be a positive integer from the latest status.");
    const actions = [flags["--workspace"], flags["--confirm-workspace-authority"], flags["--app"]].filter(Boolean);
    if (actions.length !== 1) throw new ScoutCliError("Choose exactly one resume action: --workspace, --confirm-workspace-authority, or --app.");
    const body = flags["--workspace"] ? { action: "choose_workspace", workspaceId: flags["--workspace"] }
      : flags["--app"] ? { action: "register_app", appId: flags["--app"] } : { action: "confirm_authority" };
    return { path: `${path}/resume`, body: { ...body, expectedRevision } };
  }
  throw new ScoutCliError("Unknown integration command. Use scout integration --help.");
}

export async function runIntegrationCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (!args.length || args.some((arg) => ["--help", "-h", "help"].includes(arg))) { context.output.writeText(INTEGRATION_HELP); return; }
  const request = parseIntegrationCommand(args, context.cwd);
  const response = await fetch(new URL(request.path, resolveScoutBrokerUrl()), {
    method: request.body ? "POST" : "GET", headers: { "content-type": "application/json" },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}), signal: AbortSignal.timeout(["credentials", "rotate-credentials"].includes(args[0] ?? "") ? 75_000 : 15_000),
  });
  const payload = await response.json() as SlackSetupReceipt & { error?: string; detail?: string };
  if (!response.ok) throw new ScoutCliError(payload.detail ?? payload.error ?? `Broker returned HTTP ${response.status}`);
  if (["manifest", "t3"].includes(args[0] ?? "")) { context.output.writeValue(payload, value => JSON.stringify(value, null, 2)); return; }
  context.output.writeValue(payload, (receipt) => [
    `${receipt.operation.displayName}: ${receipt.operation.state} (${receipt.readiness})`,
    `Operation: ${receipt.operation.id}; revision: ${receipt.operation.revision}`,
    `Project: ${receipt.operation.binding.projectPath}`,
    `Next: ${receipt.nextAction.title}`,
    ...(receipt.eventQueue ? [`Slack event queue: ${receipt.eventQueue.pending} pending; ${receipt.eventQueue.retrying} awaiting retry.`] : []),
  ].join("\n"));
}
