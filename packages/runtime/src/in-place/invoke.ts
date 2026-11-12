// One ask, delivered into a session where it is already open.
//
// The sender names a session and nothing else. The runtime finds the place the
// session is open, waits until it can take a new turn, types the ask there, and
// reads the answer back from the session's own transcript. When the session is
// not open anywhere, this returns null and the caller continues the session
// itself, as it did before.
//
// Every refusal here means nothing was typed, unless it says otherwise.
//
// The delivery leaves a checkpoint on the task as it goes (see checkpoint.ts),
// so a runtime that restarts picks it up: a task still held is delivered from
// the start, and a task already typed is only watched for its answer.

import { DeliveryBlockedError } from "../delivery-blocked.js";
import { RequesterWaitTimeoutError } from "../requester-timeout.js";

import type { InPlaceCheckpoint } from "./checkpoint.js";
import type { BeforeKeystroke, InPlaceActivity, InPlaceDelivery, InPlaceProbe, InPlaceVia } from "./deliver.js";
import type { SessionReplyReader } from "./reply.js";

/** How long an ask waits for a busy session before it is given up. */
export const IN_PLACE_HOLD_MS = 30 * 60_000;
/** How long the runtime watches for the answer after the ask is typed. */
export const IN_PLACE_REPLY_WAIT_MS = 2 * 60 * 60_000;

const HOLD_POLL_MS = 2_000;
const REPLY_POLL_MS = 1_000;
const HOLDER_POLL_MS = 5_000;
const EXPLICIT_REPLY_POLL_MS = 2_000;
/** A session whose activity cannot be read is refused quickly, not held. */
const UNKNOWN_ACTIVITY_GRACE_MS = 15_000;
/**
 * How long a session whose place cannot be verified is looked at again before
 * the ask is refused. One failed read in a long hold is not a refusal.
 */
const UNVERIFIED_GRACE_MS = 15_000;
/**
 * Readings of "not open anywhere" before Scout continues a Claude session
 * itself. Claude Code has no second-writer guard, and one reading can catch
 * its session record half written.
 */
const NOT_OPEN_READINGS = 2;
const NOT_OPEN_CONFIRM_MS = 500;
/**
 * Holder readings (5 s apart) of an idle session with a quiet transcript that
 * never recorded the words, after a restart that interrupted the keystroke.
 */
const UNCONFIRMED_QUIET_READINGS = 3;

export type InPlaceInvokeInput = {
  sessionId: string;
  harness: "claude" | "codex";
  /** Folders the session may run in, for finding a Claude transcript. */
  cwds?: Array<string | null | undefined>;
  /** The session's name in summaries and errors. */
  label: string;
  /** Typed when the answer can be read from the transcript. Must contain `marker`. */
  prompt: string;
  /** Typed when it cannot: it asks the session to reply through Scout. */
  explicitReplyPrompt: string;
  /** A string unique to this ask that the typed words carry. */
  marker: string;
  /** A message that expects no reply. */
  wake: boolean;
  holdMs?: number;
  replyWaitMs?: number;
};

export type InPlaceInvokeDeps = {
  probe: (input: { sessionId: string; harness: string; requireExactHarness: true }) => Promise<InPlaceProbe>;
  deliver: (input: {
    sessionId: string;
    harness: string;
    body: string;
    requireExactHarness: true;
    beforeKeystroke?: BeforeKeystroke;
  }) => Promise<InPlaceDelivery>;
  openReplyReader: (input: {
    sessionId: string;
    harness: "claude" | "codex";
    marker: string;
    cwds?: Array<string | null | undefined>;
    fromOffset?: number;
  }) => Promise<SessionReplyReader | null>;
  holderState: (sessionId: string, harness: "claude" | "codex") => Promise<{ live: boolean; idle: boolean }>;
  /** A reply the session posted through Scout itself, if any. */
  explicitReply?: () => Promise<string | null>;
  onProgress?: (summary: string) => Promise<void> | void;
  /** Where an earlier runtime left this delivery, if one started it. */
  checkpoint?: () => InPlaceCheckpoint | null;
  /** Record where the delivery stands; null clears it. Durable once it resolves. */
  saveCheckpoint?: (checkpoint: InPlaceCheckpoint | null) => Promise<void> | void;
  /** False once the ask was cancelled or finished another way. */
  shouldContinue?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type InPlaceInvokeResult = {
  output: string;
  /** Null when the ask stopped before anything was typed. */
  delivery: {
    via: InPlaceVia;
    location: string;
    heldMs: number;
    replySource: "transcript" | "scout_reply" | "none";
  } | null;
};

/**
 * The harness session an endpoint continues, when that session may also be
 * open somewhere the operator works: an endpoint made for an exact session the
 * sender named. A fork is Scout's own copy and is never open anywhere else.
 */
export function inPlaceSessionForEndpoint(endpoint: {
  harness?: string | null;
  metadata?: Record<string, unknown> | null;
}): { sessionId: string; harness: "claude" | "codex" } | null {
  const metadata = endpoint.metadata ?? {};
  if (metadata.flatDispatch !== true) return null;
  if (typeof metadata.forkedFromSessionId === "string" && metadata.forkedFromSessionId.trim()) return null;
  const harness = endpoint.harness;
  if (harness !== "claude" && harness !== "codex") return null;
  const sessionId = [metadata.nativeSessionId, metadata.externalSessionId]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return sessionId ? { sessionId, harness } : null;
}

function blocked(stage: DeliveryBlockedError["stage"], summary: string, message: string): DeliveryBlockedError {
  return new DeliveryBlockedError({ stage, summary, message });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000));
  return `${count} minute${count === 1 ? "" : "s"}`;
}

