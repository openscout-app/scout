import { execSystemFile } from "../system-probes/exec.js";

export type LatticesCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export const callLattices: LatticesCall = async (method, params) => {
  const { stdout } = await execSystemFile("lattices", ["call", method, JSON.stringify(params)], { timeoutMs: method === "daemon.status" ? 3_000 : 18_000, maxStdoutBytes: 512 * 1024 });
  return JSON.parse(stdout);
};

/** A daemon status call is read-only and does not start Lattices. */
export async function latticesReachable(
  call: (method: "daemon.status", params: Record<string, never>) => Promise<unknown> = callLattices,
): Promise<boolean> {
  const status = await call("daemon.status", {}).catch(() => null) as { ok?: boolean; error?: unknown } | null;
  return status !== null && typeof status === "object" && status.ok !== false && !status.error;
}

type Snapshot = { ok?: boolean; snapshotId?: string; target?: { wid?: number }; warnings?: unknown[]; elements?: Array<{ id?: string; role?: string; value?: string; enabled?: boolean; focused?: boolean }> };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function composerValues(text: string): ReadonlySet<string> {
  // Lattices reports the first 237 Swift Characters and an ellipsis for
  // values longer than 240. Count graphemes rather than slicing UTF-16.
  let length = 0;
  let prefixEnd = 0;
  for (const { index } of graphemes.segment(text)) {
    if (++length === 238) prefixEnd = index;
    if (length > 240) return new Set([text, text.slice(0, prefixEnd) + "..."]);
  }
  // A literal 240-character value ending in "..." can impersonate a
  // summary. Without a truncation flag we cannot distinguish it.
  if (length === 240 && text.endsWith("...")) throw new Error("Lattices composer value may be truncated; use draft mode and send manually.");
  return new Set([text]);
}

function composer(snapshot: Snapshot, values: ReadonlySet<string>) {
  if (!snapshot.ok || !snapshot.snapshotId || !snapshot.target?.wid || snapshot.warnings?.length) throw new Error("Lattices could not inspect a complete composer; use draft mode and send manually.");
  const matches = snapshot.elements?.filter(element => (element.role === "AXTextArea" || element.role === "AXTextField")
    && element.enabled !== false && element.value !== undefined && values.has(element.value)) ?? [];
  if (matches.length !== 1 || !matches[0]?.id) throw new Error("Lattices needs exactly one composer matching the reply; use draft mode and send manually.");
  return matches[0];
}

/** Never selects a Send label or a coordinate. Re-checks content and focus before Return. */
export async function submitLatticesComposer(text: string, beforeSubmit: () => Promise<void>, call: LatticesCall = callLattices): Promise<void> {
  const params = { app: "com.openai.codex", mode: "ax", capture: false, maxDepth: 14, maxElements: 1000 };
  const first = await call("computer.windowState", params) as Snapshot;
  const values = composerValues(text);
  const target = composer(first, values);
  const focused = await call("computer.elementAction", { snapshotId: first.snapshotId, elementId: target.id, action: "focus", treatment: "execute", capture: false }) as { ok?: boolean };
  if (!focused?.ok) throw new Error("Lattices could not focus the exact composer; use draft mode.");
  const second = await call("computer.windowState", { ...params, wid: first.target!.wid }) as Snapshot;
  if (composer(second, values).focused !== true || second.target?.wid !== first.target?.wid) throw new Error("The composer changed or lost focus; use draft mode.");
  await beforeSubmit();
  const sent = await call("computer.pressKey", { wid: second.target!.wid, key: "return", treatment: "execute", capture: false }) as { ok?: boolean };
  if (!sent?.ok) throw new Error("Lattices did not confirm the Return action; check the transcript before retrying.");
}
