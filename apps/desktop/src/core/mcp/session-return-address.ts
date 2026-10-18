export type SessionReturnAddress = { sessionId: string; harness: "codex" | "claude" };

/** Only process-owned identity, never a guess from project/title or transcript prose. */
export function currentSessionReturnAddress(env: NodeJS.ProcessEnv): SessionReturnAddress | null {
  const codex = env.CODEX_THREAD_ID?.trim();
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (Boolean(codex) === Boolean(claude)) return null; // Missing or ambiguous host identity.
  const sessionId = codex || claude!;
  if (!/^[A-Za-z0-9_-]{8,200}$/u.test(sessionId)) return null;
  return { sessionId, harness: codex ? "codex" : "claude" };
}

/** Explicit opt-in on direct typed requests. This is not a forged broker reply context. */
export function stampSessionReturnAddress(text: string, address: SessionReturnAddress): string {
  const fields = JSON.stringify(address);
  return `${text}\n\n[Scout direct-request return address]\n${fields}\nThis is a direct typed request, not broker-tracked work. Reply to this exact session with session_send. For a native Codex app thread, use harness=codex and mode=draft to fill its composer without sending. Do not start a replacement session or guess a broker reply context. A draft is not a recorded user turn.\n[/Scout direct-request return address]`;
}
