#!/usr/bin/env bun
// Readiness check for a Vercel team board, through the same Board worker the
// broker runs. It prints one JSON readiness result. It never prints, logs or
// reads the token: `secret run` puts it in the worker's environment only.
//
//   SCOUT_BOARD_NODE=<node 24> bun packages/runtime/scripts/board-vercel-smoke.ts \
//     --team <team ID or slug> [--board scout] --credential secret_cli:<entry> [--no-probe]
//
// With the probe (the default), it makes or finds the board, makes the
// channels work, decisions and scout-probe, then creates, claims and
// completes one task in scout-probe.
import { BOARD_DEFAULT_VERCEL_BOARD, boardCanHeader, validateBoardCredentialReference, validateBoardVercelTarget, type BoardCredentialReference } from "@openscout/protocol";
import { BoardHttpError, BoardUnknownOutcomeError } from "../src/board/client.js";
import { BoardCredential } from "../src/board/credential.js";
import { BoardWorkerError, BoardWorkerSupervisor, BoardWorkerTransport, checkBoardWorkerNode } from "../src/board/worker.js";

const USAGE = "Usage: bun packages/runtime/scripts/board-vercel-smoke.ts --team <team> [--board scout] --credential secret_cli:<entry> [--no-probe]";
const CHANNELS = ["work", "decisions"];
const PROBE_CHANNEL = "scout-probe";

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  let probe = true;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--no-probe") { probe = false; continue; }
    if (!["--team", "--board", "--credential"].includes(flag)) throw new Error(`Unknown option ${flag}. ${USAGE}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value. ${USAGE}`);
    flags[flag] = value;
  }
  const target = { team: flags["--team"] ?? "", board: flags["--board"] ?? BOARD_DEFAULT_VERCEL_BOARD };
  const targetErrors = validateBoardVercelTarget(target);
  if (targetErrors.length) throw new Error(`${targetErrors.join("; ")}. ${USAGE}`);
  const raw = flags["--credential"] ?? "";
  const index = raw.indexOf(":");
  const credential = { backend: raw.slice(0, index), key: raw.slice(index + 1) } as BoardCredentialReference;
  const credentialErrors = validateBoardCredentialReference(credential);
  if (index < 1 || credentialErrors.length) throw new Error(`--credential takes secret_cli:<entry>, env:<NAME> or file:<path>; never the token. ${USAGE}`);
  return { target, credential, probe };
}

async function main(): Promise<number> {
  let step = "arguments";
  const result: Record<string, unknown> = { ready: false };
  try {
    const { target, credential, probe } = parse(process.argv.slice(2));
    Object.assign(result, { team: target.team, board: target.board, credential: `${credential.backend}:${credential.backend === "file" ? "<file>" : credential.key}` });
    step = "node";
    const node = process.env.SCOUT_BOARD_NODE ?? "node";
    result.node = await checkBoardWorkerNode(node);
    const reader = new BoardCredential(credential);
    const worker = new BoardWorkerSupervisor({
      target: { kind: "vercel", ...target }, profile: "scout", can: boardCanHeader({ channels: CHANNELS, probeChannel: PROBE_CHANNEL }),
      credential, readToken: () => reader.token(),
    }, { node });
    const transport = new BoardWorkerTransport(worker);
    try {
      step = "worker";
      await worker.start();
      step = "me";
      const me = await transport.me();
      Object.assign(result, { principal: me.principal, actor: me.actor, profile: me.profile });
      step = "channels";
      const channels: string[] = [];
      for (const channel of [...CHANNELS, PROBE_CHANNEL]) { await transport.ensureChannel(channel); channels.push(channel); }
      result.channels = channels;
      if (probe) {
        step = "probe";
        const task = await transport.createTask({ channel: PROBE_CHANNEL, text: "Scout readiness probe. Scout claims and completes this task.", id: `scout-smoke-${Date.now().toString(36)}`, labels: { "scout.agent": "scout" } });
        const claimed = await transport.claim(task.id, 60);
        const done = await transport.complete(task.id, claimed.claim, "Scout readiness verified.");
        result.probe = { taskId: task.id, state: done.task?.state ?? "unknown" };
      }
      result.ready = !probe || (result.probe as { state?: string }).state === "completed";
      step = "done";
    } finally {
      worker.stop();
    }
  } catch (error) {
    result.step = step;
    if (error instanceof BoardHttpError) Object.assign(result, { status: error.status, code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
    else if (error instanceof BoardUnknownOutcomeError) Object.assign(result, { code: "outcome_unknown", message: error.message });
    else if (error instanceof BoardWorkerError) Object.assign(result, { code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}) });
    else Object.assign(result, { code: (error as { code?: string }).code ?? "error", message: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    if (result.status === 401) result.fix = "Create a new Vercel access token and store it with: secret set <entry>";
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ready ? 0 : 1;
}

process.exit(await main());
