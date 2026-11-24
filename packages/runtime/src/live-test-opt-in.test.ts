import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = join(import.meta.dir, "..");
const files = ["src/opencode-acp-live.test.ts", "src/codex-app-server-live.test.ts"];

test("package unit selection includes nested tests and scenarios but excludes every live file", () => {
  const pkg = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8"));
  expect(pkg.scripts.test.split(" && ")).toEqual([
    "bun test ./src --path-ignore-patterns='**/*live.test.ts'",
    "bun run test:mesh-facade:node",
  ]);
  expect(pkg.scripts["test:live:opencode-acp"]).toContain("OPENSCOUT_LIVE_OPENCODE_ACP=1");
  expect(pkg.scripts["test:live:codex-app-server"]).toContain("OPENSCOUT_LIVE_CODEX_APP_SERVER=1");
});

test("root and hosted CI delegate runtime selection to the scenario-inclusive package script", () => {
  const root = join(runtime, "..", "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const command = "bun run --cwd packages/runtime test";
  expect(pkg.scripts["test:unit:source"].split(" && ").filter((part: string) => part.includes("packages/runtime"))).toEqual([command]);
  const workflow = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  expect(workflow).toContain("            bun run test:unit:source");
  expect(workflow.split("\n").filter((line: string) => line.trim() === command)).toHaveLength(1);
  expect(workflow).not.toContain("--path-ignore-patterns='**/scenario-suite.test.ts'");
});

test("direct live files refuse credentials and target settings without exact opt-in", async () => {
  const home = mkdtempSync(join(tmpdir(), "scout-live-opt-in-"));
  const marker = join(home, "harness-launched");
  const bin = join(home, "fake-opencode");
  writeFileSync(bin, `#!/bin/sh\nprintf 'unexpected' >> '${marker}'\nexit 79\n`, { mode: 0o755 });
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), "{}");
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { connections++; return new Response("unexpected live connection", { status: 403 }); } });
  try {
    for (const optIn of [undefined, "0", "true"]) {
      const env = { ...process.env, HOME: home, OPENCODE_API_KEY: "test-only-key", OPENCODE_BIN: bin,
        OPENSCOUT_CODEX_APP_SERVER_URL: `ws://127.0.0.1:${server.port}`, OPENSCOUT_CODEX_THREAD_ID: "test-only-thread",
        OPENSCOUT_LIVE_OPENCODE_ACP: optIn, OPENSCOUT_LIVE_CODEX_APP_SERVER: optIn };
      const child = Bun.spawn([process.execPath, "test", ...files], { cwd: runtime, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 5_000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0); expect(out + err).toContain("2 skip");
        expect(existsSync(marker)).toBe(false); expect(connections).toBe(0);
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
    }
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("exact opt-in reaches owned OpenCode/Codex stubs, never a real harness or upstream", async () => {
  const home = mkdtempSync(join(tmpdir(), "scout-live-opted-in-"));
  const marker = join(home, "fake-opencode-started");
  const bin = join(home, "fake-opencode");
  writeFileSync(bin, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'fake only');
let input = '';
for await (const chunk of Bun.stdin.stream()) {
 input += new TextDecoder().decode(chunk);
 const end = input.indexOf('\\n');
 if (end < 0) continue;
 const request = JSON.parse(input.slice(0, end));
 await Bun.write(Bun.stdout, JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'fixture refuses live initialization'}})+'\\n');
 break;
}
`, { mode: 0o755 });
  const methods: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, host) { if (host.upgrade(request)) return; return new Response("not found", { status: 404 }); },
    websocket: { message(socket, data) {
      const request = JSON.parse(String(data)); methods.push(request.method);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture refuses live initialization" } }));
    } },
  });
  try {
    for (const file of files) {
      const child = Bun.spawn([process.execPath, "test", file], { cwd: runtime, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, HOME: home, OPENCODE_API_KEY: "test-only-key", OPENCODE_BIN: bin,
          OPENSCOUT_LIVE_OPENCODE_ACP: "1", OPENSCOUT_LIVE_CODEX_APP_SERVER: "1",
          OPENSCOUT_CODEX_APP_SERVER_URL: `ws://127.0.0.1:${server.port}`, OPENSCOUT_CODEX_THREAD_ID: "fake-thread" },
      });
      const timer = setTimeout(() => child.kill(), 3_000);
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(1); expect(out + err).toContain("fixture refuses live initialization");
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
    }
    expect(existsSync(marker)).toBe(true);
    expect(methods).toEqual(["initialize"]);
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
