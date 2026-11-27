import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { LocalAgentPermissionRequest } from "@openscout/agent-sessions/local";
import type { decideNativeToolSupervisor } from "./permission-supervisor.js";

const fileTools = new Map([
  ["read_file", "read"], ["view_file", "read"],
  ["edit_file", "edit"], ["write_file", "edit"],
  ["edit", "edit"], ["write", "edit"], ["multiedit", "edit"],
]);
const commandTools = new Set(["run_command", "bash", "shell_exec"]);
const cwdFields = ["Cwd", "cwd", "workdir", "WorkingDirectory", "workingDirectory", "working_directory"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function fieldsFrom(input: Record<string, unknown>, keys: string[]): unknown[] {
  return keys.filter(key => Object.hasOwn(input, key)).map(key => input[key]);
}

async function singleProjectPath(root: string, values: unknown[]): Promise<string | undefined> {
  if (!isAbsolute(root) || values.length === 0) return;
  const targets = new Set<string>();
  for (const path of values) {
    if (typeof path !== "string" || !path.trim() || path !== path.trim()
      || /[\x00-\x1f~\\]/u.test(path) || /^\w+:/u.test(path) || path.split(sep).includes("..")) return;
    targets.add(resolve(root, path));
  }
  if (targets.size !== 1) return;
  const target = targets.values().next().value;
  if (!target) return;
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  try {
    // Do not allow aliases (including symlinks to secrets) or unresolved paths.
    if (await realpath(target) === target && await realpath(root) === resolve(root)) return target;
  } catch { /* Unresolved paths go to the operator. */ }
}

/** Translate only structured, unambiguous ACP calls; titles are not parsed as commands or paths. */
export async function acpPermissionTool(
  projectRoot: string,
  call: LocalAgentPermissionRequest["acpToolCall"],
): Promise<Parameters<typeof decideNativeToolSupervisor>[0] | undefined> {
  if (!call?.offersAllowOnce) return;
  if ((call.title != null && typeof call.title !== "string")
    || (call.kind != null && typeof call.kind !== "string")) return;
  const toolName = call.title?.trim().toLowerCase().replaceAll(" ", "_")
    ?? (call.kind === "read" ? "read_file" : "");
  const raw = record(call.rawInput);
  if (call.rawInput != null && !raw) return;
  const input = raw ?? {};
  const directories = fieldsFrom(input, cwdFields);
  if (input.BypassSandbox != null && input.BypassSandbox !== false && input.BypassSandbox !== "false") return;
  const kind = fileTools.get(toolName);
  if (kind) {
    if (call.kind && call.kind !== kind) return;
    if (directories.length && await singleProjectPath(projectRoot, directories) !== resolve(projectRoot)) return;
    const values = fieldsFrom(input, ["Path", "file_path", "TargetFile", "path", "filePath"]);
    if (call.locations != null) {
      if (!Array.isArray(call.locations)) return;
      values.push(...call.locations.map(location => record(location)?.path));
    }
    const path = await singleProjectPath(projectRoot, values);
    if (path) return { projectRoot, toolName, toolInput: { Path: path } };
  } else if (commandTools.has(toolName)) {
    if ((call.kind && call.kind !== "execute")
      || (call.locations != null && (!Array.isArray(call.locations) || call.locations.length))) return;
    const commands = fieldsFrom(input, ["CommandLine", "command"]);
    const command = commands[0];
    if (typeof command !== "string" || !command.trim() || commands.some(value => value !== command)) return;
    const cwd = await singleProjectPath(projectRoot, directories.length ? directories : [projectRoot]);
    if (cwd) return { projectRoot, cwd, toolName, toolInput: { command } };
  }
}
