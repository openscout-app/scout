import {afterAll, afterEach, expect, test} from "bun:test";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync, statSync, utimesSync, linkSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {pairingTrustOwner} from "../packages/runtime/src/pairing-security/trust-owner.ts";
import {loadOrCreateNodeIdentity} from "../packages/runtime/src/node-identity.ts";
import {legacyFixture} from "./fixtures/pairing-capsule.ts";
import {CUT_DIRECTORY, RESERVATION_BYTES} from "../packages/runtime/src/pairing-security/trust-cutover.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const worker = join(project, "scripts/pairing-cutover-worker.ts");
const roots: string[] = [], removers: (() => void)[] = [];
const support=mkdtempSync(join(tmpdir(),"pairing-cutover-host-")), priorSupport=process.env.OPENSCOUT_SUPPORT_DIRECTORY;
process.env.OPENSCOUT_SUPPORT_DIRECTORY=support;loadOrCreateNodeIdentity(support);
afterAll(()=>{if(priorSupport===undefined)delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;else process.env.OPENSCOUT_SUPPORT_DIRECTORY=priorSupport;rmSync(support,{recursive:true,force:true});});
function fixture(managed = false) {
  const parent = mkdtempSync(join(tmpdir(), "pairing-capsule-process-")); roots.push(parent);
  const data = join(parent, "pairing-capsule-data"), coordination = join(parent, "coordination");
  mkdirSync(data, {mode: 0o700}); mkdirSync(coordination);
  const f = legacyFixture(data, {bindHost:true, factory: pairingTrustOwner, generations: 3, keys: 2, prepare: managed ? owner => {
    let holder: object | null = null;
    removers.push(owner.register({id: "cutover.test", withGate(_r, body) {holder = {}; try {return body(holder);} finally {holder = null;}}, currentHolder() {return holder;}}));
    owner.mutate(3, "managed", {type: "manage"});
  } : undefined});
  return {...f, data, coordination, revision: managed ? 4 : 3};
}
function launch(mode: string, f: ReturnType<typeof fixture>, options: object = {}) {
  return Bun.spawn([process.execPath, "--no-install", worker, mode, f.data, f.coordination, JSON.stringify(options)], {
    cwd: project, env: {...process.env, HOME: dirname(f.data), OPENSCOUT_HOME: join(dirname(f.data), "home"),
      OPENSCOUT_CONTROL_HOME: join(dirname(f.data), "control"), OPENSCOUT_PAIRING_HOME: f.data}, stdout: "pipe", stderr: "pipe",
  });
}
async function result(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {code, stderr, value: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)!) : null};
}
async function ready(f: ReturnType<typeof fixture>, child: ReturnType<typeof launch>, point: string) {
  const deadline = Date.now() + 30000;
  while (!existsSync(join(f.coordination, `ready-${point}`))) {
    if (child.exitCode !== null || Date.now() > deadline) throw Error(`worker did not reach ${point}`);
    await Bun.sleep(5);
  }
}
const go = (f: ReturnType<typeof fixture>) => writeFileSync(join(f.coordination, "go"), "go");
const trace = (f: ReturnType<typeof fixture>) => readFileSync(join(f.coordination, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const legacyNames = (f: ReturnType<typeof fixture>) => readdirSync(f.data).filter(n => n.startsWith("trusted-peers.owner."));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(() => {for (const remove of removers.splice(0)) remove(); for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true});});

test("before CAS v1 remains authority, private stages never grant, and no age takeover occurs", async () => {
  for (const point of ["after-claim", "after-reservation", "after-staging"]) {
    const f = fixture(), output = await result(launch("cut", f, {point, revision: f.revision}));
    expect(output.code, point).toBe(81);
    expect((await result(launch("old-read", f))).value).toMatchObject({ok: true, snapshot: {revision: f.revision}});
    expect((await result(launch("read", f))).value).toMatchObject({ok: true, snapshot: {revision: f.revision}});
    expect(readdirSync(f.data).filter(n => n.startsWith("trusted-peers.v2."))).toEqual([]);
    utimesSync(join(f.data, CUT_DIRECTORY), 0, 0);
    expect((await result(launch("cut", f))).value.error).toContain("migration_busy");
    console.log(JSON.stringify({cutoverRow: "before-cas", point, events: trace(f)}));
  }
}, 60000);

