import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexThreadHeldByChatGPTApp } from "./deliver.js";
import { execSystemFile } from "../system-probes/exec.js";

export type NativeAppThread = {
  sessionId: string;
  harness: "codex";
  title: string;
  cwd: string | null;
  location: "native_codex_app";
  deliveryModes: readonly ["draft", "submit"];
};
export type NativeThreadInventory = { threads: NativeAppThread[]; available: boolean; truncated: boolean };
export type NativeThreadDeps = {
  listLocks: () => Promise<string[]>;
  heldByApp: (id: string) => Promise<boolean>;
  metadata: (id: string) => Promise<{ cwd?: string; title?: string }>;
};

/** Read-only live evidence, independent of the optional transcript search index. */
export async function readNativeAppThreads(overrides: Partial<NativeThreadDeps> = {}): Promise<NativeThreadInventory> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const deps: NativeThreadDeps = {
    listLocks: () => readdir(join(home, "thread-writer-locks")),
    heldByApp: codexThreadHeldByChatGPTApp,
    metadata: async (id) => {
      const { stdout } = await execSystemFile("find", [join(home, "sessions"), "-name", `rollout-*-${id}.jsonl`, "-print", "-quit"], { timeoutMs: 3000, maxStdoutBytes: 4096 });
      if (!stdout.trim()) return {};
      const file = await open(stdout.trim(), "r");
      try {
        const buffer = Buffer.alloc(16_384);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
        const payload = JSON.parse(first || "{}").payload;
        return { cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined };
      } finally { await file.close(); }
    },
    ...overrides,
  };
  let ids: string[];
  try { ids = [...new Set((await deps.listLocks()).filter(name => /^[0-9a-f-]{16,}\.lock$/iu.test(name)).map(name => name.slice(0, -5)))].sort(); }
  catch { return { threads: [], available: false, truncated: false }; }
  const threads: NativeAppThread[] = [];
  let available = true;
  // Bound process probes; advertise truncation rather than implying absence.
  for (let start = 0; start < Math.min(ids.length, 128); start += 8) {
    await Promise.all(ids.slice(start, Math.min(start + 8, 128)).map(async sessionId => {
      let held: boolean;
      try { held = await deps.heldByApp(sessionId); } catch { available = false; return; }
      if (!held) return; // Lock files can outlive their writers.
      const meta = await deps.metadata(sessionId).catch(() => ({} as { cwd?: string; title?: string }));
      threads.push({ sessionId, harness: "codex", title: meta.title || `Native Codex thread ${sessionId}`, cwd: meta.cwd ?? null, location: "native_codex_app", deliveryModes: ["draft", "submit"] });
    }));
  }
  return { threads: threads.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), available, truncated: ids.length > 128 };
}
