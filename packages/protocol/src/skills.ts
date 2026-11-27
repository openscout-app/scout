import type { ScoutDeliveryReceipt } from "./scout-delivery.js";

/** Metadata only. The path is relative to the target host's home (`~/...`). */
export interface ScoutSkillSummary {
  name: string;
  description: string;
  path: string;
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
