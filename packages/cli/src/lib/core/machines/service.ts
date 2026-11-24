// CLI-side machine roster loader (docs/eng/sco-104-machines.md).
//
// Every function here is a thin call to the broker. The scan itself — mDNS
// browse, ARP read, tailnet status — runs in the broker and nowhere else, so
// `scout machines` on four terminals is still one pass and one answer.

import { requestScoutBrokerJson } from "@openscout/runtime/client";
import {
  scoutBrokerMachinePath,
  scoutBrokerPaths,
  type MachineRecord,
} from "@openscout/protocol";

import { resolveScoutBrokerUrl } from "../broker/service.ts";

export type MachineSourceStatus = {
  tailscale: { available: boolean; running: boolean; backendState: string | null; peerCount: number };
  lan: { scannedAt: number | null; mdnsEnabled: boolean; serviceCount: number; neighborCount: number };
};

export type MachineInventoryReport = {
  machines: MachineRecord[];
  generatedAt: number;
  sources: MachineSourceStatus;
};

/** A scan holds a multicast socket open for a couple of seconds; be patient. */
const SCAN_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 15_000;

export type MachinesReport = MachineInventoryReport & { brokerUrl: string };

export async function loadMachines(options: { refresh?: boolean } = {}): Promise<MachinesReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const path = options.refresh
    ? `${scoutBrokerPaths.v1.machines}?refresh=1`
    : scoutBrokerPaths.v1.machines;
  const report = await requestScoutBrokerJson<MachineInventoryReport>(brokerUrl, path, {
    signal: AbortSignal.timeout(options.refresh ? SCAN_TIMEOUT_MS : READ_TIMEOUT_MS),
  });
  return { ...report, brokerUrl };
}

export async function runMachineScan(): Promise<MachinesReport> {
  const brokerUrl = resolveScoutBrokerUrl();
  const report = await requestScoutBrokerJson<MachineInventoryReport>(
    brokerUrl,
    scoutBrokerPaths.v1.machinesScan,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: {},
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    },
  );
  return { ...report, brokerUrl };
}

export async function loadMachine(reference: string): Promise<MachineRecord> {
  const brokerUrl = resolveScoutBrokerUrl();
  return requestScoutBrokerJson<MachineRecord>(brokerUrl, scoutBrokerMachinePath(reference), {
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

export async function annotateMachine(
  reference: string,
  input: { displayName?: string | null; notes?: string | null; pinned?: boolean },
): Promise<MachineRecord> {
  const brokerUrl = resolveScoutBrokerUrl();
  return requestScoutBrokerJson<MachineRecord>(brokerUrl, scoutBrokerMachinePath(reference), {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: input,
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}

export async function forgetMachine(reference: string): Promise<{ forgotten: boolean }> {
  const brokerUrl = resolveScoutBrokerUrl();
  return requestScoutBrokerJson<{ forgotten: boolean }>(brokerUrl, scoutBrokerMachinePath(reference), {
    method: "DELETE",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
}
