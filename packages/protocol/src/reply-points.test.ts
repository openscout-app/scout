import { expect, test } from "bun:test";
import { parseReplyPointArg, replyPointProblems, replyPointsOf, replyPointsRecord, REPLY_POINT_LIMITS } from "./reply-points.js";
import { validateTaskReply } from "./tasks.js";

test("a point needs a known stance and text; re and about are optional", () => {
  expect(replyPointProblems(undefined)).toEqual([]);
  expect(replyPointProblems([{ stance: "claim", text: "Keep Home on the shipped Feed." }])).toEqual([]);
  expect(replyPointProblems([{ stance: "dispute", text: "One sequence is enough.", re: "msg-1#2", about: "sequence" }])).toEqual([]);
  expect(replyPointProblems([{ stance: "argue", text: "x" }])[0]).toContain("stance must be one of");
  expect(replyPointProblems([{ stance: "claim", text: "  " }])[0]).toContain("needs text");
  expect(replyPointProblems([{ stance: "claim", text: "x", about: "Home Source" }])[0]).toContain("lowercase key");
  expect(replyPointProblems([{ stance: "claim", text: "x", rank: 1 }])[0]).toContain("unknown fields: rank");
  expect(replyPointProblems([{ stance: "claim", text: "x".repeat(REPLY_POINT_LIMITS.text + 1) }])[0]).toContain("longer than");
  expect(replyPointProblems(Array.from({ length: REPLY_POINT_LIMITS.count + 1 }, () => ({ stance: "claim", text: "x" })))[0]).toContain("at most");
});

test("reply validation refuses bad points before any effect", () => {
  expect(() => validateTaskReply({ ref: "inv-1", points: [{ stance: "claim", text: "ok" }] })).not.toThrow();
  expect(() => validateTaskReply({ ref: "inv-1", points: [{ stance: "shrug" as never, text: "no" }] })).toThrow("reply points are not valid");
});

test("the runtime record numbers points from the message id and trims them", () => {
  const record = replyPointsRecord("msg-9", [{ stance: "claim", text: " A queue first. " }, { stance: "concede", text: "Fair.", re: "msg-1#1" }]);
  expect(record).toEqual({ version: 1, points: [
    { id: "msg-9#1", stance: "claim", text: "A queue first." },
    { id: "msg-9#2", stance: "concede", text: "Fair.", re: "msg-1#1" },
  ] });
  expect(replyPointsOf({ replyPoints: record })).toEqual(record);
  expect(replyPointsOf({ replyPoints: { version: 2, points: [] } })).toBeNull();
  expect(replyPointsOf({})).toBeNull();
});

test("the CLI form reads a stance, optional attributes and the text", () => {
  expect(parseReplyPointArg("claim: Keep Home on the shipped Feed")).toEqual({ stance: "claim", text: "Keep Home on the shipped Feed" });
  expect(parseReplyPointArg("dispute[re=msg.request.ab#2, about=sequence]: One sequence: is enough"))
    .toEqual({ stance: "dispute", text: "One sequence: is enough", re: "msg.request.ab#2", about: "sequence" });
  expect(() => parseReplyPointArg("no stance here")).toThrow("--point takes");
  expect(() => parseReplyPointArg("claim[owner=me]: x")).toThrow("attributes are re=<id> and about=<key>");
  expect(() => parseReplyPointArg("ponder: x")).toThrow("stance must be one of");
});
