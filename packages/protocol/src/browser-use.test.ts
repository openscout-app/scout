import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BROWSER_ADAPTER_ORDER,
  isOriginAllowed,
  isSecretCutoffOrigin,
  normalizeOrigin,
  pickBrowserAdapter,
  type BrowserAdapterHealth,
} from "./browser-use.js";

describe("browser-use protocol helpers", () => {
  test("normalizeOrigin keeps scheme, host, and port and rejects non-http(s)", () => {
    expect(normalizeOrigin("https://GitHub.com/openscout-app/scout")).toBe("https://github.com");
    expect(normalizeOrigin("http://127.0.0.1:43120/home")).toBe("http://127.0.0.1:43120");
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("not-a-url")).toBeNull();
  });

  test("isOriginAllowed enforces exact origin matching", () => {
    const policy = { allowOrigins: ["https://github.com", "http://127.0.0.1:43120"] };
    expect(isOriginAllowed("https://github.com/notifications", policy)).toBe(true);
    expect(isOriginAllowed("https://evil-github.com/", policy)).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:43122/", policy)).toBe(false);
    expect(isOriginAllowed("https://anything.example/", {})).toBe(true);
  });

  test("isSecretCutoffOrigin detects protected origins", () => {
    const policy = { secretCutoffOrigins: ["https://console.example.com"] };
    expect(isSecretCutoffOrigin("https://console.example.com/api-keys", policy)).toBe(true);
    expect(isSecretCutoffOrigin("https://docs.example.com/", policy)).toBe(false);
  });

  test("pickBrowserAdapter prefers Scout companion, then Scout native, then external", () => {
    const health: BrowserAdapterHealth[] = [
      { id: "browser-use", available: true, mode: "managed" },
      { id: "scout-native", available: true, mode: "managed" },
      { id: "scout-companion", available: true, mode: "companion" },
    ];
    expect(DEFAULT_BROWSER_ADAPTER_ORDER[0]).toBe("scout-companion");
    expect(pickBrowserAdapter(health)?.id).toBe("scout-companion");
    expect(pickBrowserAdapter(health, "browser-use")?.id).toBe("browser-use");
    expect(
      pickBrowserAdapter([
        { id: "scout-companion", available: false, mode: "companion" },
        { id: "browser-use", available: true, mode: "managed" },
      ])?.id,
    ).toBe("browser-use");
  });
});
