/** Deliberately broken public-source copies. Never patches the checkout or
 * installs an adapter in product state. Run explicitly with an evidence dir. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uncoloredEnv } from "./uncolored-env.ts";
const root = fileURLToPath(new URL("..",import.meta.url)), output = process.argv[2];
if (!output) throw Error("usage: bun scripts/pairing-trust-owner-controls.ts <evidence-directory>");
mkdirSync(output,{recursive:true});
const original = readFileSync(join(root,"packages/runtime/src/pairing-security/trust-owner.ts"),"utf8");
const relocate=(source:string)=>source
  .replaceAll('"../node-identity.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/node-identity.ts")).href))
      .replaceAll('"../instance.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/instance.ts")).href))
      .replaceAll('"./host-binding.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/host-binding.ts")).href))
      .replace('"../support-paths.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/support-paths.ts")).href))
  .replace('"./trust-capsule.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-capsule.ts")).href))
  .replace('"./trust-cutover.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-cutover.ts")).href))
      .replaceAll('"./trust-reclamation.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-reclamation.ts")).href));
const unit = readFileSync(join(root,"packages/runtime/src/pairing-security/trust-owner.test.ts"),"utf8");
const controls = [
  {id:"cas", expected:"stale revision refuses byte-identically", edits:[
    ['if (state.revision !== expectedRevision) refuse("revision_conflict");',''],
    ['if (before.revision !== expectedRevision || before.hash !== state.hash || before.projectionHash !== state.projectionHash) refuse("revision_conflict");',''],
  ]},
  {id:"dedup", expected:"ACK-loss retry returns recorded outcome", edits:[['if (saved) {','if (false && saved) {']]},
  {id:"resurrection", expected:"revoke versus a paused reconnect", edits:[['if (!snapshot.peers.some(peer => peer.publicKey === publicKey)) refuse("peer_revoked");','if (!snapshot.peers.some(peer => peer.publicKey === publicKey)) this.mutate(snapshot.revision, randomUUID(), {type:"grant",peer:{publicKey,pairedAt:lastSeen}}, context);']]},
  {id:"ambiguous", expected:"ambiguous-prefix DELETE refuses", edits:[['if (matches.length > 1) refuse("ambiguous_prefix");','']]},
  {id:"managed-fallback", expected:"managed marker refuses without adapter", edits:[['if (marker) {','if (false && marker) {']]},
  {id:"external-change", expected:"external changes in both directions", edits:[['if (marker && changedProjection) refuse("external_change_or_incomplete");','']]},
  {id:"context-lifetime", expected:"inherited async task is dead", edits:[['!invocation.active || ','']]},
  {id:"gate-holder", expected:"context is checked against actual current gate holder", edits:[['|| invocation.adapter.currentHolder(root) !== invocation.holder','']]},
  {id:"generation-checksum", expected:"generation checksum detects", edits:[['if (!record(value) || envelope.sha256 !== hash(JSON.stringify(value))) refuse("generation_checksum");','']]},
  {id:"refresh-growth", expected:"reconnect storm writes zero generations", edits:[['const snapshot = this.read(context);','const snapshot = this.read(context); if (snapshot.peers.length) this.mutate(snapshot.revision, randomUUID(), {type:"grant",peer:snapshot.peers[0]!}, context);']]},
  {id:"advisory-merge", expected:"advisory merge takes the later projection or reconnect time", edits:[['Date.parse(value) > Date.parse(latest)','Date.parse(value) < Date.parse(latest)']]},
  {id:"unmanaged-adoption", expected:"unmanaged old-binary writes are adopted", edits:[['if (marker && changedProjection)', 'if (changedProjection)']]},
  {id:"pending-publication", expected:"pending CAS witness survives until projection rename", edits:[
    ['reserved = true;','reserved = true; unlinkSync(stagedGeneration);'],
  ]},
  {id:"generation-two-links", expected:"pending head rolls forward on the next read", edits:[['stagedGeneration = name.startsWith(PREFIX)','stagedGeneration = false']]},
  {id:"roll-forward", expected:"pending head rolls forward on the next read", edits:[['if (state.pendingStage) this.completePublication(root, state);','']]},
  {id:"pending-classification", expected:"unfinishable pending read refuses publication_incomplete", edits:[['refuse("publication_incomplete")','refuse("unsafe_path")']]},
  {id:"recovery-hash", expected:"recovery refuses a tampered shared projection stage", edits:[['if (hash(staged) !== state.peersHash) refuse("publication_incomplete");','']]},
  {id:"late-writer-ack", expected:"consumed projection stage tolerates a helper and a later revoke", edits:[['catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }','catch (error) { throw error; }']]},
  {id:"late-writer-replay", expected:"consumed projection stage tolerates a helper and a later revoke", edits:[['catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }','catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; renameSync(this.stage(root, bytes), join(root.path, PEERS)); }']]},
  {id:"sync-omitted", expected:"required file and directory barriers", edits:[['fsyncSync(fd);','void fd;']]},
];
async function checkDisk(control: string) {
  const volume = process.platform === "darwin" ? "/System/Volumes/Data" : "/";
  const human = Bun.spawn(["df","-h",volume],{stdout:"pipe",stderr:"pipe"});
  const humanText = await new Response(human.stdout).text();
  if (await human.exited !== 0) throw Error("disk check failed");
  const disk = Bun.spawn(["df","-Pk",volume],{stdout:"pipe",stderr:"pipe"});
  const diskText = await new Response(disk.stdout).text();
  if (await disk.exited !== 0 || Number(diskText.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]) < 3 * 1024 * 1024) throw Error("stop: less than 3 GiB free or disk check failed");
  console.log(JSON.stringify({control,disk:humanText.trim(),blocks:diskText.trim()}));
}
const evidence: unknown[] = [];
for (const control of controls) {
  const scratch = mkdtempSync(join(tmpdir(),"pairing-owner-control-"));
  try {
    let source = original;
    for (const [needle,replacement] of control.edits) {
      if (!source.includes(needle!)) throw Error(`control anchor absent: ${control.id}`);
      source = source.replaceAll(needle!,replacement!);
    }
    source = relocate(source);
    const module = join(scratch,"owner.ts"); writeFileSync(module,source);
    const testFile = join(scratch,"control.test.ts");
    let tests = unit.replace('"./trust-owner.ts"',JSON.stringify(module));
    if (control.id === "sync-omitted") {
      tests = `import {expect,test,mock} from "bun:test";
import fs from "node:fs";
const original={...fs}; let syncs=0;
mock.module("node:fs",()=>({...original, fsyncSync:(fd:number)=>{syncs++;original.fsyncSync(fd);}}));
const {pairingTrustOwner}=await import(${JSON.stringify(module)});
test("required file and directory barriers",()=>{
const data=${JSON.stringify(join(scratch,"data"))}; original.mkdirSync(data,{mode:0o700});
pairingTrustOwner(data).mutate(0,"id",{type:"grant",peer:{publicKey:"a".repeat(64),pairedAt:"date"}});
expect(syncs).toBe(3);
});`;
    }
    if (control.id === "pending-publication") {
      tests = `import {expect,test,mock} from "bun:test";
import fs from "node:fs";
const original={...fs}; let owner:any, observed=false, premature=false;
mock.module("node:fs",()=>({...original, renameSync:(source:string,target:string)=>{
if (target.endsWith("trusted-peers.json")) { observed=true; try {owner.read();premature=true;} catch {} }
original.renameSync(source,target);
}}));
const {pairingTrustOwner}=await import(${JSON.stringify(module)});
test("pending CAS witness survives until projection rename",()=>{
const data=${JSON.stringify(join(scratch,"data"))}; original.mkdirSync(data,{mode:0o700}); owner=pairingTrustOwner(data);
owner.mutate(0,"id",{type:"grant",peer:{publicKey:"a".repeat(64),pairedAt:"date"}});
expect(observed).toBe(true); expect(premature).toBe(false);
});`;
    }
    if (control.id.startsWith("late-writer-")) {
      tests = `import {expect,test,mock} from "bun:test";
import fs from "node:fs";
const original={...fs}; let helper:any, interposed=false;
mock.module("node:fs",()=>({...original,renameSync:(source:string,target:string)=>{
if (!interposed && target.endsWith("trusted-peers.json")) {
interposed=true; helper.read(); helper.mutate(1,"later-revoke",{type:"revoke",publicKey:"a".repeat(64)});
}
original.renameSync(source,target);
}}));
const {PairingTrustOwner}=await import(${JSON.stringify(module)});
const other=await import(${JSON.stringify(module+"?helper")});
test("consumed projection stage tolerates a helper and a later revoke",()=>{
const data=${JSON.stringify(join(scratch,"data"))};original.mkdirSync(data,{mode:0o700});
const owner=new PairingTrustOwner(data);helper=new other.PairingTrustOwner(data);
expect(owner.mutate(0,"first",{type:"grant",peer:{publicKey:"a".repeat(64),pairedAt:"date"}}).revision).toBe(1);
expect(interposed).toBe(true);expect(owner.read()).toEqual({revision:2,peers:[]});
});`;
    }
    if (control.id.startsWith("late-writer-")) {
      const baselineModule=join(scratch,"baseline.ts"), baselineTest=join(scratch,"baseline.test.ts");
      writeFileSync(baselineModule,relocate(original));
      writeFileSync(baselineTest,tests.replaceAll(module,baselineModule));
      await checkDisk(control.id+"-positive");
      const baseline=Bun.spawn([process.execPath,"test",baselineTest],{env:uncoloredEnv(),stdout:"pipe",stderr:"pipe"});
      const [code,out,err]=await Promise.all([baseline.exited,new Response(baseline.stdout).text(),new Response(baseline.stderr).text()]);
      writeFileSync(join(output,`${control.id}-positive.log`),out+err);
      if (code !== 0) throw Error(`positive control fixture failed: ${control.id}`);
      rmSync(join(scratch,"data"),{recursive:true,force:true});
    }
    writeFileSync(testFile,tests);
    await checkDisk(control.id);
    const child = Bun.spawn([process.execPath,"test",testFile],{env:uncoloredEnv(),stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const log=stdout+stderr; writeFileSync(join(output,`${control.id}.log`),log);
    const caught = exit !== 0 && log.includes(`(fail)`) && log.includes(control.expected) && !log.includes("Cannot find module");
    const row={id:control.id,caught,exit,expected:control.expected,sourceSha256:createHash("sha256").update(source).digest("hex")};
    evidence.push(row); console.log(JSON.stringify(row));
    if (!caught) throw Error(`negative control did not fail its required case: ${control.id}`);
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
writeFileSync(join(output,"results.json"),JSON.stringify({bun:Bun.version,revision:Bun.revision,controls:evidence},null,2)+"\n");
