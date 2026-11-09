/** Isolated source mutations paired with passing real-process fixtures. */
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statfsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const project = fileURLToPath(new URL("..", import.meta.url)), explicit = process.argv[2];
const output = explicit ?? mkdtempSync(join(tmpdir(), "pairing-cutover-controls-")); mkdirSync(output, {recursive: true});
const ownerPath = "packages/runtime/src/pairing-security/trust-owner.ts";
const original = readFileSync(join(project, ownerPath), "utf8");
const controls = [
  {id: "eager-root-stage", test: "before CAS v1 remains authority", edits: [[
    "renameSync(source, target);", "renameSync(source, target); if (name === commitName(1)) this.writeNew(root, name, bytes);",
  ]]},
  {id: "cas-blind-spot", test: "a real old writer winning the exact next name", edits: [[
    'linkSync(join(root.path, cutChild("barrier.json")), join(root.path, bodies.barrierName));',
    'renameSync(join(root.path, cutChild("barrier.json")), join(root.path, bodies.barrierName));',
  ]]},
  {id: "no-roll-forward", test: "barrier and partial-retirement interruptions", edits: [['this.finishPendingCutover(root);', '']]},
  {id: "unchecked-retirement", test: "changed retirement candidates", edits: [[
    'if (this.persistentIdentity(stat) !== item.identity || bytes.length !== item.bytes || hash(bytes) !== item.sha256) refuse("migration_retirement_changed");', '',
  ]]},
  {id: "unchecked-inventory", test: "absent or corrupt capsule and retirement evidence", edits: [[
    'if (!bytes || bytes.length !== part.bytes || hash(bytes) !== part.sha256) refuse("migration_inventory_invalid");',
    'if (!bytes) refuse("migration_inventory_invalid");',
  ]]},
  {id: "missing-barrier-witness", test: "absent or corrupt capsule and retirement evidence", edits: [[
    'const target = lstatSync(barrierPath), witness = lstatSync(join(root.path, cutChild("barrier.json")));\n        owned(target, false, false, true); owned(witness, false, false, true);\n        if (target.nlink !== 2 || id(target) !== id(witness)) refuse("migration_witness_invalid");', '',
  ]]},
  {id: "no-exact-migration-retry", test: "retirement complete with lost ACK", edits: [['b.migration?.migrationId !== migrationId', 'true']]},
  {id: "recreate-consumed-source", test: "late migration helpers never recreate", edits: [[
    'try { renameSync(join(root.path, cutChild(name)), join(root.path, name)); }\n            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }',
    'try { renameSync(join(root.path, cutChild(name)), join(root.path, name)); }\n            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.writeNew(root, name, source); }',
  ]]},
  {id: "older-holder-bypass", unit: true, test: "a live pinned-v1 holder exposed", edits: [[
    'if (held && (!captured || captured !== invocations.getStore() || !captured.active\n      || captured.owner !== this || captured.root.id !== observed!.id || captured.holder !== held)) refuse("migration_holder_active");', '',
  ]]},
  {id: "live-invocation-bypass", unit: true, test: "migration refuses another observable live invocation", edits: [
    ['if ([...liveInvocations].some(active => active.active && active.root.id === root.id && active !== invocation)) refuse("migration_holder_active");', ''],
    ['if ([...liveInvocations].some(active => active.active && active.root.id === root.id\n      && active !== invocations.getStore())) refuse("migration_holder_active");', ''],
  ]},
  {id: "root-barriers-omitted", test: "the full 320 MiB reservation", edits: [[
    'if (id(fstatSync(fd)) !== this.physicalRootId) refuse("root_replaced"); fsyncSync(fd); this.check(root);',
    'if (id(fstatSync(fd)) !== this.physicalRootId) refuse("root_replaced"); void fd; this.check(root);',
  ]]},
  {id: "cleanup-false-positive", test: "failed post-receipt cleanup refuses", edits: [['!existsSync(join(root.path, CUT_DIRECTORY)) && this.cutReceipt(root, barrier, cutHash)', 'this.cutReceipt(root, barrier, cutHash)']]},
  {id: "half-reservation", test: "the full 320 MiB reservation", edits: [
    ['index < RESERVATION_FILES; index++', 'index < RESERVATION_FILES / 2; index++'],
    ['if (allocated !== RESERVATION_BYTES) refuse("migration_reservation_unavailable");', ''],
  ]},
  {id: "cached-migrated-positive", unit: true, test: "migrated reads remain exhaustive", edits: [
    ['const completing = new Set<string>();', 'const completing = new Set<string>(); const cached = new Map<string, State>();'],
    ['return this.capsuleState(root, allowPending, inventory, materialize);', '{if (!cached.has(root.id)) cached.set(root.id, this.capsuleState(root, allowPending, inventory, materialize)); return cached.get(root.id)!;}'],
  ]},
];
const url = (path: string) => pathToFileURL(join(project, path)).href;
const results = [];
for (const control of controls) {
  const volume = statfsSync(process.platform === "darwin" ? "/System/Volumes/Data" : "/");
  if (volume.bavail * volume.bsize < 3 * 1024 ** 3) throw Error("3 GiB disk floor");
  const scratch = mkdtempSync(join(tmpdir(), "pairing-cutover-control-"));
  try {
    let bypass = original;
    for (const [needle, replacement] of control.edits) {
      if (!bypass.includes(needle!)) throw Error(`missing anchor: ${control.id}`);
      bypass = bypass.replaceAll(needle!, replacement!);
    }
    const hashes: Record<string, string> = {};
    for (const [kind, raw] of [["healthy", original], ["bypass", bypass]]) {
      const subject = join(scratch, `${kind}.ts`), worker = join(scratch, `${kind}-worker.ts`);
      let source = raw!;
      for (const [from, to] of [["../node-identity.js","packages/runtime/src/node-identity.ts"],["../instance.js","packages/runtime/src/instance.ts"],["./host-binding.js","packages/runtime/src/pairing-security/host-binding.ts"],["../support-paths.js", "packages/runtime/src/support-paths.ts"],
        ["./trust-capsule.js", "packages/runtime/src/pairing-security/trust-capsule.ts"],
        ["./trust-cutover.js", "packages/runtime/src/pairing-security/trust-cutover.ts"],["./trust-reclamation.js","packages/runtime/src/pairing-security/trust-reclamation.ts"]]) source = source.replaceAll(JSON.stringify(from), JSON.stringify(url(to!)));
      writeFileSync(subject, source); hashes[kind!] = createHash("sha256").update(raw!).digest("hex");
      let workerSource = readFileSync(join(project, "scripts/pairing-cutover-worker.ts"), "utf8");
      workerSource = workerSource.replaceAll('"../' + ownerPath + '"', JSON.stringify(subject))
        .replaceAll('"./fixtures/pairing-v1/pairing-security/trust-owner.ts"', JSON.stringify(url("scripts/fixtures/pairing-v1/pairing-security/trust-owner.ts")));
      writeFileSync(worker, workerSource);
      const unit = "unit" in control && control.unit;
      let tests = readFileSync(join(project, unit ? "packages/runtime/src/pairing-security/trust-cutover.test.ts" : "scripts/pairing-cutover-process.test.ts"), "utf8");
      for (const from of ["./trust-owner.ts", "../" + ownerPath]) tests = tests.replace(JSON.stringify(from), JSON.stringify(subject));
      for (const from of ["./fixtures/pairing-capsule.ts", "../../../../scripts/fixtures/pairing-capsule.ts"]) tests = tests.replace(JSON.stringify(from), JSON.stringify(url("scripts/fixtures/pairing-capsule.ts")));
      tests = tests.replaceAll('"../packages/runtime/src/node-identity.ts"',JSON.stringify(url("packages/runtime/src/node-identity.ts")));
      tests = tests.replaceAll('"../../../../scripts/fixtures/pairing-v1/pairing-security/trust-owner.ts"', JSON.stringify(url("scripts/fixtures/pairing-v1/pairing-security/trust-owner.ts")));
      for (const from of ["./trust-cutover.ts", "../packages/runtime/src/pairing-security/trust-cutover.ts"]) tests = tests.replace(JSON.stringify(from), JSON.stringify(url("packages/runtime/src/pairing-security/trust-cutover.ts")));
      tests = tests.replace('fileURLToPath(new URL("..", import.meta.url))', JSON.stringify(project))
        .replace('join(project, "scripts/pairing-cutover-worker.ts")', JSON.stringify(worker));
      const file = join(scratch, `${kind}.test.ts`); writeFileSync(file, tests);
      const child = Bun.spawn([process.execPath, "test", file, "--test-name-pattern", control.test], {cwd: project, stdout: "pipe", stderr: "pipe"});
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const log = out + err; writeFileSync(join(output, `${control.id}-${kind}.log`), log);
      if (kind === "healthy" ? code !== 0 : !(code !== 0 && log.includes("(fail)") && log.includes(control.test)
        && !log.includes("Cannot find module") && !log.includes("worker did not reach"))) {
        console.error(log); throw Error(`${control.id}:${kind} did not reach its required assertion; evidence ${output}`);
      }
    }
    results.push({id: control.id, test: control.test, caught: true, hashes}); console.log(JSON.stringify(results.at(-1)));
  } finally {rmSync(scratch, {recursive: true, force: true});}
}
writeFileSync(join(output, "results.json"), JSON.stringify({bun: Bun.version, controls: results}, null, 2));
if (!explicit) rmSync(output, {recursive: true, force: true});
