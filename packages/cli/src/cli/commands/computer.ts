import type { ComputerActKind } from "@openscout/protocol";
import { createScoutComputerClient, type ScoutComputerClient } from "@openscout/runtime";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const COMPUTER_HELP = `scout computer — Scout Computer native desktop automation (macOS)

Usage:
  scout computer status [--json]
  scout computer drive status [--json]
  scout computer drive begin --task <text> [--agent <name>] [--mode background|attention] [--pointer-control] [--json]
  scout computer drive note <line> [--lease-id <id>] [--json]
  scout computer drive release --lease-id <id> [--outcome done|failed|cancelled] [--summary <text>] [--json]
  scout computer layer open [--bundle-id <id> | --pid <n>] [--window-id <n>] [--window-title <text>] [--width <n> --height <n>] [--no-pip] [--json]
  scout computer layer status [--json]
  scout computer layer snapshot [--window-id <n>] [--full] [--output <path>] [--json]
  scout computer layer pip [--json]
  scout computer layer close [--json]
  scout computer windows [--bundle-id <id> | --app <name> | --pid <n>] [--raise] [--json]
  scout computer screenshot [--bundle-id <id> | --app <name> | --pid <n>] [--window-id <n>] [--output <path>] [--json]
  scout computer focus [--bundle-id <id> | --app <name> | --pid <n>] [--title <title>] [--launch] [--json]
  scout computer inspect [--bundle-id <id> | --app <name> | --pid <n>] [--json]
  scout computer click --x <n> --y <n> [--lease-id <id>] [--json]
  scout computer type <text> [--bundle-id <id> | --app <name> | --pid <n>] [--lease-id <id>] [--json]
  scout computer key <key> [--modifiers <cmd,shift,...>] [--bundle-id <id> | --app <name> | --pid <n>] [--lease-id <id>] [--json]
  scout computer scroll [--delta-y <n>] [--delta-x <n>] [--x <n>] [--y <n>] [--lease-id <id>] [--json]
  scout computer drag --from-x <n> --from-y <n> --to-x <n> --to-y <n> [--lease-id <id>] [--json]
  scout computer ocr <imagePath> [--json]`;

const BOOLEAN_FLAGS = new Set(["raise", "launch", "pointer-control", "full", "no-pip", "pip"]);

function parseArgs(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--json") continue;
    if (arg.startsWith("--") && BOOLEAN_FLAGS.has(arg.slice(2))) {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (!next || next.startsWith("--")) throw new ScoutCliError(`${arg} needs a value`);
        flags[arg.slice(2)] = next;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags, help };
}

function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const raw = flags[key];
  if (typeof raw !== "string") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ScoutCliError(`--${key} must be a number`);
  return parsed;
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const raw = flags[key];
  return typeof raw === "string" ? raw : undefined;
}

