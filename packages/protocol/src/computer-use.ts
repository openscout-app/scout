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

export type ComputerLayerBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComputerLayerWindow = {
  windowId?: number;
  pid?: number;
  bundleId?: string;
  title?: string;
  frame?: ComputerLayerBounds;
  originalFrame?: ComputerLayerBounds;
};

export type ComputerLayerStatus = {
  active: boolean;
  owner?: "caller" | "detached";
  pid?: number;
  subject?: { bundleId?: string; pid?: number };
  layer?: {
    pid: number;
    displayId?: number;
    bounds?: ComputerLayerBounds;
    pip?: boolean;
    paused?: boolean;
    takenOver?: boolean;
    windows?: ComputerLayerWindow[];
  };
  handoff?: Record<string, unknown>;
};

export type ComputerStatus = {
  source?: "scout-computer";
  available: boolean;
  binaryPath: string | null;
  agentUrl: string;
  agentConnected: boolean;
  driveState?: string;
  activeLeaseId?: string | null;
  layer?: ComputerLayerStatus;
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
