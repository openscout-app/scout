#!/usr/bin/env bun
// Readiness check for a Vercel team board, through the same Board worker the
// broker runs. It prints one JSON readiness result. It never prints, logs or
// reads the token: `secret run` puts it in the worker's environment only.
//
//   SCOUT_VERCEL_BOARD_NODE=<node 24> bun packages/runtime/scripts/vercel-board-smoke.ts \
//     --team <team ID or slug> [--board scout|General] --credential secret_cli:<entry> \
//     [--channels scout/work,scout/decisions] [--probe-channel scout/probe] [--no-probe]
//
// It finds the board by name as the person (and makes it only if it is not
// there and the plan allows), then narrows to the channels. On a plan with one
// board, name it: --board General. With the probe (the default), it makes the
// channels, then creates, claims and completes one task in the probe channel.
import { VERCEL_BOARD_DEFAULT_BOARD, isVercelBoardChannelPath, vercelBoardCanHeader, validateVercelBoardCredentialReference, validateVercelBoardVercelTarget, type VercelBoardCredentialReference } from "@openscout/protocol";
import { VercelBoardHttpError, VercelBoardUnknownOutcomeError } from "../src/vercel-board/client.js";
import { VERCEL_BOARD_DEFAULT_CHANNELS, VERCEL_BOARD_DEFAULT_PROBE_CHANNEL } from "../src/vercel-board/connection.js";
import { VercelBoardCredential } from "../src/vercel-board/credential.js";
import { VercelBoardWorkerError, VercelBoardWorkerSupervisor, VercelBoardWorkerTransport, checkVercelBoardWorkerNode } from "../src/vercel-board/worker.js";

const USAGE = "Usage: bun packages/runtime/scripts/vercel-board-smoke.ts --team <team> [--board scout|General] --credential secret_cli:<entry> [--channels scout/work,scout/decisions] [--probe-channel scout/probe] [--no-probe]";

function parse(argv: string[]) {
  const flags: Record<string, string> = {};
  let probe = true;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--no-probe") { probe = false; continue; }
    if (!["--team", "--board", "--credential", "--channels", "--probe-channel"].includes(flag)) throw new Error(`Unknown option ${flag}. ${USAGE}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value. ${USAGE}`);
    flags[flag] = value;
  }
  const target = { team: flags["--team"] ?? "", board: flags["--board"] ?? VERCEL_BOARD_DEFAULT_BOARD };
  const targetErrors = validateVercelBoardVercelTarget(target);
  if (targetErrors.length) throw new Error(`${targetErrors.join("; ")}. ${USAGE}`);
  const raw = flags["--credential"] ?? "";
  const index = raw.indexOf(":");
  const credential = { backend: raw.slice(0, index), key: raw.slice(index + 1) } as VercelBoardCredentialReference;
  const credentialErrors = validateVercelBoardCredentialReference(credential);
  if (index < 1 || credentialErrors.length) throw new Error(`--credential takes secret_cli:<entry>, env:<NAME> or file:<path>; never the token. ${USAGE}`);
  const channels = flags["--channels"] ? flags["--channels"].split(",").map((c) => c.trim()).filter(Boolean) : VERCEL_BOARD_DEFAULT_CHANNELS;
  const probeChannel = flags["--probe-channel"] ?? VERCEL_BOARD_DEFAULT_PROBE_CHANNEL;
  for (const channel of [...channels, probeChannel]) {
    if (!isVercelBoardChannelPath(channel)) throw new Error(`${channel} is not a Board channel path: lower-case segments joined by /, such as scout/work. ${USAGE}`);
  }
  if (channels.includes(probeChannel)) throw new Error(`The probe channel ${probeChannel} must not be a followed channel. ${USAGE}`);
  return { target, credential, probe, channels, probeChannel };
}

async function main(): Promise<number> {
  let step = "arguments";
  const result: Record<string, unknown> = { ready: false };
  try {
    const { target, credential, probe, channels: CHANNELS, probeChannel: PROBE_CHANNEL } = parse(process.argv.slice(2));
    Object.assign(result, { team: target.team, board: target.board, credential: `${credential.backend}:${credential.backend === "file" ? "<file>" : credential.key}` });
    step = "node";
    const node = process.env.SCOUT_VERCEL_BOARD_NODE ?? "node";
    result.node = await checkVercelBoardWorkerNode(node);
    const reader = new VercelBoardCredential(credential);
    const worker = new VercelBoardWorkerSupervisor({
      target: { kind: "vercel", ...target }, profile: "scout", can: vercelBoardCanHeader({ channels: CHANNELS, probeChannel: PROBE_CHANNEL }),
      credential, readToken: () => reader.token(),
    }, { node });
    const transport = new VercelBoardWorkerTransport(worker);
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
    if (error instanceof VercelBoardHttpError) Object.assign(result, { status: error.status, code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
    else if (error instanceof VercelBoardUnknownOutcomeError) Object.assign(result, { code: "outcome_unknown", message: error.message });
    else if (error instanceof VercelBoardWorkerError) Object.assign(result, { code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}) });
    else Object.assign(result, { code: (error as { code?: string }).code ?? "error", message: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    if (result.status === 401) result.fix = "Create a new Vercel access token and store it with: secret set <entry>";
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ready ? 0 : 1;
}

process.exit(await main());
