import type { ScoutExtension } from "@openscout/runtime/extensions";
import { ScoutCommandUnavailableError } from "./command-unavailable.ts";
import type { ScoutExtensionContext } from "./extension-context.ts";
import { inputRefusal, scoutExtensionInputBinding, type ExtensionInputSelection } from "./extension-input-grants.ts";

export const EXTENSION_INPUT_REQUEST_SCHEMA = "scout.extension-input-request/v1";
export const EXTENSION_INPUT_RESPONSE_SCHEMA = "scout.extension-inputs/v1";
export const EXTENSION_INPUT_LIMITS = Object.freeze({ request: 4096, response: 16384, value: 8192, milliseconds: 5000 });
export type ExtensionInputMetadata = { id: "distribution-key"; present: boolean; treeDigest: string; declarationDigest: string; destination: { origin: string; basePath: string } };
export type ExtensionInputResponse = { schema: typeof EXTENSION_INPUT_RESPONSE_SCHEMA; id: "distribution-key"; treeDigest: string; declarationDigest: string;
  destination: { origin: string; basePath: string }; status: "absent" | "provided" | "refused"; value?: string; reason?: string };

/** Metadata-only preparation. No input transport is qualified; requests always refuse. */
export function prepareScoutExtensionInputSession(extension: ScoutExtension, frame: ScoutExtensionContext, selectionEnv: NodeJS.ProcessEnv) {
  if (!extension.invocation?.credentialInputs?.length) return undefined;
  const selection: ExtensionInputSelection = { uid: frame.selection.uid, home: frame.selection.home, instance: frame.selection.instance,
    instanceRoot: frame.selection.instanceRoot, scoutHome: frame.paths.scoutHome, endpoint: frame.configuration["distribution.endpoint/v1"]?.endpoint?.value ?? undefined };
  const binding = scoutExtensionInputBinding(extension, selectionEnv, selection);
  if (binding.treeDigest !== frame.extensions.treeDigest || binding.extensionRoot.path !== frame.extensions.selectedRoot) inputRefusal(extension.name, "selection_changed");
  const present = typeof selectionEnv.SCOUT_DIST_KEY === "string" && selectionEnv.SCOUT_DIST_KEY.trim().length > 0;
  const metadata: ExtensionInputMetadata = { id: "distribution-key", present, treeDigest: binding.treeDigest, declarationDigest: binding.declarationDigest, destination: { ...binding.destination } };
  const response = (status: ExtensionInputResponse["status"]): ExtensionInputResponse => ({ schema: EXTENSION_INPUT_RESPONSE_SCHEMA, id: metadata.id, treeDigest: metadata.treeDigest, declarationDigest: metadata.declarationDigest, destination: { ...metadata.destination }, status });
  return {
    metadata,
    request(_value: unknown): ExtensionInputResponse {
      // No live channel and no qualified backend: even an exact grant cannot release a value.
      // Request-time policy evaluation/delivery belongs to the separately reviewed transport slice.
      inputRefusal(extension.name, "input_backend_unproven");
    },
    refusal(error: ScoutCommandUnavailableError): ExtensionInputResponse { return { ...response("refused"), reason: error.reason }; },
  };
}
export type ScoutExtensionInputSession = NonNullable<ReturnType<typeof prepareScoutExtensionInputSession>>;
export function encodeScoutExtensionInputResponse(response: ExtensionInputResponse, command = "extensions"): Buffer {
  if (response.status !== "provided" && Object.hasOwn(response, "value")) inputRefusal(command, "input_protocol_invalid");
  const wire = Buffer.from(JSON.stringify(response) + "\n");
  if (wire.length > EXTENSION_INPUT_LIMITS.response) inputRefusal(command, "input_value_invalid");
  return wire;
}
