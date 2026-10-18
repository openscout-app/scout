// Reply from the phone to a harness session Scout did not start (seen in the
// transcript tail: session id, harness, cwd). A session open somewhere gets
// the words where it runs — its Herdr pane, its Orca terminal, its tmux pane, or its terminal tab
// (see @openscout/runtime/in-place). Only a session nothing holds is resumed, as an
// exact-session ask. Replies never split off into a fork or a background copy.

import type { ScoutSessionInputReceipt } from "@openscout/protocol";

import type { ScoutAskResult, askScoutQuestion } from "../broker/service.ts";

export type MobileAskSessionInput = {
  sessionId: string;
  harness?: string | null;
  cwd?: string | null;
  body: string;
  clientMessageId?: string | null;
};

export type MobileAskSessionResult =
  | {
      ok: true;
      /**
       * "resumed" when the reply reached the session itself — typed into the
       * place it runs (see `delivery`) or resumed because nothing held it.
       * "forked" only from an older broker path; this route no longer forks.
       */
      mode: "resumed" | "forked";
      /** "in_place" when the words were typed into the live session. */
      delivery?: "in_place" | "resumed";
      /** How it got in: herdr, orca, tmux, lattices or scout-app. */
      via?: ScoutSessionInputReceipt["via"];
      /** Where, in the operator's words: "Herdr scout · w1:p1". */
      location?: string;
      /** The session the reply actually went to (the fork's id when forked). */
      sessionId: string;
      /** The session the phone asked for. */
      sourceSessionId: string;
      conversationId?: string;
      flightId?: string;
      messageId?: string;
    }
  | { ok: false; code: string; message: string };

export type MobileAskSessionDeps = {
  ask: typeof askScoutQuestion;
  senderId: string;
  /** Sender context when the phone sends no cwd. */
  fallbackCurrentDirectory?: string;
  /** Recorded on the ask; defaults to the phone. */
  source?: string;
};

const REFUSAL_MESSAGES: Record<string, string> = {
  empty_body: "Type a reply before sending.",
  request_id_required: "Update the app on this device before sending this reply.",
  session_input_unsupported: "Update Scout on this Mac before sending replies into open sessions.",
  delivery_unconfirmed: "Scout could not confirm whether this reply was submitted. Keep this reply and retry it here.",
  request_outcome_unknown: "This reply may have been submitted. Keep this reply while Scout checks the outcome; do not send a new copy.",
  broker_unavailable: "Scout isn't running on this Mac, so nothing was sent.",
  session_unknown: "Scout couldn't find this session on this Mac.",
  session_ambiguous_harness: "More than one kind of session uses this id, so nothing was sent.",
  session_ambiguous: "This session is open in more than one place, so nothing was sent.",
  session_cwd_conflict: "This session belongs to a different folder than the one sent with the reply.",
  session_not_resumable: "This session can't be continued from Scout.",
  session_live_unbound: "This session is open in a terminal Scout can't reach (not in Herdr, Orca, tmux or a terminal tab Lattices can type into), so nothing was sent.",
  session_live_fork_unsupported: "This Codex session is open in another app. Close it there, then send again.",
  session_runtime_unobserved: "Scout couldn't check whether this session is still open, so nothing was sent.",
  session_wake_failed: "Scout couldn't start this session, so nothing was sent.",
  session_fork_unroutable: "Scout couldn't start a copy of this session, so nothing was sent.",
  session_blocked: "This session is waiting on a prompt in its terminal. Answer that first, then send again.",
  in_place_failed: "Scout could not confirm whether input reached this session. Keep this reply; do not send a new copy.",
  scout_app_unavailable: "This session is open in the ChatGPT app. Send the reply there, or use Scout's draft mode on this Mac; nothing was sent.",
  scout_app_accessibility: "Scout.app has no Accessibility permission. Use draft mode on this Mac and send manually; nothing was sent.",
  delivery_failed: "Scout couldn't deliver this reply.",
};

export function mobileAskSessionRefusal(code: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message: REFUSAL_MESSAGES[code] ?? REFUSAL_MESSAGES.delivery_failed! };
}

export async function askMobileHarnessSession(
  input: MobileAskSessionInput,
  deps: MobileAskSessionDeps,
): Promise<MobileAskSessionResult> {
  const sessionId = input.sessionId.trim();
  const harness = input.harness?.trim() ?? "";
  const body = input.body.trim();
  if (!body) return mobileAskSessionRefusal("empty_body");
  if (!sessionId) return mobileAskSessionRefusal("session_unknown");

  if (!input.clientMessageId?.trim()) return mobileAskSessionRefusal("request_id_required");
  if (harness !== "claude" && harness !== "codex") return mobileAskSessionRefusal("session_not_resumable");

  // The broker reserves one durable command before typing or resuming.
  const cwd = input.cwd?.trim() || undefined;
  let result: ScoutAskResult;
  try {
    result = await deps.ask({
      senderId: deps.senderId,
      target: {
        kind: "session_id",
        sessionId,
        harness,
        // After a definite not-live result, a concurrent Codex writer must
        // still be refused: a reply never splits the session.
        // Codex keeps the flag because its fork-if-live path only ever
        // refuses (a thread open in another Codex app); without it the
        // broker would resume a second writer on that thread.
        forkIfLive: harness === "codex",
      },
      body,
      sessionDelivery: "in_place_or_resume",
      clientMessageId: input.clientMessageId ?? null,
      // Sender-context only: the broker wakes the session in the cwd recorded
      // in its own transcript, not this directory.
      currentDirectory: cwd ?? deps.fallbackCurrentDirectory,
      source: deps.source ?? "scout-mobile",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = ["request_id_required", "session_input_unsupported", "request_outcome_unknown"]
      .find(candidate => detail.includes(candidate));
    return mobileAskSessionRefusal(code ?? "delivery_unconfirmed");
  }

  if (!result.usedBroker) return mobileAskSessionRefusal("broker_unavailable");
  if (!result.conversationId || result.unresolvedTarget !== undefined) {
    const diagnostic = result.targetDiagnostic;
    const code = diagnostic && "sessionWakeReason" in diagnostic && diagnostic.sessionWakeReason
      ? diagnostic.sessionWakeReason
      : "delivery_failed";
    return mobileAskSessionRefusal(code);
  }

  if (result.inputSubmitted) {
    const submitted = result.inputSubmitted;
    if (submitted.kind !== "in_place" || submitted.state !== "submitted" || submitted.sessionId !== sessionId || submitted.harness !== harness) {
      return mobileAskSessionRefusal("delivery_unconfirmed");
    }
    return { ok: true, mode: "resumed", delivery: "in_place", via: submitted.via, location: submitted.location,
      sessionId, sourceSessionId: sessionId, conversationId: result.conversationId, messageId: result.messageId };
  }
  if (!result.flight?.id) return mobileAskSessionRefusal("delivery_unconfirmed");
  const deliveredSessionId = result.targetSessionId?.trim() || sessionId;
  return {
    ok: true,
    mode: deliveredSessionId === sessionId ? "resumed" : "forked",
    delivery: "resumed",
    sessionId: deliveredSessionId,
    sourceSessionId: sessionId,
    conversationId: result.conversationId,
    ...(result.flight?.id ? { flightId: result.flight.id } : {}),
    ...(result.messageId ? { messageId: result.messageId } : {}),
  };
}
