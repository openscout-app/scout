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
  available: boolean;
  binaryPath: string | null;
  agentUrl: string;
  agentConnected: boolean;
  permissions?: {
    accessibility?: string;
    screenRecording?: string;
    notes?: string[];
  };
  reason?: string;
};

export type ComputerReceipt = {
  ok: boolean;
  action: string;
  outputPath?: string;
  data?: unknown;
  error?: string;
  at: number;
};
