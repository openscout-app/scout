// Tool-call / tool-result formatting for the Tail firehose.
//
// Transcript lines carry raw tool payloads - full JSON argument blobs and, for
// results, the entire tool output (often a whole file). Rendered verbatim that
// is unreadable noise: `Read({"file_path":"/Users/.../scout-tail.tsx"})` or a
// tool result that is 200 lines of file content flattened onto one line.
//
// These helpers collapse each into a single clean line that reads like a shell
// log: the salient argument only (a short path, the command, the pattern), and
// results reduced to a compact preview plus scale (`res: import x ... (247
// lines)`). Both Claude and Codex sources share this so the stream is uniform
// across harnesses.

const HOME_RE = /\/Users\/[^/\s]+\//g;

/** Collapse whitespace, fold `$HOME` to `~`, and clip to a single line. */
export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").replace(HOME_RE, "~/").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a JSON-string argument blob (Codex `arguments`/`input`) if needed. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Last two path segments — enough to disambiguate, short enough to scan. */
function shortPath(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length <= 1) return segs[0] ?? p;
  return segs.slice(-2).join("/");
}

function commandString(obj: Record<string, unknown>): string | null {
  const direct = firstString(obj, ["command", "cmd", "script"]);
  if (direct) return direct;
  const arr = obj.command ?? obj.cmd;
  if (Array.isArray(arr)) {
    const joined = arr.filter((p) => typeof p === "string").join(" ");
    if (joined.trim()) return joined;
  }
  return null;
}

const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];
const PATTERN_KEYS = ["pattern", "query", "q", "regex", "search"];
const TEXT_KEYS = ["description", "prompt", "title", "name", "url", "message"];

function isShellTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("exec") || n === "shell" || n === "bash" || n === "local_shell" || n === "run";
}

/** Read literal arguments only. Never execute the code-mode wrapper. */
function codeModeSummary(code: string): string | null {
  const literal = String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
  const decode = (value: string): string | null => {
    if (value.startsWith('"')) {
      try { return JSON.parse(value) as string; } catch { return null; }
    }
    if (value.startsWith("`") && value.includes("${")) return null;
    return value.slice(1, -1).replace(/\\([\\'"`nrt])/gu, (_, char: string) =>
      ({ n: "\n", r: "\r", t: "\t" }[char] ?? char));
  };
  // Prefer the actual shell command even if the wrapper has text()/Promise.all().
  const command = new RegExp(String.raw`(?:tools|functions)\.exec_command\s*\(\s*\{[\s\S]{0,4096}?\b["']?cmd["']?\s*:\s*${literal}`, "u").exec(code);
  if (command?.[1]) {
    const value = decode(command[1]);
    if (value) return oneLine(value);
  }
  const call = /(?:tools|functions)\.([A-Za-z_][\w]*)\s*\(/u.exec(code);
  if (!call) return null;
  const args = code.slice(call.index + call[0].length, call.index + call[0].length + 4096);
  const arg = new RegExp(String.raw`^\s*(?:\{\s*["']?[\w]+["']?\s*:\s*)?${literal}`, "u").exec(args);
  const value = arg?.[1] ? decode(arg[1]) : null;
  return value ? `${call[1]} ${oneLine(value, 100)}` : call[1]!;
}

/**
 * One clean line for a tool call: `Read views/scout-tail.tsx`,
 * `Grep data-scout-skin`, or a bare command for shell tools. The tool name is
 * dropped for shell execs (the command speaks for itself).
 */
export function formatToolCall(rawName: string, rawInput: unknown): string {
  const name = (rawName || "tool").trim();
  const input = parseMaybeJson(rawInput);
  const obj = asRecord(input);

  if (name === "exec" || name === "functions.exec") {
    const code = typeof input === "string" ? input : obj ? firstString(obj, ["code", "input"]) : null;
    const summary = code ? codeModeSummary(code) : null;
    if (summary) return summary;
  }
  if (name.toLowerCase() === "bash" && obj) {
    const description = firstString(obj, ["description"]);
    if (description) return oneLine(description);
  }

  if (!obj) {
    if (typeof input === "string" && input.trim()) {
      return isShellTool(name) ? oneLine(input) : `${name} ${oneLine(input)}`;
    }
    return name;
  }

  // Shell / exec tools → just the command, like a shell history line.
  if (isShellTool(name)) {
    const cmd = commandString(obj);
    if (cmd) return oneLine(cmd);
  }

  const detail =
    commandString(obj) && isShellTool(name)
      ? commandString(obj)!
      : (() => {
          // Search tools carry both a pattern and an (incidental) path — the
          // pattern is the salient bit, so it wins over the file key.
          const pattern = firstString(obj, PATTERN_KEYS);
          if (pattern) return pattern;
          const file = firstString(obj, FILE_KEYS);
          if (file) return shortPath(file);
          const cmd = commandString(obj);
          if (cmd) return cmd;
          const text = firstString(obj, TEXT_KEYS);
          if (text) return text;
          // Last resort: first scalar value, so it's never an empty `Tool`.
          for (const value of Object.values(obj)) {
            if (typeof value === "string" && value.trim()) return value;
            if (typeof value === "number") return String(value);
          }
          return "";
        })();

  return detail ? `${name} ${oneLine(detail)}` : name;
}

/** Pull plain text out of a tool-result content payload (string or blocks). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const rec = asRecord(content);
  if (rec) {
    const direct = firstString(rec, ["output", "content", "text", "stdout", "result"]);
    if (direct) return direct;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else {
        const b = asRecord(block);
        if (b && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function stripCodexExecEnvelope(text: string): string {
  const lines = text.split("\n");
  const outputIndex = lines.findIndex((line, index) => (
    index <= 8 && line.trim() === "Output:"
  ));
  if (outputIndex < 0) return text;

  const prelude = lines.slice(0, outputIndex).map((line) => line.trim().toLowerCase());
  const looksLikeCodexExec =
    prelude.some((line) => line.startsWith("chunk id:"))
    || prelude.some((line) => line.startsWith("wall time:"))
    || prelude.some((line) => line.startsWith("process exited with code"))
    || prelude.some((line) => line.startsWith("original token count:"));

  return looksLikeCodexExec ? lines.slice(outputIndex + 1).join("\n") : text;
}

function previewLines(lines: string[]): string {
  const first = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  return oneLine(first.join(" "), 100);
}

/**
 * Compact descriptor for a tool result. Multi-line output gets a short content
 * preview plus scale; short output shows verbatim.
 */
export function summarizeToolResult(content: unknown): string {
  const text = stripCodexExecEnvelope(resultText(content).replace(/\r/g, ""));
  const trimmed = text.trim();
  if (!trimmed) return "done";
  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > 1) return `${previewLines(lines)} (${lines.length} lines)`;
  return oneLine(trimmed, 100);
}

export function formatToolResult(content: unknown, callSummary?: string | null): string {
  const result = summarizeToolResult(content);
  const call = callSummary?.trim();
  return call ? `${oneLine(call, 90)} -> res: ${result}` : `res: ${result}`;
}
