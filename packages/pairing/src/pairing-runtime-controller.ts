// Must stay the first import. Run straight from a checkout, the pairing
// controller defaults to OPENSCOUT_INSTANCE=dev (or dev-<worktree>), so it
// never takes prod's pairing keys or ports 43130-43132.
import "@openscout/runtime/instance-checkout-bootstrap";
import { enforceOpenScoutInstanceIsolation } from "@openscout/runtime/instance";
import { adoptBrokerAttributionKey } from "@openscout/runtime/broker-api";
import { runPairingRuntimeController } from "./core/pairing/pairing-runtime-controller.ts";

enforceOpenScoutInstanceIsolation("the pairing controller");
// Paired devices answer as the operator. Read the key before anything spawns,
// so sessions started from a phone never inherit it.
try {
  adoptBrokerAttributionKey();
} catch (error) {
  console.warn(`[pairing] operator attribution off: ${error instanceof Error ? error.message : String(error)}`);
}
await runPairingRuntimeController();
