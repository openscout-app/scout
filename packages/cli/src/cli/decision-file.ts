import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  DecisionCardError,
  decisionDraftFromInput,
  normalizeDecisionCard,
  validateDecisionCard,
  type AttachmentUpload,
  type DecisionCardSubmission,
} from "@openscout/protocol";

import { readTaskImage } from "./task-image.ts";

/**
 * `--decision <file>[#<decision id>]`: a card in our shape, or one decision
 * from a decision-pack `pack.json`. Picture paths are read here, relative to
 * the file, and sent as images; the card that crosses the wire names each
 * picture by its index, never by its path.
 */
export async function readDecisionFile(spec: string): Promise<{ decision: DecisionCardSubmission; images: AttachmentUpload[] }> {
  const hash = spec.lastIndexOf("#");
  const path = hash > 0 ? spec.slice(0, hash) : spec;
  const select = hash > 0 ? spec.slice(hash + 1).trim() || undefined : undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`--decision: cannot read ${path} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return prepareDecision(parsed, dirname(path), select);
}

/** A card given as a value (MCP `decision`), with picture paths relative to `base`. */
export async function prepareDecision(parsed: unknown, base: string, select?: string): Promise<{ decision: DecisionCardSubmission; images: AttachmentUpload[] }> {
  let draft;
  try {
    draft = normalizeDecisionCard(decisionDraftFromInput(parsed, select));
  } catch (error) {
    if (error instanceof DecisionCardError) throw new Error(`--decision is not valid:\n- ${error.problems.join("\n- ")}`);
    throw error;
  }
  const problems = validateDecisionCard(draft, { origin: "agent", pictures: "path" });
  if (problems.length) throw new Error(`--decision is not valid:\n- ${problems.join("\n- ")}`);
  const images: AttachmentUpload[] = [];
  const options = [];
  for (const option of draft.options) {
    const { picture, ...rest } = option;
    if (!picture) { options.push(rest); continue; }
    const file = isAbsolute(picture.path) ? picture.path : resolve(base, picture.path);
    images.push(await readTaskImage(file));
    options.push({ ...rest, picture: { image: images.length - 1, ...(picture.callouts?.length ? { callouts: picture.callouts } : {}) } });
  }
  return { decision: { ...draft, kind: "decision", options }, images };
}