test("the full 320 MiB reservation precedes bulk staging and failed allocation publishes nothing", async () => {
  const f = fixture(), child = launch("cut", f, {point: "before-cas", revision: f.revision});
  let completed: Awaited<ReturnType<typeof result>>;
  try {
    await ready(f, child, "before-cas");
    const events = trace(f), allocated = events.filter(e => e.event === "allocated");
    expect(allocated).toHaveLength(320);
    expect(allocated.reduce((n, e) => n + e.bytes, 0)).toBe(RESERVATION_BYTES);
    expect(allocated.every(e => e.physicalBytes >= e.bytes)).toBe(true);
    const firstBulk = events.findIndex(e => e.event === "rename" && e.source.includes("/reserve."));
    expect(events.slice(0, firstBulk).filter(e => e.event === "allocated")).toHaveLength(320);
    const privateBytes = readdirSync(join(f.data, CUT_DIRECTORY)).reduce((n, name) => n + statSync(join(f.data, CUT_DIRECTORY, name)).size, 0);
    expect(privateBytes).toBeLessThanOrEqual(RESERVATION_BYTES);
    expect((await result(launch("read", f))).value).toMatchObject({ok: true, snapshot: {revision: f.revision}});
  } finally {go(f); completed = await result(child);}
  expect(completed!.value.ok).toBe(true);
  expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(false);
  const events = trace(f), linked = events.findIndex(e => e.event === "link");
  const retired = events.map((e, i) => e.event === "unlink" && e.path.includes("/trusted-peers.owner.") ? i : -1).filter(i => i >= 0);
  const receipt = events.findIndex(e => e.event === "rename" && e.target.endsWith("/trusted-peers.v2.cutover.json") && !e.target.includes("/.pairing-cutover/"));
  const cleanup = events.findIndex(e => e.event === "unlink" && e.path.includes("/.pairing-cutover/"));
  const synced = (start: number, end: number) => events.slice(start + 1, end).some(e => e.event === "sync_success" && e.path.endsWith("/pairing-capsule-data"));
  expect(retired).toHaveLength(f.revision);
  expect(synced(linked, retired[0]!)).toBe(true);
  expect(synced(retired.at(-1)!, receipt)).toBe(true);
  expect(synced(receipt, cleanup)).toBe(true);
  const failed = fixture(), output = await result(launch("cut", failed, {point: "reservation-exhaustion"}));
  expect(output.value.ok).toBe(false); expect(output.value.code).toBe("ENOSPC");
  expect(trace(failed).some(e => e.event === "reservation_failure")).toBe(true);
  expect(trace(failed).filter(e => e.event === "rename" || e.event === "link")).toEqual([]);
  expect(existsSync(join(failed.data, CUT_DIRECTORY))).toBe(false);
  expect(failed.owner.read().revision).toBe(failed.revision);
  console.log(JSON.stringify({cutoverRow: "reservation-and-barriers", events, failedAllocation: output, failureEvents: trace(failed)}));
}, 60000);

test("barrier and partial-retirement interruptions recover with real old-reader and writer refusal", async () => {
  for (const managed of [false, true]) for (const point of ["after-cas", "uncertain-cas", "after-barrier-sync", "during-retirement", "after-retirement"]) {
    const f = fixture(managed), stamp = f.owner.pairingAuthorityStamp();
    const crashed = await result(launch("cut", f, {point, managed, revision: f.revision}));
    if (point === "uncertain-cas") expect(crashed.value.ok).toBe(false); else expect(crashed.code, point).toBe(81);
    for (const mode of ["old-read", "old-write"]) {
      const refused = await result(launch(mode, f, {managed, revision: f.revision}));
      expect(refused.value.ok, `${point}:${mode}`).toBe(false);
      expect(refused.value.error).toMatch(/generation_(checksum|gap|invalid)|capacity/);
    }
    const recovered = await result(launch("read", f, {managed}));
    expect(recovered.value, `${managed}:${point}:${recovered.stderr}`).toMatchObject({ok: true, snapshot: {revision: f.revision}});
    expect(f.owner.pairingAuthorityStamp()).toBe(stamp);
    expect((await result(launch("cut", f, {managed}))).value).toMatchObject({ok: true, result: {revision: f.revision}});
    for (const mode of ["old-read", "old-write"]) {
      const refused = await result(launch(mode, f, {managed, revision: f.revision}));
      expect(refused.value.ok).toBe(false); expect(refused.value.error).toMatch(/generation_(checksum|gap|invalid)|capacity/);
    }
    expect(legacyNames(f)).toEqual([`trusted-peers.owner.${f.revision + 1}.json`]);
    expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(false);
    console.log(JSON.stringify({cutoverRow: "barrier-or-partial-retirement", managed, point, events: trace(f)}));
  }
}, 60000);

