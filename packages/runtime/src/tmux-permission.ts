import { createHash } from "node:crypto";
import { parseContinuationDialog, stripTerminalControls } from "./continuation/dialog.js";
import { requestManagedPermission, type ManagedPermissionPrompt, type PermissionDecision } from "./managed-permission.js";

export function parseTmuxPermission(text: string, projectRoot?: string): { version: string; identity: string; text: string; keys: Partial<Record<PermissionDecision, string[]>> } | null {
  let clean = stripTerminalControls(text).trim();
  const latestTrust = clean.lastIndexOf("Accessing workspace:");
  const latestTool = clean.lastIndexOf("Do you want to proceed?");
  if (latestTrust > latestTool && /Yes,\s*I\s*trust\s*this\s*folder/i.test(clean.slice(latestTrust))) {
    const start = clean.lastIndexOf("Accessing workspace:");
    const end = clean.indexOf("Esc to cancel", start);
    if (start < 0 || end < 0 || /[❯⏺●]/.test(clean.slice(end + "Esc to cancel".length))) return null;
    clean = clean.slice(start, end + "Esc to cancel".length).trim();
  } else {
    const question = clean.lastIndexOf("Do you want to proceed?");
    const prefix = clean.slice(0, question);
    // Generic tool confirmations (for example EnterWorktree) have a Tool use
    // header. Bind only the live dialog, never capture-dependent scrollback.
    const headers = [...prefix.matchAll(/^[ \t]*(?:Bash command|Edit file|Write file|Create file|Read file|Fetch|Web ?search|Tool use|MCP tool)[ \t]*$/gim)];
    const header = headers.at(-1)?.index ?? -1;
    const end = clean.indexOf("Esc to cancel", question);
    if (header >= 0 && end >= 0) clean = clean.slice(header, end + "Esc to cancel".length).trim();
  }
  let keys: Partial<Record<PermissionDecision, string[]>> = {};
  if (/Yes,\s*I\s*trust\s*this\s*folder/i.test(clean)) {
    // Trust is persistent in Claude. Never present it as a one-shot grant.
    const options = clean.split("\n").filter(line => /^\s*(?:❯\s*)?(?:No, exit|Yes, I trust this folder)\s*$/.test(line));
    const selected = options.findIndex(line => /^\s*❯/.test(line));
    if (options.length !== 2 || selected < 0 || !/Enter to confirm/.test(clean)) return null;
    const trust = options.findIndex(line => /Yes, I trust/.test(line));
    const deny = options.findIndex(line => /No, exit/.test(line));
    const to = (index: number) => index === selected ? ["Enter"] : [index > selected ? "Down" : "Up", "Enter"];
    keys = { project: to(trust), deny: to(deny) };
  } else {
    const dialog = parseContinuationDialog(text);
    if (!dialog.live || dialog.kind !== "permission") return null;
    for (const option of dialog.options) {
      const decision = option.kind === "allow" ? "once" : option.kind === "deny" ? "deny"
        : option.kind === "allow_always" && !/switch to auto mode/i.test(option.label)
          && (/project|folder|directory/i.test(option.label)
            || Boolean(projectRoot && option.label.endsWith(` in ${projectRoot}`))) ? "project" : null;
      if (decision) keys[decision] = option.selected ? ["Enter"] : [String(option.index)];
    }
    if (!keys.once || !keys.deny) return null;
  }
  return { text: clean, version: createHash("sha256").update(clean).digest("hex"),
    identity: createHash("sha256").update(clean.replace(/^\s*❯?\s*(?=\d+\.|No, exit|Yes, I trust this folder)/gm, "")).digest("hex"), keys };
}

type TmuxPermissionPane = {
  sessionId: string; projectRoot: string; text: string;
  capture: () => Promise<string>; alive: () => Promise<boolean>;
  send: (keys: string[]) => Promise<void>;
};

/** Binds the prompt in `text` to its pane. Null when `text` shows no answerable prompt. */
export function tmuxPermissionPrompt(input: TmuxPermissionPane): ManagedPermissionPrompt | null {
  const prompt = parseTmuxPermission(input.text, input.projectRoot);
  if (!prompt) return null;
  const current = async () => await input.alive() && parseTmuxPermission(await input.capture(), input.projectRoot)?.version === prompt.version;
  return { sessionId: input.sessionId, projectRoot: input.projectRoot,
    text: prompt.text, version: prompt.version, decisions: Object.keys(prompt.keys) as PermissionDecision[],
    isCurrent: current,
    answer: async decision => {
      if (!await current()) throw new Error("Permission prompt changed before key delivery.");
      const keys = prompt.keys[decision];
      if (!keys?.length) throw new Error("Permission scope is not offered by the harness.");
      await input.send(keys);
      // Key submission is not acknowledgement. Wait for this prompt to leave.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!await input.alive()) {
          if (decision === "deny") return;
          throw new Error("Live permission process exited before acknowledging the grant.");
        }
        const tail = await input.capture();
        if (tail.trim()) {
          const next = parseTmuxPermission(tail, input.projectRoot);
          if (!next || next.identity !== prompt.identity) return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Permission keys sent but the harness did not acknowledge them.");
    },
  };
}

export async function waitForTmuxPermission(input: TmuxPermissionPane): Promise<boolean> {
  const prompt = tmuxPermissionPrompt(input);
  return prompt ? requestManagedPermission(prompt) : false;
}
