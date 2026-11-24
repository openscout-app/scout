// Compatibility wrapper: phone HTTP policy remains private; room transport is public.
import { startRelay as startTransport, type RelayTransportOptions } from "@openscout/runtime/mesh";
import { createPairRelayHttpHandler } from "./pair-http-proxy.ts";

export interface RelayOptions {
  tls?: RelayTransportOptions["tls"];
  /** Undefined retains the private web-port default; empty/null disables it. */
  pairHttpOrigin?: string | null;
}

export function startRelay(port: number, options: RelayOptions = {}): { stop: () => void } {
  return startTransport(port, {
    tls: options.tls,
    httpHandler: createPairRelayHttpHandler(options.pairHttpOrigin),
  });
}