test("absent or corrupt capsule and retirement evidence refuses before deleting legacy authority", async () => {
  for (const target of ["plan", "witness", "chunk", "head", "inventory-missing", "inventory-corrupt"]) {
    const f = fixture(); expect((await result(launch("cut", f, {point: "after-cas"}))).code).toBe(81);
    const plan = JSON.parse(readFileSync(join(f.data, CUT_DIRECTORY, "plan.json"), "utf8")).plan;
    const name = target === "plan" ? "plan.json" : target === "witness" ? "barrier.json" : target === "chunk" ? plan.parts[0].name : target === "head"
      ? "trusted-peers.v2.commit.1.json" : plan.inventories[0].name;
    const path = join(f.data, CUT_DIRECTORY, name), bytes = readFileSync(path);
    if (target === "head" || target === "inventory-corrupt") writeFileSync(path, bytes.toString() + "\n"); else unlinkSync(path);
    const failed = await result(launch("read", f)); expect(failed.value.ok, target).toBe(false);
    expect(legacyNames(f)).toHaveLength(f.revision + 1); // All old files AND the barrier.
    expect(trace(f).filter(e => e.event === "unlink" && e.path.includes("/trusted-peers.owner."))).toEqual([]);
    console.log(JSON.stringify({cutoverRow: "absent-or-corrupt-evidence", target, name, expectedHash: digest(bytes),
      actualHash: existsSync(path) ? digest(readFileSync(path)) : null, failed, legacyNames: legacyNames(f), events: trace(f)}));
    if (target === "witness") linkSync(join(f.data, `trusted-peers.owner.${f.revision + 1}.json`), path);
    else writeFileSync(path, bytes, {mode: 0o600});
    expect((await result(launch("read", f))).value.ok).toBe(true);
  }
}, 60000);

test("changed retirement candidates and a failed collector preserve evidence and block advancement", async () => {
  const f = fixture(); expect((await result(launch("cut", f, {point: "after-cas"}))).code).toBe(81);
  const path = join(f.data, "trusted-peers.owner.1.json"), bytes = readFileSync(path);
  writeFileSync(path, bytes.toString() + "\n");
  const changed = await result(launch("read", f)); expect(changed.value.error).toContain("migration_retirement_changed");
  expect(existsSync(path)).toBe(true); expect(legacyNames(f)).toHaveLength(f.revision + 1);
  console.log(JSON.stringify({cutoverRow: "changed-retirement", changed, expectedHash: digest(bytes), actualHash: digest(readFileSync(path)), events: trace(f)}));
  writeFileSync(path, bytes);
  for (const mode of ["read", "new-write"]) {
    const blocked = await result(launch(mode, f, {point: "retirement-fail", revision: f.revision}));
    expect(blocked.value.ok).toBe(false); expect(legacyNames(f)).toHaveLength(f.revision + 1);
    expect(readdirSync(f.data).filter(n => n.includes(".commit."))).toEqual(["trusted-peers.v2.commit.1.json"]);
    console.log(JSON.stringify({cutoverRow: "failed-retirement", mode, blocked, events: trace(f)}));
  }
  expect((await result(launch("read", f))).value.ok).toBe(true);
}, 60000);

test("retirement complete with lost ACK returns the original exact migration receipt", async () => {
  for (const point of ["after-receipt", "after-receipt-sync", "during-cleanup", "lost-ack"]) {
    const f = fixture(), stamp = f.owner.pairingAuthorityStamp();
    expect((await result(launch("cut", f, {point, revision: f.revision}))).code).toBe(81);
    const first = await result(launch("cut", f)); expect(first.value).toMatchObject({ok: true, result: {migrationId: "migration", revision: f.revision}});
    expect(f.owner.pairingAuthorityStamp()).toBe(stamp); expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(false);
    expect((await result(launch("cut", f))).value).toEqual(first.value);
    expect(f.owner.read().revision).toBe(f.revision);
    console.log(JSON.stringify({cutoverRow: "ack-loss", point, events: trace(f)}));
  }
}, 60000);

