/** Planted source bypasses in isolated copies, never the checkout. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statfsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const root=fileURLToPath(new URL("..",import.meta.url)),explicitOutput=process.argv[2];
const out=explicitOutput??mkdtempSync(join(tmpdir(),"pairing-capsule-evidence-"));mkdirSync(out,{recursive:true});
const ownerPath=join(root,"packages/runtime/src/pairing-security/trust-owner.ts");
const original=readFileSync(ownerPath,"utf8"),unit=readFileSync(join(root,"packages/runtime/src/pairing-security/trust-capsule.test.ts"),"utf8");
const controls=[
  {id:"cached-positive",test:"v2 cold readers and every warm read",edits:[
    ['const completing = new Set<string>();','const completing = new Set<string>(); const cached=new Map<string,State>();'],
    ['return this.capsuleState(root, allowPending, inventory, materialize);','{ if(!cached.has(root.id))cached.set(root.id,this.capsuleState(root,allowPending,inventory,materialize)); return cached.get(root.id)!; }'],
  ]},
  {id:"skipped-early-chunk",test:"v2 cold readers and every warm read",edits:[
    ['const completing = new Set<string>();','const completing = new Set<string>(); const cached=new Map<string,Buffer>();'],
    ['const p=h.parts[i]!, bytes=this.readFile(root,p.name,false);','const p=h.parts[i]!, bytes=i===0 && cached.has(root.id)?cached.get(root.id)!:this.readFile(root,p.name,false); if(i===0 && bytes)cached.set(root.id,bytes);'],
  ]},
  {id:"managed-head-flag",test:"v2 permanent managed policy",edits:[
    ['if(!same(policy,h.policy) || !same(cutPolicy,b.policy)) refuse("managed_downgrade");','policy=h.policy;'],
  ]},
  {id:"physical-stamp",test:"v2 first-cut stamp",edits:[
    ['[root.id, state.revision, state.hash, state.projectionHash, state.managed]','[root.id, state.revision, state.capsule?.physicalHash??state.hash, state.projectionHash, state.managed]'],
  ]},
  {id:"lost-managed-holder",test:"v2 managed holder is checked after",edits:[
    ['this.capsulePolicy(root,policy); // Also validate the holder after all authority I/O.',''],
  ]},
  {id:"unverified-candidate",test:"v2 damaged candidate refuses before",edits:[
    ['if(!actual || !actual.equals(Buffer.from(expected)))refuse("capsule_candidate_changed");',''],
  ]},
  {id:"lifetime-charge-reset",test:"v2 enforces 128 MiB lifetime charge",edits:[
    ['state.bytes+charge>TOTAL_LIMIT','charge>TOTAL_LIMIT'],
    ['chargedBytes:state.bytes+charge','chargedBytes:charge'],
  ]},
  {id:"omitted-v2-sync",test:"v2 required actual fsync barriers",edits:[['fsyncSync(fd);','void fd;']]},
];
const results=[];
for(const control of controls){
  const disk=statfsSync(process.platform==="darwin"?"/System/Volumes/Data":"/");if(disk.bavail*disk.bsize<3*1024**3)throw Error("3 GiB disk floor");
  const scratch=mkdtempSync(join(tmpdir(),"pairing-capsule-control-"));
  try{
    const source=(text:string)=>text.replaceAll('"../node-identity.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/node-identity.ts")).href))
      .replaceAll('"../instance.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/instance.ts")).href))
      .replaceAll('"./host-binding.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/host-binding.ts")).href))
      .replace('"../support-paths.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/support-paths.ts")).href))
      .replace('"./trust-capsule.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-capsule.ts")).href))
      .replace('"./trust-cutover.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-cutover.ts")).href))
      .replaceAll('"./trust-reclamation.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-reclamation.ts")).href));
    let mutated=original;
    for(const [needle,replacement] of control.edits){if(!mutated.includes(needle!))throw Error(`missing anchor ${control.id}`);mutated=mutated.replaceAll(needle!,replacement!);}
    const hashes:any={};
    for(const [kind,text] of [["healthy",original],["bypass",mutated]]){
      const module=join(scratch,`${kind}.ts`),testFile=join(scratch,`${kind}.test.ts`);writeFileSync(module,source(text!));
      hashes[kind!]=createHash("sha256").update(text!).digest("hex");
      let tests=unit.replace('"./trust-owner.ts"',JSON.stringify(module))
        .replace('"./trust-capsule.ts"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-capsule.ts")).href))
        .replace('"../../../../scripts/fixtures/pairing-capsule.ts"',JSON.stringify(pathToFileURL(join(root,"scripts/fixtures/pairing-capsule.ts")).href));
      if(control.id==="omitted-v2-sync")tests=`import {expect,test,mock} from "bun:test";
import fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const original={...fs};let syncs=0;
mock.module("node:fs",()=>({...original,fsyncSync:(fd:number)=>{syncs++;original.fsyncSync(fd);}}));
const {pairingTrustOwner}=await import(${JSON.stringify(module)});
const {capsuleFixture}=await import(${JSON.stringify(pathToFileURL(join(root,"scripts/fixtures/pairing-capsule.ts")).href)});
test("v2 required actual fsync barriers",()=>{
const root=original.mkdtempSync(join(tmpdir(),"pairing-capsule-sync-"));
try{const f=capsuleFixture(root,{factory:pairingTrustOwner});syncs=0;
f.owner.mutate(1,"two",{type:"grant",peer:{publicKey:"b".repeat(64),pairedAt:"date"}});
expect(syncs).toBe(16);
}finally{original.rmSync(root,{recursive:true,force:true});}
});`;
      writeFileSync(testFile,tests);
      const child=Bun.spawn([process.execPath,"test",testFile,"--test-name-pattern",control.test],{stdout:"pipe",stderr:"pipe"});
      const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      const log=stdout+stderr;writeFileSync(join(out,`${control.id}-${kind}.log`),log);
      if(kind==="healthy" && code!==0 || kind==="bypass" && !(code!==0 && log.includes("(fail)") && log.includes(control.test) && !log.includes("Cannot find module"))){console.error(log);throw Error(`${control.id}:${kind} did not reach expected assertion; evidence: ${out}`);}
    }
    results.push({id:control.id,test:control.test,caught:true,hashes});
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
writeFileSync(join(out,"results.json"),JSON.stringify({bun:Bun.version,controls:results},null,2));
console.log(JSON.stringify(results));
if(!explicitOutput)rmSync(out,{recursive:true,force:true});
