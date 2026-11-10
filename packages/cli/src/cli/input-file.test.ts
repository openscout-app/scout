import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCliInputFile, readTaskCallbackFile } from "./input-file.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openscout-cli-input-"));
  tempDirs.add(dir);
  return dir;
}

describe("readCliInputFile", () => {
  test("reads UTF-8 prompt files and strips a BOM", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "prompt.md");
    writeFileSync(filePath, "\uFEFFReview the parser\n", "utf8");

    await expect(readCliInputFile(filePath, "prompt")).resolves.toBe(
      "Review the parser\n",
    );
  });

  test("rejects empty message files", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "empty.md");
    writeFileSync(filePath, "\n\n", "utf8");

    await expect(readCliInputFile(filePath, "message")).rejects.toThrow(
      "message file is empty",
    );
  });
});

describe("readTaskCallbackFile", () => {
  test("reads the module source for the wire", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "open-page.js");
    const code = "export default ({ result, scout }) => scout.open(result.files[0]);\n";
    writeFileSync(filePath, `﻿${code}`, "utf8");
    await expect(readTaskCallbackFile(filePath)).resolves.toEqual({ code });
  });

  test("refuses a missing, empty or oversized file", async () => {
    const dir = makeTempDir();
    await expect(readTaskCallbackFile(join(dir, "missing.js"))).rejects.toThrow("could not read callback file");
    writeFileSync(join(dir, "empty.js"), "  \n", "utf8");
    await expect(readTaskCallbackFile(join(dir, "empty.js"))).rejects.toThrow("callback file is empty");
    writeFileSync(join(dir, "long.js"), `export default () => "${"x".repeat(16_000)}";`, "utf8");
    await expect(readTaskCallbackFile(join(dir, "long.js"))).rejects.toThrow("is over 16000 characters");
    writeFileSync(join(dir, "huge.js"), "x".repeat(70_000), "utf8");
    await expect(readTaskCallbackFile(join(dir, "huge.js"))).rejects.toThrow("is over 16000 characters");
  });
});
