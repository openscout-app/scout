import type { ScoutDeliveryReceipt } from "./scout-delivery.js";

/** Use names that can be referenced as a single visible folder. */
export function isSkillFolderName(name: string): boolean {
  return name.length > 0 && name === name.trim() && !/^[.-]|[/\\\x00-\x1f\x7f]/.test(name) && name.length <= 255;
}

/** Metadata on the target host. Never contains the instructions. */
export interface ScoutSkillSummary {
  /** The registration name, or the folder name in an explicit discovery result. */
  name: string;
  description: string;
  /** Real absolute path to the instruction file. */
  path: string;
  /** Real absolute skill folder for scripts and assets. */
  directory: string;
  source: "personal" | "linked" | "unregistered";
}

export interface ScoutSkillTarget { project?: string; harness?: string; host?: string }

export interface ScoutSkillRunRequest {
  /** A registered Scout skill name on the target host. */
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
