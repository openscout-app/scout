import type { ScoutDeliveryReceipt } from "./scout-delivery.js";

export interface ScoutPlayInput {
  name: string;
  label: string;
  required: boolean;
  default: string | null;
}

export interface ScoutPlaySummary {
  name: string;
  description: string;
  inputs: ScoutPlayInput[];
}

export interface ScoutPlayTarget { project?: string; harness?: string; host?: string }

export interface ScoutPlayRunRequest {
  name: string;
  inputs?: Record<string, string>;
  target?: ScoutPlayTarget;
  currentDirectory?: string;
  requestId?: string;
  senderId?: string;
  replyToSessionId?: string;
  replyToSessionHarness?: string;
  source?: string;
}

export interface ScoutPlayRunResult {
  receipt: ScoutDeliveryReceipt & { invocationId?: string; workId?: string; workPageUnavailable?: true };
  followUrl: string;
}
