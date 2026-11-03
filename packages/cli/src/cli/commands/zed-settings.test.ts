import { describe, expect, test } from "bun:test";

import {
  planZedScoutContextServer,
  readZedScoutContextServer,
  zedSettingsPath,
} from "./zed-settings.ts";

const entry = { command: "/opt/scout/bin/scout", args: ["mcp"] };

function written(text: string, force = false): string {
  const plan = planZedScoutContextServer(text, entry, { force });
  if (plan.action !== "write") {
    throw new Error(`expected a write, got ${plan.action}`);
  }
  return plan.text;
}

describe("zedSettingsPath", () => {
  test("uses ~/.config/zed on macOS, not Application Support", () => {
    expect(zedSettingsPath({ HOME: "/home/a" }, "darwin")).toBe("/home/a/.config/zed/settings.json");
  });

  test("honors XDG_CONFIG_HOME on Linux", () => {
    expect(zedSettingsPath({ HOME: "/home/a" }, "linux")).toBe("/home/a/.config/zed/settings.json");
    expect(zedSettingsPath({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/zed/settings.json");
  });

  test("uses APPDATA on Windows", () => {
    expect(zedSettingsPath({ HOME: "C:\\Users\\a", APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32"))
      .toBe("C:\\Users\\a\\AppData\\Roaming\\Zed\\settings.json");
  });
});

describe("planZedScoutContextServer", () => {
  test("writes a new document for an empty or missing file", () => {
    expect(written("")).toBe([
      "{",
      "  \"context_servers\": {",
      "    \"scout\": {",
      "      \"command\": \"/opt/scout/bin/scout\",",
      "      \"args\": [",
      "        \"mcp\"",
      "      ]",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"));
  });

  test("keeps a comment-only file's comments", () => {
    const next = written("// Zed settings\n");
    expect(next.startsWith("// Zed settings\n{")).toBe(true);
    expect(readZedScoutContextServer(next)).toEqual(entry);
  });

  test("adds context_servers to a commented settings file and changes nothing else", () => {
    const original = [
      "// Zed settings",
      "//",
      "// For information on how to configure Zed, see the Zed docs.",
      "{",
      "  /* fonts */",
      "  \"ui_font_size\": 16,",
      "  \"buffer_font_family\": \"Berkeley Mono\", // the good one",
      "  \"theme\": {",
      "    \"mode\": \"system\",",
      "    \"light\": \"One Light\",",
      "    \"dark\": \"One Dark\"",
      "  }",
      "}",
      "",
    ].join("\n");
    const next = written(original);

    expect(next).toBe([
      "// Zed settings",
      "//",
      "// For information on how to configure Zed, see the Zed docs.",
      "{",
      "  /* fonts */",
      "  \"ui_font_size\": 16,",
      "  \"buffer_font_family\": \"Berkeley Mono\", // the good one",
      "  \"theme\": {",
      "    \"mode\": \"system\",",
      "    \"light\": \"One Light\",",
      "    \"dark\": \"One Dark\"",
      "  },",
      "  \"context_servers\": {",
      "    \"scout\": {",
      "      \"command\": \"/opt/scout/bin/scout\",",
      "      \"args\": [",
      "        \"mcp\"",
      "      ]",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"));
  });

  test("keeps a trailing-comma style", () => {
    const next = written("{\n  \"vim_mode\": true,\n}\n");
    expect(next).toContain("\"vim_mode\": true,\n  \"context_servers\": {");
    expect(next).toMatch(/\n {2}\},\n\}\n$/);
    expect(readZedScoutContextServer(next)).toEqual(entry);
  });

  test("leaves a same-line comment on the property it describes", () => {
    const next = written("{\n  \"vim_mode\": true // modal editing\n}\n");
    expect(next).toContain("\"vim_mode\": true, // modal editing\n  \"context_servers\": {");
    expect(readZedScoutContextServer(next)).toEqual(entry);
  });

  test("adds scout beside other context servers", () => {
    const original = [
      "{",
      "  \"context_servers\": {",
      "    \"github\": {",
      "      \"url\": \"https://api.githubcopilot.com/mcp/\"",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const next = written(original);

    expect(next).toContain("\"url\": \"https://api.githubcopilot.com/mcp/\"\n    },\n    \"scout\": {\n      \"command\"");
    expect(readZedScoutContextServer(next)).toEqual(entry);
  });

  test("fills an empty context_servers object", () => {
    const next = written("{\n  \"context_servers\": {}\n}\n");
    expect(next).toContain("\"context_servers\": {\n    \"scout\": {\n      \"command\"");
    expect(next).toContain("\n    }\n  }\n}\n");
  });

  test("follows a four-space or tab indent", () => {
    expect(written("{\n    \"vim_mode\": true\n}\n")).toContain("\n    \"context_servers\": {\n        \"scout\": {");
    expect(written("{\n\t\"vim_mode\": true\n}\n")).toContain("\n\t\"context_servers\": {\n\t\t\"scout\": {");
  });

  test("leaves a matching entry alone", () => {
    const original = "{\n  \"context_servers\": {\n    \"scout\": { \"command\": \"/opt/scout/bin/scout\", \"args\": [\"mcp\"], \"enabled\": false }\n  }\n}\n";
    expect(planZedScoutContextServer(original, entry, { force: false })).toEqual({ action: "unchanged" });
  });

  test("reports a different entry and replaces it only when forced", () => {
    const original = "{\n  // mine\n  \"context_servers\": {\n    \"scout\": { \"command\": \"scout\" }\n  }\n}\n";
    expect(planZedScoutContextServer(original, entry, { force: false })).toEqual({
      action: "conflict",
      existing: { command: "scout" },
    });

    const plan = planZedScoutContextServer(original, entry, { force: true });
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      expect(plan.replaced).toBe(true);
      expect(plan.text.startsWith("{\n  // mine\n  \"context_servers\": {\n    \"scout\": {\n      \"command\"")).toBe(true);
      expect(readZedScoutContextServer(plan.text)).toEqual(entry);
    }
  });

  test("does not mistake // inside a string for a comment", () => {
    const next = written("{\n  \"proxy\": \"http://localhost:8080\"\n}\n");
    expect(next).toContain("\"proxy\": \"http://localhost:8080\",\n  \"context_servers\"");
  });

  test("refuses files it cannot read safely", () => {
    expect(() => planZedScoutContextServer("{ \"a\": }", entry, { force: false })).toThrow("not valid JSON");
    expect(() => planZedScoutContextServer("[1, 2]", entry, { force: false })).toThrow("top level is not an object");
    expect(() => planZedScoutContextServer("{ \"context_servers\": [] }", entry, { force: false })).toThrow("context_servers is not an object");
    expect(() => planZedScoutContextServer("{ /* open", entry, { force: false })).toThrow("unterminated block comment");
  });
});