export async function invokeSessionInPlace(
  input: InPlaceInvokeInput,
  deps: InPlaceInvokeDeps,
): Promise<InPlaceInvokeResult | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const proceed = () => deps.shouldContinue?.() !== false;
  const progress = async (summary: string) => {
    await Promise.resolve(deps.onProgress?.(summary)).catch(() => undefined);
  };
  const { sessionId, harness, label } = input;
  const holdMs = input.holdMs ?? IN_PLACE_HOLD_MS;
  const replyWaitMs = input.replyWaitMs ?? IN_PLACE_REPLY_WAIT_MS;
  const resume = deps.checkpoint?.() ?? null;
  // The hold is one budget across restarts, counted from when the task began waiting.
  const startedAt = resume?.since ?? now();
  const stopped: InPlaceInvokeResult = { output: "", delivery: null };

  let saved: InPlaceCheckpoint | null = resume;
  const save = async (checkpoint: InPlaceCheckpoint | null): Promise<void> => {
    await deps.saveCheckpoint?.(checkpoint);
    saved = checkpoint;
  };
  // The caller continues the session on its own path. The checkpoint goes
  // first, or a later restart would resume a delivery this path gave up.
  const handOff = async (): Promise<null> => {
    if (!saved) return null;
    try {
      await save(null);
    } catch (error) {
      throw blocked(
        "in_place_failed",
        "the task's record could not be updated.",
        `Scout could not update the task's record before continuing ${label} itself (${errorText(error)}). Nothing was typed.`,
      );
    }
    return null;
  };

  let place: { via: InPlaceVia; location: string };
  let reader: SessionReplyReader | null = null;
  let typedAt: number;
  // An earlier runtime stopped between "about to type" and "typed".
  let unconfirmed = false;
  let announced: InPlaceActivity | null = null;
  let unknownSince: number | null = null;
  let unverifiedSince: number | null = null;
  let notOpenReadings = 0;
  // A reading that could not establish where the session is open. It is
  // looked at again for a short while; it is never a reason to resume it.
  const unverified = (summary: string, message: string): void => {
    unverifiedSince ??= now();
    if (now() - unverifiedSince >= UNVERIFIED_GRACE_MS) throw blocked("in_place_unverified", summary, message);
  };

  if (resume && resume.phase !== "held") {
    // Already typed, or about to be when the runtime stopped. Never type again.
    place = { via: resume.via, location: resume.location };
    typedAt = resume.at;
    unconfirmed = resume.phase === "typing";
    if (input.wake) {
      if (!unconfirmed) return { output: "", delivery: { ...place, heldMs: Math.max(0, typedAt - startedAt), replySource: "none" } };
      throw blocked(
        "in_place_failed",
        `delivery into ${place.location} was interrupted.`,
        `The runtime restarted while it was typing into ${place.location}. The words may have reached the composer; check the session before sending again.`,
      );
    }
    reader = resume.transcriptOffset === null ? null : await deps.openReplyReader({
      sessionId,
      harness,
      marker: input.marker,
      cwds: input.cwds,
      fromOffset: resume.transcriptOffset,
    }).catch(() => null);
  } else for (;;) {
    // Hold until the session can take a turn, then type.
    if (!proceed()) return stopped;
    let probe: InPlaceProbe | null = null;
    try {
      probe = await deps.probe({ sessionId, harness, requireExactHarness: true });
    } catch (error) {
      // Not knowing whether the session is open is not a reason to resume it.
      unverified(
        "Scout could not check where it is open.",
        `Scout could not check where ${harness} session ${sessionId} is open (${errorText(error)}). Nothing was typed.`,
      );
    }
    if (probe && !probe.live && probe.code !== "not_live") {
      unverified(
        "the place it is open could not be verified.",
        `Scout could not verify where ${harness} session ${sessionId} is open (${probe.code}). Nothing was typed.`,
      );
      probe = null;
    }
    if (!probe) {
      notOpenReadings = 0;
      await sleep(HOLD_POLL_MS);
      continue;
    }
    if (!probe.live) {
      unverifiedSince = null;
      // Claude Code has no second-writer guard: a session running where Scout
      // cannot type must not get a second copy resumed beside it. Codex parks
      // on its own thread lock, so the caller's resume path handles it.
      if (probe.code === "not_live" && probe.held && harness === "claude") {
        throw blocked(
          "in_place_unreachable",
          "it is open where Scout cannot type.",
          `Claude session ${sessionId} is running, but not in Herdr, Orca, tmux or a terminal Scout can address. Nothing was typed and no copy was started. Close it so Scout can resume it, or open it in one of those.`,
        );
      }
      notOpenReadings += 1;
      if (harness === "claude" && notOpenReadings < NOT_OPEN_READINGS) {
        await sleep(NOT_OPEN_CONFIRM_MS);
        continue;
      }
      return handOff();
    }
    notOpenReadings = 0;
    if (probe.activity !== "idle") unverifiedSince = null;
    place = { via: probe.via, location: probe.location };
    // From here a restart finds the task and delivers it again from the start.
    if (probe.activity !== "idle" && !saved) await save({ phase: "held", since: startedAt }).catch(() => undefined);

    if (probe.activity === "idle") {
      unknownSince = null;
      reader = input.wake ? null : await deps.openReplyReader({ sessionId, harness, marker: input.marker, cwds: input.cwds });
      const words = input.wake || reader ? input.prompt : input.explicitReplyPrompt;
      // A plain terminal is typed key by key, where a newline submits.
      const body = probe.via === "lattices" ? words.split(/\s+/u).filter(Boolean).join(" ") : words;
      if (!proceed()) return stopped;
      const transcriptOffset = reader?.offset ?? null;
      const unrecorded: unknown[] = [];
      let cancelled = false;
      let delivery: InPlaceDelivery;
      try {
        delivery = await deps.deliver({
          sessionId,
          harness,
          body,
          requireExactHarness: true,
          // Written before the first keystroke: once the words may be in the
          // session, no restart types them a second time.
          beforeKeystroke: async (at) => {
            // Finding the place again takes time; an ask cancelled meanwhile is not typed.
            if (!proceed()) {
              cancelled = true;
              throw new Error("the ask was cancelled before it was typed");
            }
            try {
              await save({ phase: "typing", since: startedAt, at: now(), via: at.via, location: at.location, transcriptOffset });
            } catch (error) {
              unrecorded.push(error);
              throw error;
            }
          },
        });
      } catch (error) {
        delivery = { ok: false, code: "in_place_failed", ...place, detail: errorText(error) };
      }
      if (cancelled) return stopped;
      if (unrecorded.length > 0) {
        throw blocked(
          "in_place_failed",
          "the delivery could not be recorded.",
          `Scout could not record the delivery into ${place.location} before typing (${errorText(unrecorded[0])}). Nothing was typed.`,
        );
      }
      if (delivery.ok) {
        place = { via: delivery.via, location: delivery.location };
        const typing: InPlaceCheckpoint | null = saved;
        typedAt = typing && typing.phase === "typing" ? typing.at : now();
        // If this write is lost the task stays at "typing", which a restart
        // also treats as typed.
        await save({ phase: "typed", since: startedAt, at: typedAt, ...place, transcriptOffset }).catch(() => undefined);
        break;
      }
      if (delivery.code === "session_runtime_unobserved" || delivery.code === "session_ambiguous") {
        unverified(
          "the place it is open could not be verified.",
          `Scout could not verify where ${harness} session ${sessionId} is open (${delivery.code}). Nothing was typed.`,
        );
      } else {
        unverifiedSince = null;
      }
      const nothingSent = delivery.code === "scout_app_unavailable"
        || delivery.code === "scout_app_accessibility"
        || (delivery.code === "in_place_failed" && delivery.nothingSent === true);
      // The app that holds this thread cannot be typed into right now. Codex
      // keeps the thread locked, so the caller's own path parks the ask until
      // the app lets go.
      if (nothingSent && harness === "codex") return handOff();
      if (delivery.code === "in_place_failed" || delivery.code === "draft_unsupported" || nothingSent) {
        const detail = "detail" in delivery ? delivery.detail : delivery.code;
        throw blocked(
          "in_place_failed",
          `delivery into ${place.location} failed.`,
          `Scout could not deliver into ${place.location}: ${detail}${nothingSent ? "" : " The words may have reached the composer; check the session before asking again."}`,
        );
      }
      // busy, activity_unknown, session_blocked, not_live: the session changed
      // between the probe and the keystroke. Nothing was typed; look again.
    } else if (probe.activity === "unknown") {
      unknownSince ??= now();
      if (now() - unknownSince >= UNKNOWN_ACTIVITY_GRACE_MS) {
        throw blocked(
          "in_place_activity_unknown",
          "Scout cannot tell whether it is busy.",
          `${label} is open in ${place.location}, but neither that place nor the harness reports whether it is mid-turn. Nothing was typed.`,
        );
      }
    } else {
      unknownSince = null;
      if (announced !== probe.activity) {
        announced = probe.activity;
        await progress(probe.activity === "blocked"
          ? `${label} is waiting on a prompt in ${place.location}. The task is held until it clears.`
          : probe.activity === "composing"
            ? `${label} has unsent text in its composer in ${place.location}. The task is held until that is sent or cleared.`
            : `${label} is mid-turn in ${place.location}. The task is held until the turn ends.`);
      }
    }

    if (now() - startedAt >= holdMs) {
      throw blocked(
        "in_place_hold_expired",
        announced === "composing" ? `its composer held unsent text for ${minutes(holdMs)}.` : `it stayed busy for ${minutes(holdMs)}.`,
        announced === "composing"
          ? `${label} had unsent text in its composer in ${place.location} for ${minutes(holdMs)}. Nothing was typed.`
          : `${label} did not become idle in ${place.location} within ${minutes(holdMs)}. Nothing was typed.`,
      );
    }
    await sleep(HOLD_POLL_MS);
  }

  const heldMs = Math.max(0, typedAt - startedAt);
  const delivered = (output: string, replySource: "transcript" | "scout_reply" | "none"): InPlaceInvokeResult => ({
    output,
    delivery: { ...place, heldMs, replySource },
  });
  if (input.wake) return delivered("", "none");
  await progress(`Delivered to ${label} in ${place.location}. Waiting for its reply.`);

  // Watch for the answer: the transcript's, or one the session posts itself.
  // Counted from when the words were typed, so a restart does not extend it.
  const deadline = typedAt + replyWaitMs;
  let nextExplicitAt = now();
  let nextHolderAt = now() + HOLDER_POLL_MS;
  let idle = false;
  let sizeAtHolderPoll = reader?.size() ?? 0;
  let closedReadings = 0;
  let quietUnconfirmed = 0;
  for (;;) {
    if (!proceed()) return delivered("", "none");
    if (deps.explicitReply && now() >= nextExplicitAt) {
      nextExplicitAt = now() + EXPLICIT_REPLY_POLL_MS;
      const reply = await deps.explicitReply().catch(() => null);
      if (reply !== null) return delivered(reply, "scout_reply");
    }
    if (reader) {
      const reply = await reader.read({ idle });
      if (reply.state === "answered") return delivered(reply.text, "transcript");
      if (reply.state === "aborted") {
        throw blocked(
          "in_place_turn_aborted",
          "its turn was interrupted before it answered.",
          `The ask was typed into ${place.location}, and that turn was interrupted before ${label} answered.`,
        );
      }
      if (reply.accepted) unconfirmed = false;
    }
    if (now() >= nextHolderAt) {
      nextHolderAt = now() + HOLDER_POLL_MS;
      // A failed read says nothing; only two clean "not open" readings count.
      const state = await deps.holderState(sessionId, harness).catch(() => null);
      closedReadings = state && !state.live ? closedReadings + 1 : 0;
      // The harness's idle report counts only once the transcript has stopped
      // growing, so a report read just before the turn began cannot end it.
      const size = reader?.size() ?? 0;
      idle = Boolean(state?.idle) && size === sizeAtHolderPoll;
      sizeAtHolderPoll = size;
      if (closedReadings >= 2) {
        const last = reader ? await reader.read({ idle: true }) : null;
        if (last?.state === "answered") return delivered(last.text, "transcript");
        throw blocked(
          "in_place_session_closed",
          "it was closed before it answered.",
          `The ask was typed into ${place.location}, and ${label} was closed before it answered.`,
        );
      }
      // The keystroke was interrupted by a restart, and the session sits idle
      // with a transcript that never recorded the words: they started no turn.
      quietUnconfirmed = unconfirmed && reader && idle ? quietUnconfirmed + 1 : 0;
      if (quietUnconfirmed >= UNCONFIRMED_QUIET_READINGS) {
        throw blocked(
          "in_place_failed",
          `delivery into ${place.location} was interrupted.`,
          `The runtime restarted while it was typing into ${place.location}, and ${label} did not take the words as a turn. They may be in the composer; check the session before sending again.`,
        );
      }
    }
    if (now() >= deadline) throw new RequesterWaitTimeoutError({ label, timeoutMs: replyWaitMs });
    await sleep(REPLY_POLL_MS);
  }
}
