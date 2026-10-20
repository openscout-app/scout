import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildSignedNodeCard,
  loadOrCreateNodeIdentity,
  type SignedNodeCard,
} from "./node-identity.js";
import {
  SshEnrollError,
  buildSshArgv,
  enrollViaSsh,
  grantFromVerifiedCard,
  parseSshEnrollTarget,
  type SshExec,
  type SshExecInput,
  type SshExecResult,
} from "./mesh-ssh-enroll.js";

function freshIdentity() {
  return loadOrCreateNodeIdentity(mkdtempSync(join(tmpdir(), "openscout-ssh-enroll-")));
}

function cardFor(
  identity: ReturnType<typeof freshIdentity>,
  label: string,
  opts: { tls?: boolean; now?: number } = {},
): SignedNodeCard {
  return buildSignedNodeCard(
    identity,
    {
      nodeId: `${label}-node`,
      label,
      version: "0.9.0",
      capabilities: ["observe"],
      endpoints: ["https://192.168.18.10:43110"],
      ...(opts.tls
        ? { tls: { spkiFingerprint: "ab".repeat(32) } }
        : {}),
    },
    opts.now,
  );
}

function captureExec(handler: (input: SshExecInput) => SshExecResult | Promise<SshExecResult>): {
  exec: SshExec;
  calls: SshExecInput[];
} {
  const calls: SshExecInput[] = [];
  return {
    calls,
    exec: async (input) => {
      calls.push({
        argv: [...input.argv],
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
      });
      return handler(input);
    },
  };
}

describe("parseSshEnrollTarget", () => {
  test("parses host, user@host, and port", () => {
    expect(parseSshEnrollTarget("ssh://air")).toEqual({
      destination: "air",
      raw: "ssh://air",
    });
    expect(parseSshEnrollTarget("ssh://art@air")).toEqual({
      destination: "art@air",
      raw: "ssh://art@air",
    });
    expect(parseSshEnrollTarget("ssh://air:2222")).toEqual({
      destination: "air",
      port: 2222,
      raw: "ssh://air:2222",
    });
    expect(parseSshEnrollTarget("ssh://art@air:2222")).toEqual({
      destination: "art@air",
      port: 2222,
      raw: "ssh://art@air:2222",
    });
  });

  test("rejects non-ssh schemes, passwords, and empty hosts", () => {
    expect(() => parseSshEnrollTarget("http://air")).toThrow(SshEnrollError);
    expect(() => parseSshEnrollTarget("air")).toThrow(SshEnrollError);
    expect(() => parseSshEnrollTarget("ssh://")).toThrow(SshEnrollError);
    expect(() => parseSshEnrollTarget("ssh://user:secret@air")).toThrow(/password/);
  });
});

describe("buildSshArgv", () => {
  test("builds an argv array without shell interpolation or StrictHostKeyChecking hacks", () => {
    const target = parseSshEnrollTarget("ssh://art@air:2222");
    const argv = buildSshArgv(target, ["scout", "mesh", "card", "--json"]);
    expect(argv).toEqual([
      "ssh",
      "-p",
      "2222",
      "art@air",
      "scout",
      "mesh",
      "card",
      "--json",
    ]);
    // Every element is a discrete argv token — never a joined shell string.
    expect(argv.every((part) => typeof part === "string")).toBe(true);
    expect(argv.join(" ")).not.toContain("StrictHostKeyChecking");
    expect(argv.some((part) => part.includes("scout mesh"))).toBe(false);
  });
});

describe("grantFromVerifiedCard", () => {
  test("copies tls pin and sets grantedVia=ssh", () => {
    const card = cardFor(freshIdentity(), "air", { tls: true });
    const grant = grantFromVerifiedCard(card, { tier: "control", grantedAt: 42 });
    expect(grant).toMatchObject({
      keyId: card.keyId,
      publicKey: card.publicKey,
      fingerprint: card.fingerprint,
      label: "air",
      tier: "control",
      grantedVia: "ssh",
      grantedAt: 42,
      tlsSpkiFingerprint: "ab".repeat(32),
    });
  });
});

