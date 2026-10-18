import { execSystemFile } from "../system-probes/exec.js";

export type LatticesCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export const callLattices: LatticesCall = async (method, params) => {
  const { stdout } = await execSystemFile("lattices", ["call", method, JSON.stringify(params)], { timeoutMs: 18_000, maxStdoutBytes: 512 * 1024 });
  return JSON.parse(stdout);
};

type Snapshot = { ok?: boolean; snapshotId?: string; target?: { wid?: number }; warnings?: unknown[]; elements?: Array<{ id?: string; role?: string; value?: string; enabled?: boolean; focused?: boolean }> };
function composer(snapshot: Snapshot, text: string) {
  if (!snapshot.ok || !snapshot.snapshotId || !snapshot.target?.wid || snapshot.warnings?.length) throw new Error("Lattices could not inspect a complete composer; use draft mode or open Scout.app.");
  const matches = snapshot.elements?.filter(element => (element.role === "AXTextArea" || element.role === "AXTextField") && element.enabled !== false && element.value === text) ?? [];
  if (matches.length !== 1 || !matches[0]?.id) throw new Error("Lattices needs exactly one composer containing the exact reply; use draft mode and send manually.");
  return matches[0];
}

/** Never selects a Send label or a coordinate. Re-checks content and focus before Return. */
export async function submitLatticesComposer(text: string, beforeSubmit: () => Promise<void>, call: LatticesCall = callLattices): Promise<void> {
  const params = { app: "com.openai.codex", mode: "ax", capture: false, maxDepth: 14, maxElements: 1000 };
  const first = await call("computer.windowState", params) as Snapshot;
  const target = composer(first, text);
  const focused = await call("computer.elementAction", { snapshotId: first.snapshotId, elementId: target.id, action: "focus", treatment: "execute", capture: false }) as { ok?: boolean };
  if (!focused?.ok) throw new Error("Lattices could not focus the exact composer; use draft mode.");
  const second = await call("computer.windowState", { ...params, wid: first.target!.wid }) as Snapshot;
  if (composer(second, text).focused !== true || second.target?.wid !== first.target?.wid) throw new Error("The composer changed or lost focus; use draft mode.");
  await beforeSubmit();
  const sent = await call("computer.pressKey", { wid: second.target!.wid, key: "return", treatment: "execute", capture: false }) as { ok?: boolean };
  if (!sent?.ok) throw new Error("Lattices did not confirm the Return action; check the transcript before retrying.");
}
