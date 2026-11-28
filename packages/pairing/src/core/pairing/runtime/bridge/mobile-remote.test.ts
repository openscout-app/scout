import { describe, expect, test } from "bun:test";
import {
  clampScreenMaxWidth,
  clampTrackpadDelta,
  parseJxaJson,
  resolveAppleScriptKeySpec,
  validatePasteImageInput,
} from "./mobile-remote.ts";

describe("mobile remote helpers", () => {
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

  test("validatePasteImageInput enforces mime types and decodes base64", () => {
    const sample = Buffer.from([137, 80, 78, 71]).toString("base64");
    const ok = validatePasteImageInput({
      base64: `data:image/png;base64,${sample}`,
      mimeType: "image/png",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.ext).toBe("png");
      expect(ok.bytes.length).toBe(4);
    }

    const badMime = validatePasteImageInput({
      base64: sample,
      mimeType: "application/javascript",
    });
    expect(badMime.ok).toBe(false);

    const empty = validatePasteImageInput({
      base64: "   ",
      mimeType: "image/jpeg",
    });
    expect(empty.ok).toBe(false);
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
