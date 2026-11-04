import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { ScoutCliError } from "../errors.ts";

/*
 * Zed keeps user settings in JSON with `//` and block comments and accepts
 * trailing commas. `scout mcp install --host zed` sets one key,
 * `context_servers.scout`, and leaves every other byte of the file as it was.
 * A JSON.parse/JSON.stringify round trip would drop the user's comments, so
 * this module edits the text in place instead.
 */

export type ZedScoutServerEntry = {
  command: string;
  args: string[];
};

export type ZedSettingsPlan =
  | { action: "unchanged" }
  | { action: "conflict"; existing: unknown }
  | { action: "write"; text: string; replaced: boolean };

type TokenKind = "{" | "}" | "[" | "]" | ":" | "," | "string" | "literal";

type Token = {
  kind: TokenKind;
  start: number;
  end: number;
};

type JsonNode =
  | { type: "object"; start: number; end: number; properties: JsonProperty[] }
  | { type: "array"; start: number; end: number; items: JsonNode[] }
  | { type: "string" | "literal"; start: number; end: number };

type JsonObjectNode = Extract<JsonNode, { type: "object" }>;

type JsonProperty = {
  key: string;
  keyStart: number;
  value: JsonNode;
  commaEnd?: number;
};

type TextEdit = {
  start: number;
  end: number;
  text: string;
};

const LITERAL_PATTERN = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
const PUNCTUATION = new Set(["{", "}", "[", "]", ":", ","]);

export function zedSettingsPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env.HOME || homedir();
  if (platform === "win32") {
    return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Zed", "settings.json");
  }
  // On macOS Zed reads ~/.config/zed, not ~/Library/Application Support/Zed;
  // that second tree holds data such as threads and extensions.
  if (platform === "darwin") {
    return posix.join(home, ".config", "zed", "settings.json");
  }
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "zed", "settings.json");
}

function settingsError(message: string): ScoutCliError {
  return new ScoutCliError(`Zed settings are not valid JSON with comments: ${message}`);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "﻿") {
      index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) {
        throw settingsError("unterminated block comment");
      }
      index = close + 2;
      continue;
    }

    if (char === "\"") {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== "\"") {
        if (text[index] === "\n") {
          throw settingsError("line break inside a string");
        }
        index += text[index] === "\\" ? 2 : 1;
      }
      if (index >= text.length) {
        throw settingsError("unterminated string");
      }
      index += 1;
      tokens.push({ kind: "string", start, end: index });
      continue;
    }

    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: char as TokenKind, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < text.length
      && !/\s/.test(text[index]!)
      && !PUNCTUATION.has(text[index]!)
      && text[index] !== "\""
      && text[index] !== "/"
    ) {
      index += 1;
    }
    const literal = text.slice(start, index);
    if (!LITERAL_PATTERN.test(literal)) {
      throw settingsError(`unexpected "${literal || text[index]}" at offset ${start}`);
    }
    tokens.push({ kind: "literal", start, end: index });
  }

  return tokens;
}

class Parser {
  private position = 0;

  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
  ) {}

  parseDocument(): JsonNode | null {
    if (this.tokens.length === 0) {
      return null;
    }
    const root = this.parseValue();
    if (this.position < this.tokens.length) {
      throw settingsError("more than one top-level value");
    }
    return root;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (!token) {
      throw settingsError("unexpected end of file");
    }
    this.position += 1;
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.next();
    if (token.kind !== kind) {
      throw settingsError(`expected "${kind}" at offset ${token.start}`);
    }
    return token;
  }

  private parseValue(): JsonNode {
    const token = this.next();
    if (token.kind === "{") {
      return this.parseObject(token);
    }
    if (token.kind === "[") {
      return this.parseArray(token);
    }
    if (token.kind === "string" || token.kind === "literal") {
      return { type: token.kind, start: token.start, end: token.end };
    }
    throw settingsError(`unexpected "${token.kind}" at offset ${token.start}`);
  }

  private parseObject(open: Token): JsonNode {
    const properties: JsonProperty[] = [];
    while (this.peek()?.kind !== "}") {
      const keyToken = this.expect("string");
      this.expect(":");
      const value = this.parseValue();
      const property: JsonProperty = {
        key: JSON.parse(this.text.slice(keyToken.start, keyToken.end)) as string,
        keyStart: keyToken.start,
        value,
      };
      properties.push(property);
      if (this.peek()?.kind === ",") {
        property.commaEnd = this.next().end;
        continue;
      }
      break;
    }
    const close = this.expect("}");
    return { type: "object", start: open.start, end: close.end, properties };
  }

  private parseArray(open: Token): JsonNode {
    const items: JsonNode[] = [];
    while (this.peek()?.kind !== "]") {
      items.push(this.parseValue());
      if (this.peek()?.kind === ",") {
        this.next();
        continue;
      }
      break;
    }
    const close = this.expect("]");
    return { type: "array", start: open.start, end: close.end, items };
  }
}

function parseSettings(text: string): JsonNode | null {
  return new Parser(text, tokenize(text)).parseDocument();
}

function nodeValue(text: string, node: JsonNode): unknown {
  if (node.type === "object") {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      value[property.key] = nodeValue(text, property.value);
    }
    return value;
  }
  if (node.type === "array") {
    return node.items.map((item) => nodeValue(text, item));
  }
  return JSON.parse(text.slice(node.start, node.end));
}

