import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctorNativeCheck, renderDoctorCheck } from "./doctor-checks.ts";
import {
  loadNativeScoutdDoctorReport,
  nativeScoutdCommandTimeoutMs,
  normalizeNativeScoutdDoctorReport,
  renderNativeScoutdDoctorSection,
  runNativeScoutdJson,
} from "./scoutd.ts";

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: platform });
  const restore = () => {
    if (previous) Object.defineProperty(process, "platform", previous);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

describe("native scoutd doctor helpers", () => {
  test("allows the native restart lifecycle to reach its own stop and start deadlines", () => {
    expect(nativeScoutdCommandTimeoutMs("status")).toBe(20_000);
    expect(nativeScoutdCommandTimeoutMs("restart")).toBe(180_000);
    expect(nativeScoutdCommandTimeoutMs("restart", 1_000)).toBe(1_000);
  });

  test("normalizes current scoutd doctor JSON with warnings and process observations", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      raw: {
        status: {
          label: "com.openscout.scoutd",
          loaded: true,
          pid: 42,
          reachable: false,
          brokerSocketPath: "/Users/you/Library/Application Support/OpenScout/runtime/broker.sock",
          health: {
            ok: false,
            transport: "unix_socket",
            error: "connection refused",
          },
          runtimeFreshness: {
            state: "unverified",
            intentional: false,
            basis: "explicit_pin",
            reasonCode: "pin_mismatch",
            actualBuiltAt: "2026-08-01T12:00:00.000Z",
            expectedBuiltAt: null,
            detail: "Running runtime commit old does not match explicit pin new.",
          },
        },
        warnings: [
          "broker socket exists but health is unreachable",
          "multiple scout-broker processes found: 2",
        ],
        processes: [
          {
            pid: 42,
            ppid: 1,
            pcpu: "0.0",
            pmem: "0.1",
            elapsed: "00:15",
            command: "/opt/openscout/scoutd supervise",
          },
        ],
      },
    });

    expect(report.available).toBe(true);
    expect(report.status?.label).toBe("com.openscout.scoutd");
    expect(report.warnings).toContain("broker socket exists but health is unreachable");
    expect(report.processes[0]?.command).toContain("scoutd supervise");

    const rendered = renderNativeScoutdDoctorSection(report);
    expect(rendered).toContain("Native daemon:");
    expect(rendered).toContain("multiple scout-broker processes found");
    expect(rendered).toContain("Runtime freshness: unverified");
    expect(rendered).toContain("Runtime reason: pin_mismatch");
    expect(rendered).toContain("pid 42 ppid 1");
  });

  test("preserves a connected health timeout without rendering it as ready", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd", source: "package",
      raw: { status: { health: { reachable: true, ok: false, state: "timed_out", checkedAt: 123, durationMs: 1000, transport: "unix_socket" } } },
    });
    expect(report.status).toMatchObject({ reachable: true, healthOk: false, healthState: "timed_out", healthCheckedAt: 123, healthDurationMs: 1000 });
    expect(renderNativeScoutdDoctorSection(report)).toContain("Health: timed_out (1000ms)");
  });

  test("renders unsupported repairs without failing the doctor path", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      fixRequested: true,
      yes: true,
      raw: {
        status: {
          loaded: true,
          reachable: true,
        },
        warnings: [],
        processes: [],
      },
    });

    expect(report.fix.supported).toBe(false);
    expect(renderNativeScoutdDoctorSection(report)).toContain("Repair: not supported by this scoutd build");
  });

  test("renders future repair action reports generically", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      fixRequested: true,
      raw: {
        version: "0.2.75",
        fixes: [
          {
            id: "stale-socket",
            title: "Remove stale broker socket",
            status: "applied",
            detail: "Removed socket after broker health stayed unreachable.",
          },
        ],
      },
    });

    expect(report.buildIdentity).toBe("0.2.75");
    expect(report.fix.supported).toBe(true);
    expect(report.fix.entries[0]?.id).toBe("stale-socket");
    const rendered = renderNativeScoutdDoctorSection(report);
    expect(rendered).toContain("Build: 0.2.75");
    expect(rendered).toContain("Remove stale broker socket [applied]");
  });

  test("does not spawn scoutd on linux and doctor reports the supervisor as not applicable", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-scoutd-linux-doctor-"));
    const marker = join(root, "spawned");
    const scoutd = join(root, "scoutd");
    writeFileSync(scoutd, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(scoutd, 0o755);
    try {
      await withPlatform("linux", async () => {
        const outcome = await runNativeScoutdJson("doctor", {
          env: { ...process.env, OPENSCOUT_SCOUTD_BIN: scoutd },
        });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.reason).toBe("not-applicable");
          expect(outcome.error).toBe("native supervisor: not applicable on linux");
        }
        const report = await loadNativeScoutdDoctorReport({
          env: { ...process.env, OPENSCOUT_SCOUTD_BIN: scoutd },
        });
        expect(report.notApplicableDetail).toBe("native supervisor: not applicable on linux");
        expect(report.error).toBeNull();
        const check = doctorNativeCheck(report);
        expect(check.state).toBe("working");
        expect(renderDoctorCheck(check)).toBe("OK native: native supervisor: not applicable on linux");
        expect(renderNativeScoutdDoctorSection(report)).toBe("\nnative supervisor: not applicable on linux");
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
