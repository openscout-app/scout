import { expect, test } from "bun:test";
import manifest from "../package.json";

const prefix = "@openscout/runtime/";
const instanceEnvironment = () => [
  process.env.OPENSCOUT_INSTANCE,
  process.env.OPENSCOUT_HOME,
  process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  process.env.OPENSCOUT_CONTROL_HOME,
];
const legacySources = {
  client: [
    "broker-api", "delivery-client", "web-full-client", "broker-trpc-router",
    "mcp-events", "mcp-event-webhook", "remote-tail",
  ],
  daemon: [
    "broker-process-manager", "local-edge", "host-attention", "pairing-supervisor",
    "pairing-local-socket", "inherited-descriptors", "broker-core-service", "repo-watch",
  ],
  config: [
    "support-paths", "scout-home", "local-config", "user-config", "user-config-fields",
    "instance", "path-trust",
  ],
  setup: ["./setup.js", "onboarding", "diagnostic-report", "core-report", "system-probes"],
  harnesses: [
    "harness-catalog", "harness-topology", "harness-model-preferences", "local-agents",
    "local-agent-harnesses", "control-plane-agents", "scoutbot-role", "agent-workspace", "agent-workspace-retirement",
    "live-terminal-session", "terminal-environment", "in-place", "tail", "pi-rpc",
    "claude-stream-json", "claude-statusline", "tool-resolution", "broker-runtime-profiles",
    "runtime-list-preferences",
  ],
  mesh: [
    "mesh-dial-order", "mesh-node-state", "mesh-peer-filter", "mesh-join", "mesh/tailscale",
    "mesh/iroh-bridge", "mesh-bridge-config", "mesh/node-identity", "mesh/access",
    "mesh/peer-auth", "mesh/local-auth", "mesh/client-wire", "open-scout-network", "relay-transport",
  ],
  "pairing-security": [
    "pairing-security/noise", "pairing-security/identity", "pairing-security/transport",
    "pairing-security/trust-owner",
  ],
  routing: [
    "registry", "./routing/index.js", "provisional-agent-names", "scout-bridge-command",
    "dist-access", "conversations", "conversations/legacy-ids",
  ],
  storage: ["schema", "sqlite-adapter", "drizzle", "attachments"],
  extensions: ["scout-extensions", "extension-channel-host", "shared-mcp"],
};

for (const [facade, sources] of Object.entries(legacySources)) {
  test(`${facade} exposes exactly its legacy runtime bindings`, async () => {
    const instanceBeforeImport = instanceEnvironment();
    const actual = await import(prefix + facade);
    expect(instanceEnvironment()).toEqual(instanceBeforeImport);
    const expected = new Map<string, unknown>();

    for (const source of sources) {
      // Setup and routing now resolve to their facades. Read their old entrypoints directly.
      const original = await import(source.startsWith("./") ? source : prefix + source);
      for (const [name, value] of Object.entries(original)) {
        const publicName = source === "drizzle" && name === "briefingsTable" ? "drizzleBriefingsTable" : name;
        // Identical re-exports are OK; distinct bindings must have distinct names.
        if (expected.has(publicName)) {
          expect(value, `${source} conflicts on ${publicName}`).toBe(expected.get(publicName));
        }
        expected.set(publicName, value);
      }
    }

    expect(Object.keys(actual).sort()).toEqual([...expected.keys()].sort());
    for (const [name, value] of expected) {
      expect(actual[name], name).toBe(value);
    }
  });
}

test("prunes unused package subpaths and keeps manifest lookup available", () => {
  for (const name of [
    "local-agent-template", "solo-pro", "instance-bootstrap", "memory-snapshot",
    "runtime-adapters", "codex-app-server", "scout-agent-cards", "lan-network",
  ]) {
    expect(Object.hasOwn(manifest.exports, `./${name}`), name).toBe(false);
  }
  expect(manifest.exports["./package.json"]).toBe("./package.json");
});
