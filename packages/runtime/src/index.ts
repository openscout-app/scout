export * from "./registry.js";
export * from "./harness-catalog.js";
export * from "./planner.js";
export * from "./schema.js";
export * from "./assigned-roles-store.js";
export * from "./role-lifecycle.js";
export * from "./service.js";
export * from "./broker.js";
export * from "./mesh-bridge-supervisor.js";
export * from "./sqlite-store.js";
export * from "./mesh-discovery.js";
export * from "./mesh-forwarding.js";
export * from "./mesh-peer-client.js";
export * from "./mesh-approvals.js";
export * from "./mesh-rendezvous.js";
export * from "./node-identity.js";
export * from "./node-tls-identity.js";
export * from "./mesh-bind-controller.js";
export * from "./mesh-sas.js";
export * from "./mesh-trust-enrollment.js";
export * from "./mesh-ssh-enroll.js";
export * from "./iroh-bridge.js";
export * from "./tailscale.js";
export * from "./system-probes/index.js";
export * from "./broker-process-manager.js";
export * from "./broker-api.js";
export * from "./broker-core-service.js";
export * from "./broker-runtime-catalog-service.js";
export * from "./broker-rendezvous-service.js";
export * from "./local-agents.js";
export * from "./control-plane-agents.js";
export * from "./provisional-agent-names.js";
export * from "./scout-broker.js";
export * from "./codex-app-server.js";
export * from "./pi-rpc.js";
export * from "./coding-agent-host.js";
export * from "./openscout-discovery.js";
export * from "./setup.js";
export * from "./managed-installs.js";
export * from "./claude-statusline.js";
export * from "./claude-session-records.js";
export * from "./session-observation.js";
export * from "./provider-telemetry-bootstrap.js";
export * from "./onboarding.js";
export * from "./runtime-adapters.js";
export * from "./support-paths.js";
export * from "./scout-agent-cards.js";
export * from "./user-config.js";
export * from "./user-config-fields.js";
export * from "./harness-model-preferences.js";
export * from "./runtime-list-preferences.js";
export * from "./local-config.js";
export * from "./open-scout-network.js";
export * from "./thread-events.js";
export * from "./mobile-push.js";
export * from "./permission-policy.js";
export * from "./continuation.js";
export * from "./agent-run-registry.js";
export * from "./observed-status-projection.js";
export * from "./activity-projection.js";
export * from "./activity-transitions.js";
export * from "./presence-map.js";
export * from "./session-display-projection.js";
export * from "./issue-runner.js";
export * from "./issue-runner-service.js";
export * from "./session-attention.js";
export * from "./conversations/index.js";
export * from "./knowledge/index.js";
export * from "./repo-watch/index.js";
export * from "./repo-diff/index.js";

// Canonical broker HTTP paths live in @openscout/protocol; re-exported here so
// runtime-only consumers (e.g. the CLI) can reach them without a new dependency.
export {
  SCOUT_LAUNCHABLE_HARNESSES,
  SCOUT_RUNTIME_CATALOG,
  SCOUT_RUNTIME_DEFAULTS_BY_HARNESS,
  SCOUT_RUNTIME_EFFORT_CATALOG,
  SCOUT_RUNTIME_MODEL_CATALOG,
  type ScoutRuntimeCapabilityCatalog,
  type ScoutOwnedRuntimeCatalog,
  isScoutRuntimeHarnessEnabled,
  parseScoutRuntimeCatalog,
  scoutRuntimeDefaultHarness,
  scoutRuntimeDefaultModel,
  scoutRuntimeDefaultReasoningEffort,
  scoutRuntimeDefaultsByHarness,
  scoutRuntimeEffortCatalog,
  scoutRuntimeModelCatalog,
  scoutBrokerPaths,
  scoutBrokerMessagesListPath,
  scoutBrokerMessagesPath,
  scoutBrokerInvocationPath,
  scoutBrokerInvocationStreamPath,
  scoutBrokerInvocationLifecyclePath,
} from "@openscout/protocol";
export * from "./runtime-session-address.js";
export * from "./t3/rpc-client.js";
export * from "./t3/adapter.js";
export * from "./t3/broker-service.js";
export { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";
