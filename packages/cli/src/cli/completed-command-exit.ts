/**
 * Which one-shot commands end the process once they have answered.
 *
 * A command that probes other hosts can leave work the runtime cannot cancel:
 * Bun.connect has no abort, so a TLS probe still dialling an unreachable route
 * keeps the process alive until the OS connect timeout (75s on macOS) even
 * though the answer was printed after the 3s per-host deadline. These commands
 * exit as soon as their output is flushed.
 */
const EXIT_AFTER_ANSWER = new Set([
  "ask",
  // Commands that fan out to every host through mesh node-state.
  "hosts",
  "check",
  "locate",
]);

export function shouldExitAfterCommand(command: string | null, args: readonly string[]): boolean {
  if (!command) {
    return false;
  }
  if (EXIT_AFTER_ANSWER.has(command)) {
    return true;
  }
  // A tracked send runs the ask lifecycle and exits like ask.
  return command === "send" && args.includes("--tracked");
}

type Flushable = { write(chunk: string, callback: (error?: Error | null) => void): boolean };

/** Resolves once everything already written to the stream has been handed off. */
export function flushed(stream: Flushable): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Exit after stdout and stderr have flushed, so a large --json answer on a
 * pipe is never cut short by the exit.
 */
export async function exitAfterCompletedCommand(
  command: string | null,
  args: readonly string[] = [],
  io: { stdout: Flushable; stderr: Flushable; exit: (code: number) => void; exitCode: () => number | undefined } = {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
    exitCode: () => (typeof process.exitCode === "number" ? process.exitCode : undefined),
  },
): Promise<void> {
  if (!shouldExitAfterCommand(command, args)) {
    return;
  }
  await Promise.all([flushed(io.stdout), flushed(io.stderr)]);
  io.exit(io.exitCode() ?? 0);
}
