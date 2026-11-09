import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import type {
  ConversationProjectionItem,
  ConversationProjectionSnapshot,
} from "@openscout/protocol";

import {
  buildNativeReadFeedArtifact,
  ConversationFeedArtifactPublisher,
  NATIVE_READ_FEED_ARTIFACT_FILENAME,
  NATIVE_READ_FEED_ARTIFACT_SCHEMA,
  NATIVE_READ_FEED_ARTIFACT_VERSION,
  NATIVE_READ_FEED_MAX_BYTES,
  NATIVE_READ_FEED_MAX_ITEMS,
  NATIVE_READ_FEED_MAX_ROW_BYTES,
  serializeNativeReadFeedArtifact,
  type NativeReadFeedArtifact,
} from "./conversation-feed-artifact.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-feed-artifact-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function item(
  feedId: string,
  overrides: Partial<ConversationProjectionItem> = {},
): ConversationProjectionItem {
  return {
    feedId,
    entityKind: "scout_conversation",
    kind: "direct",
    conversationId: feedId.replace(/^conv:/u, ""),
    runtimeSessionId: null,
    source: "broker",
    sourceSessionId: null,
    title: `Title ${feedId}`,
    alias: null,
    naturalKey: null,
    projectRoot: "/Users/you/dev/openscout",
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    agentId: "agent-1",
    agentName: "Agent One",
    currentBranch: "main",
    authorityNodeId: "node-1",
    authorityNodeName: "Local",
    parentConversationId: null,
    anchorMessageId: null,
    activityState: "idle",
    lastMessageId: `message:${feedId}`,
    lastMessageAt: 1_000,
    lastActivityAt: 1_000,
    messageCount: 1,
    unreadCount: 0,
    participantCount: 2,
    preview: "Ready",
    lastEngagedAt: null,
    sourceFreshAt: 1_000,
    visibilityState: "visible",
    updatedSeq: 1,
    updatedAt: 1_000,
    ...overrides,
  };
}

function snapshot(
  items: ConversationProjectionItem[],
  overrides: Partial<ConversationProjectionSnapshot> = {},
): ConversationProjectionSnapshot {
  return {
    projectionId: "projection-1",
    projectionVersion: 1,
    sequence: 7,
    generatedAt: 2_000,
    sourceFreshAt: 1_900,
    items,
    total: items.filter((entry) => entry.visibilityState === "visible").length,
    hasMore: false,
    engagedFeedId: items[0]?.feedId ?? null,
    identityRedirects: [],
    ...overrides,
  };
}

