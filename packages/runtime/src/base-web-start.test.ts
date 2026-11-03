import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { resolveLegacyWebEntry } from "./legacy-app-services.js";

// Exercise the actual base wiring without booting any service or app.
const source = readFileSync(new URL("./base-daemon.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("base-daemon.ts", source, ts.ScriptTarget.Latest, true);
const declaration = tree.statements.find(s => ts.isFunctionDeclaration(s)
  && s.name?.text === "startWebWhenBrokerIsReady")!;
function harness(env: Record<string, string>) {
  const warnings: unknown[][] = [];
  let retries = 0, starts = 0;
  const body = ts.transpileModule(`
    let webStartInFlight = false, shuttingDown = false;
    ${declaration.getText(tree).replaceAll("import.meta.url", JSON.stringify(import.meta.url))}
    return { start: startWebWhenBrokerIsReady, inFlight: () => webStartInFlight };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const wiring = new Function("process", "resolveLegacyWebEntry", "dirname", "fileURLToPath",
    "scheduleWebStartRetry", "warn", "waitForBrokerHealth", "readTailscaleSelfWebHosts",
    "resolveEdgeConfig", "forwardedProtoForEdgeScheme", "fetch", "brokerControlUrl", "log", body)(
    { env }, resolveLegacyWebEntry, dirname, fileURLToPath, () => { retries++; },
    (...args: unknown[]) => warnings.push(args), async () => true, async () => [],
    () => ({ scheme: "http" }), () => "http", async () => {
      starts++; return { ok: true, json: async () => ({ ok: true }) };
    }, "http://127.0.0.1:24400", () => {},
  );
  return { ...wiring, warnings, retries: () => retries, starts: () => starts };
}

for (const failure of ["missing", "relative", "world-writable", "invalid-registry"])
  test(`base catches ${failure} web entry, retries and releases single flight`, async () => {
    const root = mkdtempSync(join(tmpdir(), "base-web-test-"));
    try {
      const entry = join(root, "web.mjs");
      writeFileSync(entry, "// fixture");
      const env: Record<string, string> = { OPENSCOUT_INSTANCE: "dev", OPENSCOUT_SUPPORT_DIRECTORY: root };
      if (failure === "invalid-registry") writeFileSync(join(root, "legacy-app-services.json"), "{");
      else env.OPENSCOUT_WEB_SERVER_ENTRY = failure === "relative" ? "relative.mjs"
        : failure === "missing" ? join(root, "missing.mjs") : entry;
      if (failure === "world-writable") chmodSync(entry, 0o666);
      const h = harness(env);
      await expect(h.start()).resolves.toBeUndefined();
      expect(h.inFlight()).toBe(false);
      expect(h.warnings.length).toBe(1);
      expect(h.retries()).toBe(1);
      expect(h.starts()).toBe(0);
      chmodSync(entry, 0o600);
      env.OPENSCOUT_WEB_SERVER_ENTRY = entry;
      await h.start();
      expect(h.starts()).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("base retries absent web entry and discovers a registry written later", async () => {
  const root = mkdtempSync(join(tmpdir(), "base-web-test-"));
  try {
    const h = harness({ OPENSCOUT_INSTANCE: "dev", OPENSCOUT_SUPPORT_DIRECTORY: root });
    await h.start();
    expect(h.retries()).toBe(1);
    expect(h.starts()).toBe(0);
    const entry = join(root, "web.mjs");
    writeFileSync(entry, "// fixture");
    writeFileSync(join(root, "legacy-app-services.json"), JSON.stringify({ version: 1, web: { entry } }));
    await h.start();
    expect(h.starts()).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
