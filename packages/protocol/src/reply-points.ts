/**
 * Typed points on a reply. An agent states what its reply does to the
 * discussion: it makes a claim, agrees with or concedes a point, disputes one,
 * or asks the operator a question. A reader can then tell what is agreed, what
 * is divided and what is owed to the operator without reading the prose.
 *
 * The agent writes the points with its reply. The runtime stores them on the
 * reply message as `metadata.replyPoints` and gives each point an id, so a
 * later point can answer it with `re`. Nothing derives points from prose.
 */

/** Peers that store reply points. Points sent to an older task home are refused, not dropped. */
export const REPLY_POINTS_CAPABILITY = "reply-points/1";

export const REPLY_POINT_STANCES = ["claim", "agree", "concede", "dispute", "question"] as const;
export type ReplyPointStance = (typeof REPLY_POINT_STANCES)[number];

export const REPLY_POINT_LIMITS = { count: 24, text: 500, about: 80, re: 300 } as const;

/** What an agent sends. */
export type ReplyPointInput = {
  stance: ReplyPointStance;
  /** The point itself, in one or two sentences. */
  text: string;
  /** The id of the point this one answers: `<messageId>#<n>`. */
  re?: string;
  /** A short key for the question the point is about, shared by the agents in a discussion. */
  about?: string;
};

/** What the runtime stores: the input plus its id. */
export type ReplyPoint = ReplyPointInput & { id: string };

export type ReplyPoints = { version: 1; points: ReplyPoint[] };

const ABOUT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function isStance(value: unknown): value is ReplyPointStance {
  return typeof value === "string" && (REPLY_POINT_STANCES as readonly string[]).includes(value);
}

/** Every reason a list of points is refused. Empty when it is valid. */
export function replyPointProblems(points: unknown): string[] {
  if (points === undefined) return [];
  if (!Array.isArray(points)) return ["points must be a list"];
  const problems: string[] = [];
  if (points.length > REPLY_POINT_LIMITS.count) problems.push(`a reply carries at most ${REPLY_POINT_LIMITS.count} points`);
  points.forEach((point, index) => {
    const at = `point ${index + 1}`;
    if (!point || typeof point !== "object" || Array.isArray(point)) { problems.push(`${at} must be an object`); return; }
    const { stance, text, re, about, ...rest } = point as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length) problems.push(`${at} has unknown fields: ${extra.join(", ")}`);
    if (!isStance(stance)) problems.push(`${at} stance must be one of ${REPLY_POINT_STANCES.join(", ")}`);
    if (typeof text !== "string" || !text.trim()) problems.push(`${at} needs text`);
    else if (text.trim().length > REPLY_POINT_LIMITS.text) problems.push(`${at} text is longer than ${REPLY_POINT_LIMITS.text} characters`);
    if (re !== undefined && (typeof re !== "string" || !re.trim() || re.length > REPLY_POINT_LIMITS.re)) problems.push(`${at} re must be a point id`);
    if (about !== undefined && (typeof about !== "string" || about.length > REPLY_POINT_LIMITS.about || !ABOUT_PATTERN.test(about))) {
      problems.push(`${at} about must be a lowercase key of up to ${REPLY_POINT_LIMITS.about} characters, such as home-source`);
    }
  });
  return problems;
}

/** Trimmed copies with only the known fields, in a stable key order. Call after validation. */
export function normalizeReplyPoints(points: readonly ReplyPointInput[]): ReplyPointInput[] {
  return points.map(point => ({
    stance: point.stance,
    text: point.text.trim(),
    ...(point.re ? { re: point.re.trim() } : {}),
    ...(point.about ? { about: point.about } : {}),
  }));
}

/** The record the runtime stores on a reply message. Ids are `<messageId>#<n>`, counted from 1. */
export function replyPointsRecord(messageId: string, points: readonly ReplyPointInput[]): ReplyPoints {
  return { version: 1, points: normalizeReplyPoints(points).map((point, index) => ({ id: `${messageId}#${index + 1}`, ...point })) };
}

/** The points stored on a message's metadata, or null when there are none or they are malformed. */
export function replyPointsOf(metadata: Record<string, unknown> | undefined): ReplyPoints | null {
  const value = metadata?.replyPoints as ReplyPoints | undefined;
  if (!value || value.version !== 1 || !Array.isArray(value.points)) return null;
  // Metadata is read back from storage; a malformed entry must not throw on destructure.
  if (value.points.some(point => !point || typeof point !== "object" || Array.isArray(point))) return null;
  const inputs = value.points.map(({ id: _id, ...rest }) => rest);
  if (replyPointProblems(inputs).length || value.points.some(point => typeof point.id !== "string" || !point.id)) return null;
  return value;
}

/**
 * Parse one CLI `--point` value: `<stance>[<attrs>]: <text>`, where attrs is an
 * optional `[re=<id>,about=<key>]`. Examples: `claim: Keep Home on the shipped
 * Feed`, `dispute[re=msg-1#2,about=sequence]: One sequence is enough`.
 */
export function parseReplyPointArg(value: string): ReplyPointInput {
  const match = /^\s*([a-z]+)\s*(?:\[([^\]]*)\])?\s*:\s*([\s\S]*)$/.exec(value);
  if (!match) throw new Error(`--point takes '<stance>: <text>' or '<stance>[re=<id>,about=<key>]: <text>'; got '${value}'`);
  const [, stance, attrs, text] = match;
  const point: Record<string, string> = { stance: stance!, text: text!.trim() };
  for (const pair of (attrs ?? "").split(",").map(part => part.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    if (key !== "re" && key !== "about") throw new Error(`--point attributes are re=<id> and about=<key>; got '${pair}'`);
    point[key] = pair.slice(eq + 1).trim();
  }
  const problems = replyPointProblems([point]);
  if (problems.length) throw new Error(`--point is not valid: ${problems.join("; ").replace(/^point 1 /, "")}`);
  return point as ReplyPointInput;
}
