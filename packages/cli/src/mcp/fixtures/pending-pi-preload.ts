// Test-owned adapter only. Its fake process has no provider or credentials.
// Extend the adapter wait so a two-hour soak does not become a five-minute
// executor-timeout test. MCP wait budgets and polling stay unchanged.
import { mock } from "bun:test";
import * as pi from "@openscout/runtime/harnesses";
const invoke = pi.invokePiRpcAgent;
mock.module("@openscout/runtime/harnesses", () => ({
  ...pi,
  invokePiRpcAgent: (options: Parameters<typeof invoke>[0]) =>
    invoke({ ...options, timeoutMs: 3 * 60 * 60 * 1000 }),
}));
