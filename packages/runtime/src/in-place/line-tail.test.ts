import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLineTail } from "./line-tail.js";

let folder: string | null = null;

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = null;
});

async function fileWith(text: string): Promise<string> {
  folder = await mkdtemp(join(tmpdir(), "scout-line-tail-"));
  const path = join(folder, "transcript.jsonl");
  await writeFile(path, text);
  return path;
}

async function readLines(tail: ReturnType<typeof openLineTail>): Promise<string[]> {
  const seen: string[] = [];
  expect(await tail.read((line) => { seen.push(line); })).toBe(true);
  return seen;
}

test("each complete line is handed over once, and a line still being written waits for its end", async () => {
  const path = await fileWith("one\ntwo\nthr");
  const tail = openLineTail(path);
  expect(await readLines(tail)).toEqual(["one", "two"]);
  expect(tail.unfinished()).toBe(true);
  expect(tail.size()).toBe(11);
  // Nothing new: nothing is handed over again.
  expect(await readLines(tail)).toEqual([]);

  await appendFile(path, "ee\nfour\n");
  expect(await readLines(tail)).toEqual(["three", "four"]);
  expect(tail.unfinished()).toBe(false);
  expect(tail.size()).toBe(19);
});

test("a reader opened at an offset sees only what follows it", async () => {
  const path = await fileWith("earlier\nlater\n");
  expect(await readLines(openLineTail(path, 8))).toEqual(["later"]);
  // An offset at the end reads nothing until the file grows.
  const atEnd = openLineTail(path, 14);
  expect(await readLines(atEnd)).toEqual([]);
  await appendFile(path, "é after\n");
  expect(await readLines(atEnd)).toEqual(["é after"]);
});

test("a line longer than one piece is still handed over whole", async () => {
  const long = "x".repeat(5 * 1024 * 1024);
  const path = await fileWith(`first\n${long}\nlast\n`);
  const seen = await readLines(openLineTail(path));
  expect(seen.map((line) => line.length)).toEqual([5, long.length, 4]);
});

test("reads that overlap do not skip or repeat a line", async () => {
  const path = await fileWith("one\ntwo\n");
  const tail = openLineTail(path);
  const seen: string[] = [];
  const read = () => tail.read((line) => { seen.push(line); });
  expect(await Promise.all([read(), read(), read()])).toEqual([true, true, true]);
  expect(seen).toEqual(["one", "two"]);
  await appendFile(path, "three\n");
  await Promise.all([read(), read()]);
  expect(seen).toEqual(["one", "two", "three"]);
  expect(tail.size()).toBe(14);
});

test("a replaced file is read again from its start when the reader asks for that", async () => {
  const path = await fileWith("one\ntwo\nthree\n");
  let replaced = 0;
  const tail = openLineTail(path, 0, { onReplaced: () => { replaced += 1; } });
  expect(await readLines(tail)).toEqual(["one", "two", "three"]);
  await writeFile(path, "new\n");
  expect(await readLines(tail)).toEqual(["new"]);
  expect(replaced).toBe(1);
});

test("a file that cannot be read says so, and a file that shrank reads as nothing new", async () => {
  const path = await fileWith("one\ntwo\n");
  const tail = openLineTail(path);
  expect(await readLines(tail)).toEqual(["one", "two"]);
  await writeFile(path, "x\n");
  expect(await readLines(tail)).toEqual([]);
  expect(tail.unfinished()).toBe(false);
  await rm(path);
  expect(await tail.read(() => { throw new Error("nothing to hand over"); })).toBe(false);
});
