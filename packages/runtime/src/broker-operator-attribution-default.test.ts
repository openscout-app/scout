import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptBrokerAttributionKey, forgetAdoptedBrokerAttributionKey, requestScoutBrokerJson } from "./broker-api.js";
import {
  defaultOperatorAttributionKeyFile,
  ensureOperatorAttributionKey,
  OPERATOR_ATTRIBUTION_HANDOFF_ENV,
  resolveOperatorAttributionKeyFile,
} from "./mesh-access-local-auth.js";
import { createBrokerDaemonTestHarness } from "./test-helpers/broker-daemon-harness.test";

const broker = createBrokerDaemonTestHarness();
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-operator-attribution-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  forgetAdoptedBrokerAttributionKey();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("setup creates the operator key once, owner-only, and resolution prefers an explicit file", () => {
  const support = tempDirectory();
  expect(resolveOperatorAttributionKeyFile({}, support)).toBeUndefined();

  const first = ensureOperatorAttributionKey(support);
  expect(first).toEqual({ file: defaultOperatorAttributionKeyFile(support), created: true });
  expect(statSync(first.file).mode & 0o777).toBe(0o600);
  const key = readFileSync(first.file, "utf8");
  expect(key.trim()).toMatch(/^[a-f0-9]{64}$/);

  expect(ensureOperatorAttributionKey(support)).toEqual({ file: first.file, created: false });
  expect(readFileSync(first.file, "utf8")).toBe(key);

  expect(resolveOperatorAttributionKeyFile({}, support)).toEqual({ file: first.file, explicit: false });
  expect(resolveOperatorAttributionKeyFile({ OPENSCOUT_ATTRIBUTION_KEY_FILE: "/elsewhere/key" }, support))
    .toEqual({ file: "/elsewhere/key", explicit: true });
});

test("adopting the key drops the variable so spawned children cannot inherit it", () => {
  const support = tempDirectory();
  const { file } = ensureOperatorAttributionKey(support);
  const env: Record<string, string | undefined> = { OPENSCOUT_ATTRIBUTION_KEY_FILE: file, KEEP: "1" };
  expect(adoptBrokerAttributionKey(env)).toBe(true);
  expect(env).toEqual({ KEEP: "1" });
  expect(adoptBrokerAttributionKey({})).toBe(false);

  const handoff: Record<string, string | undefined> = { [OPERATOR_ATTRIBUTION_HANDOFF_ENV]: file };
  expect(adoptBrokerAttributionKey(handoff)).toBe(true);
  expect(handoff).toEqual({});
});

test("setup reports an existing key the runtime would refuse", () => {
  const support = tempDirectory();
  const { file } = ensureOperatorAttributionKey(support);
  chmodSync(file, 0o644);
  expect(ensureOperatorAttributionKey(support)).toMatchObject({ file, created: false, problem: expect.stringContaining("owner-only") });
});

test("a runtime with only the setup key accepts Ready decisions from a surface that adopted it", async () => {
  const controlHome = tempDirectory();
  const { file } = ensureOperatorAttributionKey(join(controlHome, "support"));
  const h = await broker.startBroker({ controlHome, env: { OPENSCOUT_ATTRIBUTION_KEY_FILE: undefined } });
  const body = { ref: "missing", decision: "hold" };
  const acceptAny = (_value: unknown): _value is { error?: string } => true;

  const unsigned = await requestScoutBrokerJson(h.baseUrl, "/v1/tasks/ready/decide", { method: "POST", body, acceptErrorJson: acceptAny });
  expect(unsigned.error).toBe("operator_attribution_required");

  expect(adoptBrokerAttributionKey({ [OPERATOR_ATTRIBUTION_HANDOFF_ENV]: file })).toBe(true);
  const signed = await requestScoutBrokerJson(h.baseUrl, "/v1/tasks/ready/decide", { method: "POST", body, acceptErrorJson: acceptAny });
  // The proof verified, so the route itself answered; a wrong key gets invalid_local_admin_proof.
  expect(signed.error).toMatch(/^unknown task missing/);
}, 20_000);
