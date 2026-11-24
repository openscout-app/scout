import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import { requestScoutBrokerJson, ScoutBrokerHttpError } from "@openscout/runtime/client";
import { resolveBrokerControlUrl } from "@openscout/runtime/config";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

type RoleCommand =
  | { command: "help" }
  | { command: "catalog"; json: boolean }
  | {
      command: "list";
      agentId?: string;
      missionId?: string;
      roleId?: string;
      activeOnly: boolean;
      json: boolean;
    }
  | {
      command: "assign";
      roleId: string;
      agentId: string;
      scope: "mission" | "agent" | "project";
      missionId?: string;
      projectRoot?: string;
      assignedById: string;
      allowMultiple: boolean;
      json: boolean;
    }
  | {
      command: "revoke";
      assignmentId: string;
      revokedById: string;
      json: boolean;
    }
  | {
      command: "log";
      missionId: string;
      limit?: number;
      json: boolean;
    }
  | {
      command: "log-append";
      missionId: string;
      actorId: string;
      kind: string;
      intent: string;
      status: string;
      checkpoint?: string;
      note?: string;
      projectRoot?: string;
      json: boolean;
    };

export function renderRoleCommandHelp(): string {
  return [
    "Usage: scout role <command> [options]",
    "",
    "Assigned roles (orchestrator first) and mission log.",
    "Only assigned orchestrators write mission logs — no global spam.",
    "",
    "Commands:",
    "  catalog                              List role definitions",
    "  list [--agent <id>] [--mission <id>] [--role <id>] [--all]",
    "  assign --role orchestrator --agent <id> --mission <workId>",
    "  assign --role orchestrator --agent <id> --standing",
    "  revoke <assignmentId>",
    "  log <missionId> [--limit N]",
    "  log-append <missionId> --actor <id> --kind progress --intent \"...\" --status \"...\"",
    "             [--project <root>] [--checkpoint ...] [--note ...]",
    "",
    "Examples:",
    "  scout role assign --role orchestrator --agent premotion.main --mission work-abc",
    "  scout role log work-abc",
    "  scout role log-append work-abc --actor premotion.main --kind progress \\",
    "    --intent \"Ship unify-send\" --status \"Linking child asks\"",
    "  scout role log-append work-abc --actor premotion.main --project /path/to/repo \\",
    "    --kind progress --intent \"Track\" --status \"Update\"  # project-scoped orchestrator",
  ].join("\n");
}

function takeFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new ScoutCliError(`${name} requires a value`);
  }
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseRoleCommandOptions(args: string[]): RoleCommand {
  if (args.length === 0 || args.some((a) => HELP_FLAGS.has(a))) {
    return { command: "help" };
  }

  const [head, ...rest] = args;
  const json = hasFlag(rest, "--json") || hasFlag(args, "--json");

  switch (head) {
    case "catalog":
      return { command: "catalog", json };
    case "list": {
      return {
        command: "list",
        agentId: takeFlag(rest, "--agent"),
        missionId: takeFlag(rest, "--mission"),
        roleId: takeFlag(rest, "--role"),
        activeOnly: !hasFlag(rest, "--all"),
        json,
      };
    }
    case "assign": {
      const roleId = takeFlag(rest, "--role");
      const agentId = takeFlag(rest, "--agent");
      if (!roleId || !agentId) {
        throw new ScoutCliError("role assign requires --role and --agent");
      }
      const missionId = takeFlag(rest, "--mission");
      const projectRoot = takeFlag(rest, "--project");
      const standing = hasFlag(rest, "--standing");
      let scope: "mission" | "agent" | "project" = "agent";
      if (missionId) scope = "mission";
      else if (projectRoot) scope = "project";
      else if (standing) scope = "agent";
      else {
        throw new ScoutCliError(
          "role assign requires --mission <workId>, --project <root>, or --standing",
        );
      }
      return {
        command: "assign",
        roleId,
        agentId,
        scope,
        missionId,
        projectRoot,
        assignedById: takeFlag(rest, "--by") ?? "operator",
        allowMultiple: hasFlag(rest, "--allow-multiple"),
        json,
      };
    }
    case "revoke": {
      const assignmentId = rest.find((a) => !a.startsWith("--"));
      if (!assignmentId) throw new ScoutCliError("role revoke requires <assignmentId>");
      return {
        command: "revoke",
        assignmentId,
        revokedById: takeFlag(rest, "--by") ?? "operator",
        json,
      };
    }
    case "log": {
      const missionId = rest.find((a) => !a.startsWith("--"));
      if (!missionId) throw new ScoutCliError("role log requires <missionId>");
      const limitRaw = takeFlag(rest, "--limit");
      return {
        command: "log",
        missionId,
        limit: limitRaw ? Number(limitRaw) : undefined,
        json,
      };
    }
    case "log-append": {
      const missionId = rest.find((a) => !a.startsWith("--"));
      if (!missionId) throw new ScoutCliError("role log-append requires <missionId>");
      const actorId = takeFlag(rest, "--actor");
      const kind = takeFlag(rest, "--kind");
      const intent = takeFlag(rest, "--intent");
      const status = takeFlag(rest, "--status");
      if (!actorId || !kind || !intent || !status) {
        throw new ScoutCliError(
          "role log-append requires --actor, --kind, --intent, and --status",
        );
      }
      return {
        command: "log-append",
        missionId,
        actorId,
        kind,
        intent,
        status,
        checkpoint: takeFlag(rest, "--checkpoint"),
        note: takeFlag(rest, "--note"),
        projectRoot: takeFlag(rest, "--project"),
        json,
      };
    }
    default:
      throw new ScoutCliError(`unknown role command: ${head}`);
  }
}

