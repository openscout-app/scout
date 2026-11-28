import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SlidingWindowRateLimiter,
  clampScreenMaxWidth,
  clampTrackpadDelta,
  matchesImageMagicBytes,
  parseJxaJson,
  resolveAppleScriptKeySpec,
  resolveMobileRemotePolicy,
  sanitizeRemoteError,
  sanitizeRemoteTypeText,
  validatePasteImageInput,
} from "./mobile-remote.ts";
import { bridgeRouter } from "./router.ts";
import { createCredentialBinding } from "./credential-binding.ts";

describe("mobile remote helpers & security", () => {
  test("resolveAppleScriptKeySpec maps named keys and deduplicates modifiers", () => {
    expect(resolveAppleScriptKeySpec("return")).toEqual({
      kind: "keyCode",
      code: 36,
      modifiers: [],
    });
    expect(resolveAppleScriptKeySpec("ESC", ["shift", "shift"])).toEqual({
      kind: "keyCode",
      code: 53,
      modifiers: ["shift down"],
    });
    expect(resolveAppleScriptKeySpec("c", ["control"])).toEqual({
      kind: "keystroke",
      char: "c",
      modifiers: ["control down"],
    });
    expect(resolveAppleScriptKeySpec("z", ["command", "shift"])).toEqual({
      kind: "keystroke",
      char: "z",
      modifiers: ["command down", "shift down"],
    });
  });

  test("resolveAppleScriptKeySpec rejects multi-character or control-char injections", () => {
    expect(resolveAppleScriptKeySpec("")).toBeNull();
    expect(resolveAppleScriptKeySpec("rm -rf")).toBeNull();
    expect(resolveAppleScriptKeySpec("\n")).toBeNull();
    expect(resolveAppleScriptKeySpec("x", ["command", "evil"])).toEqual({
      kind: "keystroke",
      char: "x",
      modifiers: ["command down"],
    });
  });

  test("sanitizeRemoteTypeText rejects control characters and NUL bytes", () => {
    expect(sanitizeRemoteTypeText("Hello Scout 123!")).toBe("Hello Scout 123!");
    expect(sanitizeRemoteTypeText("")).toBeNull();
    expect(sanitizeRemoteTypeText("hello\0world")).toBeNull();
    expect(sanitizeRemoteTypeText("line1\nline2")).toBeNull();
    expect(sanitizeRemoteTypeText("esc\x1b[31m")).toBeNull();
  });

  test("validatePasteImageInput verifies magic bytes, mime types, and pre-decode bounds", () => {
    const validPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const okPng = validatePasteImageInput({
      base64: `data:image/png;base64,${validPng.toString("base64")}`,
      mimeType: "image/png",
    });
    expect(okPng.ok).toBe(true);
    if (okPng.ok) {
      expect(okPng.ext).toBe("png");
      expect(okPng.bytes.length).toBe(validPng.length);
    }

    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    expect(validatePasteImageInput({
      base64: validJpeg.toString("base64"),
      mimeType: "image/jpeg",
    }).ok).toBe(true);

    const validWebp = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "binary");
    expect(matchesImageMagicBytes(validWebp, "webp")).toBe(true);

    // Spoofed MIME: HTML/script bytes claiming to be JPEG must be rejected.
    const spoofed = validatePasteImageInput({
      base64: Buffer.from("<html><script>alert(1)</script></html>").toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(spoofed.ok).toBe(false);

    const badMime = validatePasteImageInput({
      base64: validPng.toString("base64"),
      mimeType: "application/javascript",
    });
    expect(badMime.ok).toBe(false);

    const empty = validatePasteImageInput({
      base64: "   ",
      mimeType: "image/jpeg",
    });
    expect(empty.ok).toBe(false);
  });

  test("resolveMobileRemotePolicy honors kill switches, granular flags, and fails closed on corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-remote-policy-"));
    try {
      const missingPath = join(dir, "missing.json");
      expect(resolveMobileRemotePolicy({ env: {}, policyPath: missingPath })).toEqual({
        enabled: true,
        input: true,
        screen: true,
        clipboard: true,
        apps: true,
        dictate: true,
        allowWhileLocked: false,
      });

      expect(resolveMobileRemotePolicy({
        env: { SCOUT_MOBILE_REMOTE: "0" },
        policyPath: missingPath,
      })).toEqual({
        enabled: false,
        input: false,
        screen: false,
        clipboard: false,
        apps: false,
        dictate: false,
        allowWhileLocked: false,
      });

      expect(resolveMobileRemotePolicy({
        env: { SCOUT_MOBILE_REMOTE_SCREEN: "false", SCOUT_MOBILE_REMOTE_CLIPBOARD: "0" },
        policyPath: missingPath,
      })).toEqual({
        enabled: true,
        input: true,
        screen: false,
        clipboard: false,
        apps: true,
        dictate: true,
        allowWhileLocked: false,
      });

      const badPath = join(dir, "corrupt.json");
      writeFileSync(badPath, "{not-valid-json");
      expect(resolveMobileRemotePolicy({ env: {}, policyPath: badPath }).enabled).toBe(false);

      const filePath = join(dir, "policy.json");
      writeFileSync(filePath, JSON.stringify({ screen: false, allowWhileLocked: false }));
      const fromFile = resolveMobileRemotePolicy({ env: {}, policyPath: filePath });
      expect(fromFile.enabled).toBe(true);
      expect(fromFile.screen).toBe(false);
      expect(fromFile.input).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SlidingWindowRateLimiter enforces per-key ceilings and recovers after window", () => {
    const limiter = new SlidingWindowRateLimiter();
    expect(limiter.consume("peerA:screen", 2, 1000, 100)).toBe(true);
    expect(limiter.consume("peerA:screen", 2, 1000, 200)).toBe(true);
    expect(limiter.consume("peerA:screen", 2, 1000, 300)).toBe(false);
    // Independent peer unaffected
    expect(limiter.consume("peerB:screen", 2, 1000, 300)).toBe(true);
    // Window advances past first event
    expect(limiter.consume("peerA:screen", 2, 1000, 1150)).toBe(true);
  });

  test("sanitizeRemoteError categorizes TCC failures without leaking raw host stderr", () => {
    expect(sanitizeRemoteError(
      new Error("osascript: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)"),
      "Fallback",
    )).toContain("Accessibility");

    expect(sanitizeRemoteError(
      new Error("screencapture: could not create image from display /Users/secret/tmp.jpg"),
      "Fallback",
    )).toContain("Screen Recording");

    const sanitized = sanitizeRemoteError(
      new Error("Command failed: /usr/bin/osascript /Users/private/secret-path"),
      "Action failed.",
    );
    expect(sanitized).toBe("Action failed.");
    expect(sanitized).not.toContain("/Users/");
  });

  test("router remoteControlProcedure rejects missing or revoked credentialBinding", async () => {
    const bridge = {} as any;
    const callerWithoutBinding = bridgeRouter.createCaller({
      bridge,
      cwd: "/tmp",
      deviceId: "abcdef0123456789",
      secureTransport: true,
      trustedPeer: true,
    });
    await expect(callerWithoutBinding.mobile.remoteState()).rejects.toThrow(/revoked|expired/i);

    let live = true;
    const pubKey = "a".repeat(64);
    let stamp = "stamp-1";
    const binding = createCredentialBinding(
      bridge,
      pubKey,
      () => live,
      { readAuthority: () => ({ stamp, peers: [{ publicKey: pubKey }] } as any) },
    );
    const callerWithBinding = bridgeRouter.createCaller({
      bridge,
      cwd: "/tmp",
      deviceId: pubKey.slice(0, 16),
      secureTransport: true,
      trustedPeer: true,
      credentialBinding: binding,
    });

    // Revoking authority immediately invalidates the open socket.
    stamp = "stamp-2";
    await expect(callerWithBinding.mobile.remoteState()).rejects.toThrow(/revoked|expired/i);

    // Restoring stamp must never revive an invalidated socket.
    stamp = "stamp-1";
    await expect(callerWithBinding.mobile.remoteState()).rejects.toThrow(/revoked|expired/i);
  });

  test("clampScreenMaxWidth and clampTrackpadDelta bound extreme values", () => {
    expect(clampScreenMaxWidth(undefined)).toBe(960);
    expect(clampScreenMaxWidth(100)).toBe(320);
    expect(clampScreenMaxWidth(5000)).toBe(1440);
    expect(clampScreenMaxWidth(800.4)).toBe(800);

    expect(clampTrackpadDelta(undefined)).toBe(0);
    expect(clampTrackpadDelta(Number.NaN)).toBe(0);
    expect(clampTrackpadDelta(99999)).toBe(2400);
    expect(clampTrackpadDelta(-99999)).toBe(-2400);
  });

  test("parseJxaJson returns fallback on malformed stdout", () => {
    expect(parseJxaJson('{"ok":true}', { ok: false })).toEqual({ ok: true });
    expect(parseJxaJson("not-json", { ok: false })).toEqual({ ok: false });
    expect(parseJxaJson("", [])).toEqual([]);
  });
});