describe("enrollViaSsh mutual exchange", () => {
  test("full mutual exchange: remote install first, then local grant with pin", async () => {
    const localId = freshIdentity();
    const remoteId = freshIdentity();
    const localCard = cardFor(localId, "local", { tls: true });
    const remoteCard = cardFor(remoteId, "air", { tls: true });

    const installedOnRemote: SignedNodeCard[] = [];
    const { exec, calls } = captureExec((input) => {
      const remoteCmd = input.argv.slice(input.argv.indexOf("scout"));
      if (remoteCmd.join(" ") === "scout mesh card --json") {
        return { stdout: JSON.stringify(remoteCard), stderr: "", exitCode: 0 };
      }
      if (remoteCmd.includes("--help")) {
        return { stdout: "scout mesh trust install-grant - [--tier <tier>]", stderr: "", exitCode: 0 };
      }
      if (remoteCmd.join(" ") === "scout mesh trust install-grant - --tier control --json") {
        expect(input.stdin).toBeTruthy();
        const pushed = JSON.parse(input.stdin!) as SignedNodeCard;
        installedOnRemote.push(pushed);
        return {
          stdout: JSON.stringify({ peer: { keyId: pushed.keyId, tier: "control", grantedVia: "ssh" } }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: `unexpected: ${remoteCmd.join(" ")}`, exitCode: 1 };
    });

    const result = await enrollViaSsh({
      target: "ssh://art@air:2222",
      localCard,
      tier: "control",
      exec,
      now: Date.now(),
    });

    // Remote accepted our card before we built the local grant.
    expect(installedOnRemote).toHaveLength(1);
    expect(installedOnRemote[0]!.keyId).toBe(localCard.keyId);

    expect(result.localGrant).toMatchObject({
      keyId: remoteCard.keyId,
      grantedVia: "ssh",
      tier: "control",
      tlsSpkiFingerprint: "ab".repeat(32),
    });
    expect(result.remoteCard.keyId).toBe(remoteCard.keyId);

    expect(result.remoteGrant).toEqual({ keyId: localCard.keyId, tier: "control" });

    // All ssh calls used argv arrays with -p and destination; no shell string.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.argv[0]).toBe("ssh");
      expect(call.argv).toContain("-p");
      expect(call.argv).toContain("2222");
      expect(call.argv).toContain("art@air");
      expect(call.argv.some((part) => part.includes(" "))).toBe(false);
    }
    expect(calls[0]!.argv.slice(-4)).toEqual(["scout", "mesh", "card", "--json"]);
    expect(calls[1]!.argv.slice(-5)).toEqual(["scout", "mesh", "trust", "install-grant", "--help"]);
    expect(calls[1]!.stdin).toBeUndefined();
    expect(calls[2]!.argv.slice(-8)).toEqual(["scout", "mesh", "trust", "install-grant", "-", "--tier", "control", "--json"]);
    expect(calls[2]!.stdin).toContain(localCard.keyId);
  });

  test("observe is requested and confirmed on both sides", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const remoteCard = cardFor(freshIdentity(), "remote");
    const { exec, calls } = captureExec((input) => {
      if (input.argv.includes("card")) return { stdout: JSON.stringify(remoteCard), stderr: "", exitCode: 0 };
      if (input.argv.includes("--help")) return { stdout: "scout mesh trust install-grant - [--tier <tier>]", stderr: "", exitCode: 0 };
      expect(input.argv.slice(-3)).toEqual(["--tier", "observe", "--json"]);
      return { stdout: JSON.stringify({ peer: { keyId: localCard.keyId, tier: "observe" } }), stderr: "", exitCode: 0 };
    });
    const result = await enrollViaSsh({ target: "ssh://remote", localCard, tier: "observe", exec });
    expect(result.localGrant.tier).toBe("observe");
    expect(result.remoteGrant).toEqual({ keyId: localCard.keyId, tier: "observe" });
    expect(calls.filter((call) => call.stdin)).toHaveLength(1);
  });

  test("old or unproven remotes are refused before sending a grant", async () => {
    const localCard = cardFor(freshIdentity(), "local"), remoteCard = cardFor(freshIdentity(), "remote");
    for (const help of [
      { stdout: "scout mesh trust install-grant -", stderr: "", exitCode: 0 },
      { stdout: "scout mesh enroll --tier observe\nscout mesh trust install-grant -", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "unknown command install-grant", exitCode: 2 },
    ]) {
      const { exec, calls } = captureExec((input) => input.argv.includes("card")
        ? { stdout: JSON.stringify(remoteCard), stderr: "", exitCode: 0 } : help);
      await expect(enrollViaSsh({ target: "ssh://remote", localCard, tier: "observe", exec })).rejects.toMatchObject({ reason: "remote-upgrade-required", message: expect.stringContaining("Upgrade Scout") });
      expect(calls.some((call) => call.stdin)).toBe(false);
    }
  });

  test("zero exit with an unconfirmed remote tier/key never returns a local grant", async () => {
    const localCard = cardFor(freshIdentity(), "local"), remoteCard = cardFor(freshIdentity(), "remote");
    for (const receipt of ["", "not-json", "null", JSON.stringify({ peer: { keyId: localCard.keyId } }),
      JSON.stringify({ peer: { keyId: localCard.keyId, tier: "control" } }),
      JSON.stringify({ peer: { keyId: remoteCard.keyId, tier: "observe" } })]) {
      const { exec } = captureExec((input) => ({ stdout: input.argv.includes("card") ? JSON.stringify(remoteCard)
        : input.argv.includes("--help") ? "scout mesh trust install-grant - [--tier <tier>]" : receipt, stderr: "", exitCode: 0 }));
      await expect(enrollViaSsh({ target: "ssh://remote", localCard, tier: "observe", exec })).rejects.toMatchObject({ reason: "remote-tier-unconfirmed" });
    }
  });

  test("a remote rejecting --tier receives a clear upgrade error without local enrollment", async () => {
    const localCard = cardFor(freshIdentity(), "local"), remoteCard = cardFor(freshIdentity(), "remote");
    const { exec } = captureExec((input) => input.argv.includes("card") ? { stdout: JSON.stringify(remoteCard), stderr: "", exitCode: 0 }
      : input.argv.includes("--help") ? { stdout: "scout mesh trust install-grant - [--tier <tier>]", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "unknown flag --tier", exitCode: 2 });
    await expect(enrollViaSsh({ target: "ssh://remote", localCard, tier: "observe", exec })).rejects.toMatchObject({ reason: "remote-upgrade-required" });
  });

  test("invalid remote card aborts before install-grant — no half-enrollment", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const badCard = {
      ...cardFor(freshIdentity(), "air"),
      signature: "not-a-real-signature",
    };

    let installCalls = 0;
    const { exec, calls } = captureExec((input) => {
      const remoteCmd = input.argv.slice(input.argv.indexOf("scout"));
      if (remoteCmd.includes("card")) {
        return { stdout: JSON.stringify(badCard), stderr: "", exitCode: 0 };
      }
      installCalls += 1;
      return { stdout: "", stderr: "should not run", exitCode: 0 };
    });

    await expect(
      enrollViaSsh({ target: "ssh://air", localCard, exec }),
    ).rejects.toMatchObject({ reason: "invalid-card" });

    expect(installCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toContain("card");
  });

  test("remote install-grant failure leaves no local grant (caller never sees one)", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const remoteCard = cardFor(freshIdentity(), "air");

    const { exec } = captureExec((input) => {
      const remoteCmd = input.argv.slice(input.argv.indexOf("scout"));
      if (remoteCmd.includes("card")) {
        return { stdout: JSON.stringify({ card: remoteCard }), stderr: "", exitCode: 0 };
      }
      if (remoteCmd.includes("--help")) return { stdout: "scout mesh trust install-grant - [--tier <tier>]", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "grant refused", exitCode: 2 };
    });

    await expect(
      enrollViaSsh({ target: "ssh://air", localCard, exec }),
    ).rejects.toMatchObject({ reason: "remote-rejected" });
  });

  test("remote scout missing surfaces stderr clearly", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const { exec } = captureExec(() => ({
      stdout: "",
      stderr: "bash: scout: command not found",
      exitCode: 127,
    }));

    await expect(
      enrollViaSsh({ target: "ssh://air", localCard, exec }),
    ).rejects.toMatchObject({
      reason: "remote-scout-missing",
      message: expect.stringContaining("command not found"),
    });
  });

  test("ssh failure (exit 255) is classified as ssh-failed", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const { exec } = captureExec(() => ({
      stdout: "",
      stderr: "ssh: connect to host air port 22: Connection refused",
      exitCode: 255,
    }));

    await expect(
      enrollViaSsh({ target: "ssh://air", localCard, exec }),
    ).rejects.toMatchObject({ reason: "ssh-failed" });
  });

  test("self-enrollment is rejected after fetching the remote card", async () => {
    const identity = freshIdentity();
    const card = cardFor(identity, "same");
    const { exec, calls } = captureExec((input) => {
      if (input.argv.includes("card")) {
        return { stdout: JSON.stringify(card), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "should not install", exitCode: 0 };
    });

    await expect(
      enrollViaSsh({ target: "ssh://localhost", localCard: card, exec }),
    ).rejects.toMatchObject({ reason: "self-enrollment" });
    expect(calls.every((c) => !c.argv.includes("install-grant"))).toBe(true);
  });

  test("exec timeout surfaces as ssh-timeout", async () => {
    const localCard = cardFor(freshIdentity(), "local");
    const exec: SshExec = async () => {
      throw new SshEnrollError("ssh-timeout", "ssh timed out after 1ms", { argv: ["ssh"] });
    };
    await expect(
      enrollViaSsh({ target: "ssh://air", localCard, exec, timeoutMs: 1 }),
    ).rejects.toMatchObject({ reason: "ssh-timeout" });
  });
});

// The proposal lives in the monorepo docs tree; source-only checkouts skip
// the doc-consistency guard.
const TRUST_CONE_DOC = join(import.meta.dir, "../../../docs/proposals/mesh-trust-cone.md");

describe.skipIf(!existsSync(TRUST_CONE_DOC))("§3c proposal consistency", () => {
  test("mesh-trust-cone §3c documents mutual SSH bootstrap and skips SAS", () => {
    const doc = readFileSync(TRUST_CONE_DOC, "utf8");
    const section = doc.split("### 3c. SSH bootstrap")[1]?.split("## 4.")[0] ?? "";
    expect(section.length).toBeGreaterThan(200);
    expect(section).toMatch(/SAS/i);
    expect(section).toMatch(/skipped|skip/i);
    expect(section).toMatch(/mutual/i);
    expect(section).toMatch(/argv/i);
    expect(section).toMatch(/install-grant/);
    expect(section).toMatch(/scout mesh card/);
    expect(section).toMatch(/StrictHostKeyChecking|host-key/i);
    expect(section).toMatch(/never-clear|tls\.spkiFingerprint|TLS pin/i);
  });
});