/** Last occurrence wins, as it does when Zed reads the file. */
function findProperty(node: JsonObjectNode, key: string): JsonProperty | undefined {
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    if (node.properties[index]!.key === key) {
      return node.properties[index];
    }
  }
  return undefined;
}

/** Leading whitespace of the line that holds `offset`. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function detectIndentUnit(text: string, root: JsonObjectNode): string {
  const first = root.properties[0];
  const indent = first ? lineIndent(text, first.keyStart) : "";
  return indent.length > 0 ? indent : "  ";
}

function formatValue(value: unknown, indent: string, unit: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(`\n${indent}`);
}

function formatProperty(key: string, value: unknown, indent: string, unit: string): string {
  return `${JSON.stringify(key)}: ${formatValue(value, indent, unit)}`;
}

/**
 * Where a new line can start after `offset`: past any spaces and a `//`
 * comment that ends the same line, so that comment stays with its property.
 */
function lineEndAfter(text: string, offset: number): number {
  let index = offset;
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  if (text.startsWith("//", index)) {
    const newline = text.indexOf("\n", index);
    return newline === -1 ? text.length : newline;
  }
  return offset;
}

function insertProperty(
  text: string,
  node: JsonObjectNode,
  key: string,
  value: unknown,
  unit: string,
): TextEdit[] {
  const last = node.properties[node.properties.length - 1];

  if (!last) {
    const outerIndent = lineIndent(text, node.start);
    const innerIndent = `${outerIndent}${unit}`;
    const property = formatProperty(key, value, innerIndent, unit);
    const inside = text.slice(node.start + 1, node.end - 1);
    if (inside.trim() === "") {
      return [{ start: node.start + 1, end: node.end - 1, text: `\n${innerIndent}${property}\n${outerIndent}` }];
    }
    return [{ start: node.start + 1, end: node.start + 1, text: `\n${innerIndent}${property}` }];
  }

  const innerIndent = lineIndent(text, last.keyStart);
  const property = formatProperty(key, value, innerIndent, unit);

  if (last.commaEnd !== undefined) {
    // The file already ends its properties with a comma; keep that style.
    const at = lineEndAfter(text, last.commaEnd);
    return [{ start: at, end: at, text: `\n${innerIndent}${property},` }];
  }

  const at = lineEndAfter(text, last.value.end);
  if (at === last.value.end) {
    return [{ start: at, end: at, text: `,\n${innerIndent}${property}` }];
  }
  return [
    { start: last.value.end, end: last.value.end, text: "," },
    { start: at, end: at, text: `\n${innerIndent}${property}` },
  ];
}

function applyEdits(text: string, edits: TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

function entryMatches(existing: unknown, entry: ZedScoutServerEntry): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return false;
  }
  const record = existing as Record<string, unknown>;
  const args = record.args ?? [];
  return record.command === entry.command
    && Array.isArray(args)
    && args.length === entry.args.length
    && args.every((arg, index) => arg === entry.args[index]);
}

/** The `context_servers.scout` value in a settings file, if it has one. */
export function readZedScoutContextServer(text: string): unknown {
  const root = parseSettings(text);
  if (root?.type !== "object") {
    return undefined;
  }
  const servers = findProperty(root, "context_servers");
  if (servers?.value.type !== "object") {
    return undefined;
  }
  const scout = findProperty(servers.value, "scout");
  return scout ? nodeValue(text, scout.value) : undefined;
}

/**
 * Plan the change that makes `context_servers.scout` launch Scout's MCP
 * server. A matching entry is left alone. A different entry is reported as a
 * conflict unless `force` is set.
 */
export function planZedScoutContextServer(
  text: string,
  entry: ZedScoutServerEntry,
  options: { force: boolean },
): ZedSettingsPlan {
  const root = parseSettings(text);
  let next: string;
  let replaced = false;

  if (root === null) {
    const body = formatValue({ context_servers: { scout: entry } }, "", "  ");
    next = `${text.trim() === "" ? "" : `${text.trimEnd()}\n`}${body}\n`;
  } else {
    if (root.type !== "object") {
      throw settingsError("the top level is not an object");
    }
    const unit = detectIndentUnit(text, root);
    const servers = findProperty(root, "context_servers");

    if (!servers) {
      next = applyEdits(text, insertProperty(text, root, "context_servers", { scout: entry }, unit));
    } else {
      if (servers.value.type !== "object") {
        throw settingsError("context_servers is not an object");
      }
      const scout = findProperty(servers.value, "scout");
      if (!scout) {
        next = applyEdits(text, insertProperty(text, servers.value, "scout", entry, unit));
      } else {
        const existing = nodeValue(text, scout.value);
        if (entryMatches(existing, entry)) {
          return { action: "unchanged" };
        }
        if (!options.force) {
          return { action: "conflict", existing };
        }
        replaced = true;
        next = applyEdits(text, [{
          start: scout.value.start,
          end: scout.value.end,
          text: formatValue(entry, lineIndent(text, scout.keyStart), unit),
        }]);
      }
    }
  }

  // Never hand back text that does not read back as the entry we meant to write.
  if (!entryMatches(readZedScoutContextServer(next), entry)) {
    throw new ScoutCliError("Scout could not edit Zed settings safely; the file was left unchanged.");
  }
  return { action: "write", text: next, replaced };
}