test("failed post-receipt cleanup refuses readiness and further v2 publications", async () => {
  const f = fixture(), failed = await result(launch("cut", f, {point: "cleanup-fail"}));
  expect(failed.value.ok).toBe(false); expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(true);
  console.log(JSON.stringify({cutoverRow: "failed-cleanup", failed, events: trace(f)}));
  for (const mode of ["read", "new-write"]) {
    const blocked = await result(launch(mode, f, {point: "cleanup-fail", revision: f.revision}));
    expect(blocked.value.ok).toBe(false);
    expect(readdirSync(f.data).filter(n => n.includes(".commit."))).toEqual(["trusted-peers.v2.commit.1.json"]);
  }
  expect((await result(launch("cut", f))).value.ok).toBe(true); expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(false);
}, 60000);

test("a real old writer winning the exact next name prevents stale cutover publication", async () => {
  const f = fixture(), child = launch("cut", f, {point: "before-cas"});
  let winner: Awaited<ReturnType<typeof result>>;
  try {
    await ready(f, child, "before-cas");
    winner = await result(launch("old-write", f, {revision: f.revision})); expect(winner.value.ok).toBe(true);
  } finally {go(f);}
  const loser = await result(child); expect(loser.value.ok).toBe(false);
  expect((await result(launch("old-read", f))).value).toMatchObject({ok: true, snapshot: {revision: f.revision + 1}});
  expect(loser.value.error).toContain("revision_conflict");
  expect(existsSync(join(f.data, CUT_DIRECTORY))).toBe(false);
  expect(readdirSync(f.data).filter(n => n.startsWith("trusted-peers.v2."))).toEqual([]);
  expect(f.owner.read().peers.some(p => p.publicKey === "a".repeat(64))).toBe(true);
  console.log(JSON.stringify({cutoverRow: "old-wins-cas", winner: winner!, loser, events: trace(f)}));
  f.owner.migrateToCapsule("fresh-attempt"); expect(f.owner.read().revision).toBe(f.revision + 1);
}, 60000);

test("a real paused v1 writer resumes after the barrier without overwriting a later revoke", async () => {
  for (const point of ["old-before-cas", "old-before-projection"]) {
    const f = fixture(), child = launch("old-write", f, {point, revision: f.revision});
    let after: string;
    try {
      await ready(f, child, point); f.owner.migrateToCapsule("migration");
      const revision = f.revision + (point === "old-before-projection" ? 1 : 0);
      f.owner.mutate(revision, "later-revoke", {type: "revoke", publicKey: "a".repeat(64)});
      after = readFileSync(join(f.data, "trusted-peers.json"), "utf8");
    } finally {go(f);}
    const resumed = await result(child); expect(resumed.value.ok).toBe(false);
    expect(readFileSync(join(f.data, "trusted-peers.json"), "utf8")).toBe(after!);
    expect(f.owner.read().peers.some(p => p.publicKey === "a".repeat(64))).toBe(false);
    if (point === "old-before-projection") expect(f.owner.mutate(f.revision, "writer", {type: "grant", peer: {publicKey: "a".repeat(64), pairedAt: "date"}}).revision).toBe(f.revision + 1);
    console.log(JSON.stringify({cutoverRow: "paused-v1", point, resumed, projectionHash: digest(after!), events: trace(f)}));
  }
}, 60000);

test("late migration helpers never recreate consumed sources after a later v2 mutation", async () => {
  for (const point of ["publish-head", "before-receipt"]) {
    const f = fixture(), child = launch("cut", f, {point});
    try {
      await ready(f, child, point); expect(f.owner.read().revision).toBe(f.revision);
      f.owner.mutate(f.revision, "later-revoke", {type: "revoke", publicKey: f.keys[0]!});
    } finally {go(f);}
    const late = await result(child); expect(late.value, late.stderr).toMatchObject({ok: true, result: {revision: f.revision}});
    expect(f.owner.read().revision).toBe(f.revision + 1); expect(f.owner.read().peers.some(p => p.publicKey === f.keys[0])).toBe(false);
    expect(readdirSync(f.data).filter(n => n.includes(".commit."))).toEqual(["trusted-peers.v2.commit.2.json"]);
    expect(readdirSync(f.data).filter(n => n.includes(".done."))).toEqual(["trusted-peers.v2.done.2.json"]);
    console.log(JSON.stringify({cutoverRow: "late-helper", point, late, currentRevision: f.owner.read().revision, events: trace(f)}));
  }
}, 60000);
