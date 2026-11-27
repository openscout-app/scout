import type { ScoutDeliveryReceipt } from "./scout-delivery.js";

/** Use names that can be referenced as a single visible folder. */
export function isSkillFolderName(name: string): boolean {
  return Boolean(name.trim()) && !/^[.-]|[/\\\x00-\x1f\x7f]/.test(name) && name.length <= 255;
}

/** Metadata only. The path is relative to the target host's home (`~/...`). */
export interface ScoutSkillSummary {
  name: string;
  description: string;
  path: string;
  /** The personal copy wins; without one, equal names require a path. */
  status: "active" | "shadowed" | "ambiguous";
}

export interface ScoutSkillTarget { project?: string; harness?: string; host?: string }

export interface ScoutSkillRunRequest {
  /** A skill name, or an exact path returned by the target host's listing. */
  name: string;
  brief: string;
  target?: ScoutSkillTarget;
  currentDirectory?: string;
  requestId?: string;
  senderId?: string;
  replyToSessionId?: string;
  replyToSessionHarness?: string;
  source?: string;
}

export interface ScoutSkillRunResult {
  receipt: ScoutDeliveryReceipt & { invocationId?: string; workId?: string; workPageUnavailable?: true };
  followUrl: string;
}