// Roles and the mission log live in the runtime, so these commands need no web app.
async function requestRoleJson<T>(
  context: ScoutCommandContext,
  path: string,
  body?: unknown,
): Promise<T> {
  const baseUrl = context.env.OPENSCOUT_BROKER_URL?.trim() || resolveBrokerControlUrl();
  try {
    return await requestScoutBrokerJson<T>(baseUrl, path, {
      method: body === undefined ? "GET" : "POST",
      body,
      socketPath: context.env.OPENSCOUT_BROKER_SOCKET_PATH?.trim() || undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (!(error instanceof ScoutBrokerHttpError)) throw error;
    const detail = /returned \d+: (.*)$/s.exec(error.message)?.[1] ?? "";
    let parsed: { error?: unknown; detail?: unknown } = {};
    try { parsed = JSON.parse(detail); } catch {}
    if (parsed.error === "roles_unavailable") {
      throw new ScoutCliError("Roles are unavailable: the runtime has no roles store open (HTTP 503).");
    }
    throw new ScoutCliError(typeof parsed.error === "string" ? parsed.error : `runtime returned HTTP ${error.status}`);
  }
}

export async function runRoleCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const options = parseRoleCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderRoleCommandHelp());
    return;
  }

  if (options.command === "catalog") {
    const data = await requestRoleJson<{ roles: Array<{ id: string; label: string; summary: string }> }>(
      context,
      "/v1/roles/catalog",
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    for (const role of data.roles) {
      context.output.writeText(`${role.id}\t${role.label}\t${role.summary}`);
    }
    return;
  }

  if (options.command === "list") {
    const params = new URLSearchParams();
    if (options.agentId) params.set("agentId", options.agentId);
    if (options.missionId) params.set("missionId", options.missionId);
    if (options.roleId) params.set("roleId", options.roleId);
    if (!options.activeOnly) params.set("activeOnly", "0");
    const qs = params.toString();
    const data = await requestRoleJson<{ assignments: Array<Record<string, unknown>> }>(
      context,
      `/v1/roles/assignments${qs ? `?${qs}` : ""}`,
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    if (data.assignments.length === 0) {
      context.output.writeText("No role assignments.");
      return;
    }
    for (const row of data.assignments) {
      const scope = row.scope as { kind?: string; missionId?: string; projectRoot?: string } | undefined;
      const scopeLabel =
        scope?.kind === "mission"
          ? `mission:${scope.missionId}`
          : scope?.kind === "project"
            ? `project:${scope.projectRoot}`
            : "standing";
      context.output.writeText(
        `${row.id}\t${row.roleId}\t${row.agentId}\t${scopeLabel}\t${row.active ? "active" : "revoked"}`,
      );
    }
    return;
  }

  if (options.command === "assign") {
    const scope =
      options.scope === "mission"
        ? { kind: "mission" as const, missionId: options.missionId! }
        : options.scope === "project"
          ? { kind: "project" as const, projectRoot: options.projectRoot! }
          : { kind: "agent" as const };
    const data = await requestRoleJson<{ assignment: Record<string, unknown> }>(
      context,
      "/v1/roles/assignments",
      {
        roleId: options.roleId,
        agentId: options.agentId,
        scope,
        assignedById: options.assignedById,
        enforceSingleHolder: !options.allowMultiple,
        // Older runtimes read only this name.
        enforceSingleOrchestrator: !options.allowMultiple,
      },
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    context.output.writeText(
      `Assigned ${data.assignment.roleId} → ${data.assignment.agentId} (${data.assignment.id})`,
    );
    return;
  }

  if (options.command === "revoke") {
    const data = await requestRoleJson<{ assignment: Record<string, unknown> }>(
      context,
      `/v1/roles/assignments/${encodeURIComponent(options.assignmentId)}/revoke`,
      { revokedById: options.revokedById },
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    context.output.writeText(`Revoked ${data.assignment.id}`);
    return;
  }

  if (options.command === "log") {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    const qs = params.toString();
    const data = await requestRoleJson<{
      missionId: string;
      entries: Array<Record<string, unknown>>;
    }>(
      context,
      `/v1/missions/${encodeURIComponent(options.missionId)}/log${qs ? `?${qs}` : ""}`,
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    if (data.entries.length === 0) {
      context.output.writeText(`No mission log entries for ${data.missionId}.`);
      return;
    }
    for (const entry of data.entries) {
      context.output.writeText(
        `${entry.seq}\t${entry.kind}\t${entry.intent}\t${entry.status}\t${entry.actorId}`,
      );
    }
    return;
  }

  if (options.command === "log-append") {
    const data = await requestRoleJson<{ entry: Record<string, unknown> }>(
      context,
      `/v1/missions/${encodeURIComponent(options.missionId)}/log`,
      {
        actorId: options.actorId,
        kind: options.kind,
        intent: options.intent,
        status: options.status,
        checkpoint: options.checkpoint,
        note: options.note,
        projectRoot: options.projectRoot,
      },
    );
    if (options.json) {
      context.output.writeText(JSON.stringify(data, null, 2));
      return;
    }
    context.output.writeText(
      `Logged seq=${data.entry.seq} ${data.entry.kind}: ${data.entry.status}`,
    );
  }
}
