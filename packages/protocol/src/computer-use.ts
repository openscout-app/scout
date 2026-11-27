/**
 * Scout Computer native desktop protocol contracts: status, windows, screenshots,
 * focus, Accessibility UI inspection, and direct GUI actions.
 */

export type ComputerActKind =
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "drag"
  | "ax_press"
  | "ax_set"
  | "ocr";

export type ComputerStatus = {
  source?: "scout-computer";
  available: boolean;
  binaryPath: string | null;
  agentUrl: string;
  agentConnected: boolean;
  driveState?: string;
  activeLeaseId?: string | null;
  permissions?: {
    accessibility?: string;
    screenRecording?: string;
    notes?: string[];
  };
  reason?: string;
};

export type ComputerReceipt = {
  source?: "scout-computer";
  ok: boolean;
  action: string;
  leaseId?: string;
  outputPath?: string;
  data?: unknown;
  error?: string;
  at: number;
};
