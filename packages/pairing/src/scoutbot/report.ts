import { submitDiagnosticReport, formatDiagnosticReceipt } from "@openscout/runtime/setup";

/** Only an explicit leading command may export diagnostics. Quoted commands in
 * ordinary chat must never trigger an upload. No model is involved. */
export async function handleDiagnosticCommand(prompt: string, submit = submitDiagnosticReport): Promise<string> {
  const match = prompt.trim().match(/^\/(report|feedback)(?:\s+([\s\S]*))?$/i);
  if (!match) return "Use /report [note] to send diagnostics, or /feedback <note> to send a note.";
  const tokens = (match[2] ?? "").split(/\s+/).filter(Boolean);
  const unknown = tokens.find((token) => token.startsWith("--") && !["--local-only", "--diagnostics"].includes(token));
  if (unknown) return `Unknown report option: ${unknown}`;
  const message = tokens.filter((token) => !["--local-only", "--diagnostics"].includes(token)).join(" ");
  if (match[1].toLowerCase() === "feedback" && !message) return "Use /feedback <note>. Add --diagnostics to include service traces.";
  try {
    return formatDiagnosticReceipt(await submit({ message, diagnostics: match[1].toLowerCase() === "report" || tokens.includes("--diagnostics"), localOnly: tokens.includes("--local-only"), client: "scoutbot" }));
  } catch {
    return "Could not save the report. Check the host’s disk space and report-directory permissions, then retry with scout report --local-only.";
  }
}