describe("ConversationFeedArtifactPublisher", () => {
  test("atomically replaces the artifact and skips an identical persisted cursor", () => {
    const directory = temporaryDirectory();
    const outputPath = join(directory, "native", NATIVE_READ_FEED_ARTIFACT_FILENAME);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "stale artifact\n", "utf8");
    const staleInode = statSync(outputPath, { bigint: true }).ino;

    const firstSnapshot = snapshot([item("conv:alpha")]);
    const first = new ConversationFeedArtifactPublisher(outputPath).publish(firstSnapshot);
    const firstContents = readFileSync(outputPath, "utf8");
    const firstInode = statSync(outputPath, { bigint: true }).ino;

    expect(first.status).toBe("written");
    expect(firstInode).not.toBe(staleInode);
    expect(readdirSync(dirname(outputPath))).toEqual([NATIVE_READ_FEED_ARTIFACT_FILENAME]);
    expect(JSON.parse(firstContents)).toMatchObject({
      schema: NATIVE_READ_FEED_ARTIFACT_SCHEMA,
      version: NATIVE_READ_FEED_ARTIFACT_VERSION,
      projectionId: "projection-1",
      sequence: 7,
    });

    const restartedPublisher = new ConversationFeedArtifactPublisher(outputPath);
    expect(restartedPublisher.publish(firstSnapshot)).toEqual({
      status: "skipped",
      reason: "identical_projection_cursor",
      outputPath,
      projectionId: "projection-1",
      sequence: 7,
    });
    expect(readFileSync(outputPath, "utf8")).toBe(firstContents);

    const second = restartedPublisher.publish({ ...firstSnapshot, sequence: 8 });
    expect(second.status).toBe("written");
    expect(statSync(outputPath, { bigint: true }).ino).not.toBe(firstInode);
    expect((JSON.parse(readFileSync(outputPath, "utf8")) as NativeReadFeedArtifact).sequence).toBe(8);
    expect(readdirSync(dirname(outputPath))).toEqual([NATIVE_READ_FEED_ARTIFACT_FILENAME]);
  });

  test("bounds top rows, each encoded row, and the complete artifact", () => {
    const items = Array.from({ length: 220 }, (_, index) => item(
      `conv:${String(index).padStart(3, "0")}`,
      {
        lastActivityAt: index,
        updatedAt: index,
        preview: `activity-${index} ${"🧭".repeat(2_000)}`,
      },
    ));
    const input = snapshot(items, {
      total: items.length,
      engagedFeedId: "conv:219",
    });
    const serialized = serializeNativeReadFeedArtifact(input);
    const artifact = JSON.parse(serialized) as NativeReadFeedArtifact;

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(NATIVE_READ_FEED_MAX_BYTES);
    expect(artifact.items).toHaveLength(NATIVE_READ_FEED_MAX_ITEMS);
    expect(artifact.items[0]?.feedId).toBe("conv:219");
    expect(artifact.total).toBe(220);
    expect(artifact.hasMore).toBe(true);
    expect(artifact.items.every((entry) => (
      Buffer.byteLength(JSON.stringify(entry), "utf8") <= NATIVE_READ_FEED_MAX_ROW_BYTES
    ))).toBe(true);
    expect(artifact.items[0]?.preview?.endsWith("…")).toBe(true);
  });

  test("drops an oversized non-truncatable identity instead of publishing an oversized row", () => {
    const oversizedFeedId = `conv:${"identity".repeat(400)}`;
    const artifact = buildNativeReadFeedArtifact(snapshot([
      item(oversizedFeedId, { lastActivityAt: 2_000 }),
      item("conv:valid", { lastActivityAt: 1_000 }),
    ]));

    expect(artifact.items.map((entry) => entry.feedId)).toEqual(["conv:valid"]);
    expect(artifact.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(artifact.items[0]), "utf8"))
      .toBeLessThanOrEqual(NATIVE_READ_FEED_MAX_ROW_BYTES);
  });

  test("serializes deterministically across input and redirect order", () => {
    const alpha = item("conv:alpha", { lastActivityAt: 10 });
    const beta = item("conv:beta", { lastActivityAt: 10 });
    const hidden = item("conv:hidden", {
      lastActivityAt: 100,
      visibilityState: "hidden",
    });
    const redirects = [
      { fromFeedId: "conv:old-beta", toFeedId: "conv:beta" },
      { fromFeedId: "conv:irrelevant", toFeedId: "conv:hidden" },
      { fromFeedId: "conv:old-alpha", toFeedId: "conv:alpha" },
      { fromFeedId: "conv:old-beta", toFeedId: "conv:beta" },
    ];
    const first = snapshot([beta, hidden, alpha], {
      total: 2,
      engagedFeedId: "conv:alpha",
      identityRedirects: redirects,
    });
    const second = snapshot([alpha, beta, hidden], {
      total: 2,
      engagedFeedId: "conv:alpha",
      identityRedirects: [...redirects].reverse(),
    });

    const firstSerialized = serializeNativeReadFeedArtifact(first);
    expect(serializeNativeReadFeedArtifact(second)).toBe(firstSerialized);
    const artifact = JSON.parse(firstSerialized) as NativeReadFeedArtifact;
    expect(artifact.items.map((entry) => entry.feedId)).toEqual(["conv:alpha", "conv:beta"]);
    expect(artifact.identityRedirects).toEqual([
      { fromFeedId: "conv:old-alpha", toFeedId: "conv:alpha" },
      { fromFeedId: "conv:old-beta", toFeedId: "conv:beta" },
    ]);
  });
});