export async function runComputerCommand(
  context: ScoutCommandContext,
  args: string[],
  client: ScoutComputerClient = createScoutComputerClient(),
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    context.output.writeText(COMPUTER_HELP);
    return;
  }

  if (subcommand === "drive") {
    const action = args[1];
    if (!action || action === "--help" || action === "-h") {
      context.output.writeText(COMPUTER_HELP);
      return;
    }
    const { positional, flags } = parseArgs(args.slice(2));
    if (action === "status") {
      const status = await client.driveStatus();
      context.output.writeValue(status, () => [
        `connected: ${status.connected ? "yes" : "no"}`,
        `state: ${status.state}`,
        `leases: ${status.leases.length}`,
      ].join("\n"));
      return;
    }
    let receipt;
    if (action === "begin") {
      const task = strFlag(flags, "task") ?? positional.join(" ");
      if (!task) throw new ScoutCliError("scout computer drive begin requires --task <text>");
      const mode = strFlag(flags, "mode");
      receipt = await client.driveBegin({
        task,
        agent: strFlag(flags, "agent"),
        mode: mode === "attention" ? "attention" : "background",
        pointerControl: Boolean(flags["pointer-control"]),
      });
    } else if (action === "release") {
      const leaseId = strFlag(flags, "lease-id") ?? positional[0];
      if (!leaseId) throw new ScoutCliError("scout computer drive release requires --lease-id <id>");
      receipt = await client.driveRelease({
        leaseId,
        outcome: strFlag(flags, "outcome"),
        summary: strFlag(flags, "summary"),
      });
    } else if (action === "note") {
      const line = positional.join(" ") || strFlag(flags, "line");
      if (!line) throw new ScoutCliError("scout computer drive note requires a status line");
      receipt = await client.driveNote({ line, leaseId: strFlag(flags, "lease-id") });
    } else {
      throw new ScoutCliError(`unknown drive subcommand: ${action} (try: status|begin|note|release)`);
    }
    if (context.output.mode === "json") {
      context.output.writeValue(receipt, () => "");
    } else if (receipt.ok) {
      context.output.writeText(`${receipt.action}: ok${receipt.leaseId ? ` · ${receipt.leaseId}` : ""}`);
    } else {
      throw new ScoutCliError(receipt.error ?? `computer drive ${action} failed`);
    }
    return;
  }

  if (subcommand === "layer") {
    const action = args[1];
    if (!action || action === "--help" || action === "-h") {
      context.output.writeText(COMPUTER_HELP);
      return;
    }
    const { flags } = parseArgs(args.slice(2));
    if (action === "status") {
      const status = await client.layerStatus();
      context.output.writeValue(status, () => `active: ${status.active ? "yes" : "no"}${status.pid ? ` (pid ${status.pid})` : ""}`);
      return;
    }
    let receipt;
    if (action === "open") {
      receipt = await client.layerOpen({
        bundleId: strFlag(flags, "bundle-id"),
        pid: numFlag(flags, "pid"),
        width: numFlag(flags, "width"),
        height: numFlag(flags, "height"),
        pip: flags["no-pip"] ? false : flags.pip ? true : undefined,
        windowId: numFlag(flags, "window-id"),
        windowTitle: strFlag(flags, "window-title"),
        owner: "detached",
      });
    } else if (action === "close") {
      receipt = await client.layerClose();
    } else if (action === "snapshot") {
      receipt = await client.layerSnapshot({
        windowId: numFlag(flags, "window-id"),
        full: Boolean(flags.full),
        out: strFlag(flags, "output") ?? strFlag(flags, "out"),
      });
    } else if (action === "pip") {
      receipt = await client.layerPip();
    } else {
      throw new ScoutCliError(`unknown layer subcommand: ${action} (try: open|close|status|snapshot|pip)`);
    }
    if (context.output.mode === "json") {
      context.output.writeValue(receipt, () => "");
    } else if (receipt.ok) {
      const detail = receipt.outputPath ?? (receipt.data ? JSON.stringify(receipt.data) : "");
      context.output.writeText(`${receipt.action}: ok${detail ? ` · ${detail}` : ""}`);
    } else {
      throw new ScoutCliError(receipt.error ?? `computer layer ${action} failed`);
    }
    return;
  }

  const { positional, flags, help } = parseArgs(args.slice(1));
  if (help) {
    context.output.writeText(COMPUTER_HELP);
    return;
  }

  const target = {
    bundleId: strFlag(flags, "bundle-id"),
    app: strFlag(flags, "app"),
    pid: numFlag(flags, "pid"),
  };

  if (subcommand === "status") {
    const status = await client.status();
    context.output.writeValue(status, () => [
      `available: ${status.available ? "yes" : "no"}`,
      `agent: ${status.agentConnected ? "connected" : "offline"} (${status.agentUrl})`,
      status.binaryPath ? `binary: ${status.binaryPath}` : null,
      status.driveState ? `drive: ${status.driveState}${status.activeLeaseId ? ` (${status.activeLeaseId})` : ""}` : null,
      status.layer ? `layer: ${status.layer.active ? `active (pid ${status.layer.pid})` : "inactive"}` : null,
      status.permissions?.accessibility ? `accessibility: ${status.permissions.accessibility}` : null,
      status.permissions?.screenRecording ? `screenRecording: ${status.permissions.screenRecording}` : null,
      status.reason ? `note: ${status.reason}` : null,
    ].filter(Boolean).join("\n"));
    return;
  }

  let receipt;
  if (subcommand === "windows") {
    receipt = await client.listWindows({ ...target, raise: Boolean(flags.raise) });
  } else if (subcommand === "screenshot") {
    receipt = await client.screenshot({
      ...target,
      windowId: numFlag(flags, "window-id"),
      outputPath: strFlag(flags, "output"),
    });
  } else if (subcommand === "focus") {
    receipt = await client.focus({
      ...target,
      title: strFlag(flags, "title"),
      launch: Boolean(flags.launch),
    });
  } else if (subcommand === "inspect") {
    receipt = await client.inspect(target);
  } else if (subcommand === "click" || subcommand === "type" || subcommand === "key" || subcommand === "scroll" || subcommand === "drag" || subcommand === "ocr") {
    const kind = subcommand as ComputerActKind;
    const hasTarget = Boolean(target.bundleId || target.app || target.pid !== undefined);
    const leaseId = strFlag(flags, "lease-id");
    const payload: Parameters<ScoutComputerClient["act"]>[0] = {
      kind,
      ...(leaseId ? { leaseId } : {}),
      ...(hasTarget ? { target } : {}),
    };
    if (kind === "click") {
      payload.x = numFlag(flags, "x");
      payload.y = numFlag(flags, "y");
    } else if (kind === "type") {
      payload.text = positional.join(" ") || strFlag(flags, "text");
    } else if (kind === "key") {
      payload.key = positional[0] || strFlag(flags, "key");
      const mods = strFlag(flags, "modifiers")?.split(",").map((s) => s.trim()).filter(Boolean);
      if (mods?.length) payload.modifiers = mods;
    } else if (kind === "scroll") {
      payload.deltaX = numFlag(flags, "delta-x");
      payload.deltaY = numFlag(flags, "delta-y");
      payload.x = numFlag(flags, "x");
      payload.y = numFlag(flags, "y");
    } else if (kind === "drag") {
      payload.x = numFlag(flags, "from-x") ?? numFlag(flags, "x");
      payload.y = numFlag(flags, "from-y") ?? numFlag(flags, "y");
      payload.toX = numFlag(flags, "to-x");
      payload.toY = numFlag(flags, "to-y");
    } else if (kind === "ocr") {
      payload.imagePath = positional[0] || strFlag(flags, "input");
    }
    receipt = await client.act(payload);
  } else {
    throw new ScoutCliError(`unknown computer subcommand: ${subcommand} (try: scout computer status|drive|layer|windows|screenshot|focus|inspect|click|type|key|scroll|drag|ocr)`);
  }

  if (context.output.mode === "json") {
    context.output.writeValue(receipt, () => "");
  } else if (receipt.ok) {
    const detail = receipt.outputPath ?? (receipt.data ? JSON.stringify(receipt.data) : "");
    context.output.writeText(`${receipt.action}: ok${detail ? ` · ${detail}` : ""}`);
  } else {
    throw new ScoutCliError(receipt.error ?? `computer ${subcommand} failed`);
  }
}
