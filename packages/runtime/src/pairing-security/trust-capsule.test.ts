import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,unlinkSync,mkdirSync,renameSync,symlinkSync,linkSync,lstatSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pairingTrustOwner,PairingTrustOwner,type PairingTrustAdapter} from "./trust-owner.ts";
import {testRootKey} from "../../../../scripts/fixtures/pairing-identity.ts";
import {capsuleFixture} from "../../../../scripts/fixtures/pairing-capsule.ts";
import {randomUUID} from "node:crypto";
import {pack,digest,commitName,doneName,slotName,dataName,stageName,CUTOVER,type CapsuleHead,type CapsuleRow} from "./trust-capsule.ts";

const roots:string[]=[],removers:(()=>void)[]=[];
function fixture(options:Parameters<typeof capsuleFixture>[1]={}){const root=mkdtempSync(join(tmpdir(),"pairing-capsule-unit-"));roots.push(root);return capsuleFixture(root,{factory:pairingTrustOwner,...options});}
afterEach(()=>{for(const f of removers.splice(0))f();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const other="b".repeat(64),peer={publicKey:other,pairedAt:"2026-02-01"};
function adapter(){let holder:object|null=null;const a:PairingTrustAdapter={id:"capsule.test",withGate(_r,body){holder={};try{return body(holder);}finally{holder=null;}},currentHolder(){return holder;}};return a;}
function rewriteHead(f:ReturnType<typeof fixture>,edit:(head:CapsuleHead)=>void){const path=join(f.root,commitName(1)),h=JSON.parse(readFileSync(path,"utf8")).capsule;edit(h);const bytes=pack("capsule",h);writeFileSync(path,bytes);
  writeFileSync(join(f.root,doneName(1)),pack("receipt",{schema:"scout.pairing-collected/v2",rootId:f.rootId,serial:1,physicalHash:digest(bytes)}));}

test("v2 first-cut stamp uses the exact logical v1 head, never the physical capsule",()=>{
  for(const projection of [undefined,"[]",null," [ ] \n"]){const f=fixture({projection});expect(f.owner.pairingAuthorityStamp()).toBe(f.stamp);}
});
test("v1 remains the default writer and missing-root reads create nothing",()=>{
  const p=mkdtempSync(join(tmpdir(),"pairing-capsule-unit-"));roots.push(p);const root=join(p,"missing"),o=pairingTrustOwner(root,{rootKey:testRootKey()});
  expect(o.read()).toEqual({revision:0,peers:[]});expect(readdirSync(p)).toEqual([]);
  o.mutate(0,"v1",{type:"grant",peer});expect(readdirSync(root).filter(n=>n.startsWith("trusted-peers.v2."))).toEqual([]);
});
test("v2 cold readers and every warm read refuse a changed early chunk",()=>{
  const f=fixture({generations:4,keys:2});expect(f.owner.read().revision).toBe(4);
  const p=join(f.root,f.head.parts[0]!.name),s=readFileSync(p,"utf8");writeFileSync(p,s.replace("fixture-1","fixture-0"));
  expect(()=>f.owner.read()).toThrow("capsule_chunk_checksum");expect(()=>new PairingTrustOwner(f.root).read()).toThrow("capsule_chunk_checksum");
});
test("v2 real writes, final-chunk COW, exact retries and bounded collection",()=>{
  const f=fixture(),o=f.owner,initial=f.head.parts.map(p=>p.name);
  const result=o.mutate(1,"two",{type:"grant",peer});expect(result.revision).toBe(2);
  let h=JSON.parse(readFileSync(join(f.root,commitName(2)),"utf8")).capsule;
  const firstTail=h.parts.at(-1).name;expect(h.parts.slice(0,initial.length).map((p:any)=>p.name)).toEqual(initial);
  const third=o.mutate(2,"three",{type:"revoke",publicKey:other});expect(third.revision).toBe(3);
  h=JSON.parse(readFileSync(join(f.root,commitName(3)),"utf8")).capsule;
  expect(h.parts.length).toBe(initial.length+1);expect(h.parts.at(-1).name).not.toBe(firstTail);
  expect(readdirSync(f.root)).not.toContain(firstTail);expect(readdirSync(f.root).filter(n=>n.includes(".commit."))).toEqual([commitName(3)]);
  expect(new PairingTrustOwner(f.root).mutate(1,"two",{type:"grant",peer})).toEqual(result);
  expect(()=>o.mutate(2,"two",{type:"grant",peer})).toThrow("mutation_id_reused");
  expect(o.read().peers.some(p=>p.publicKey===other)).toBe(false);
  expect(readdirSync(f.root).filter(n=>n.startsWith(".pairing-v2"))).toEqual([]);
});
test("v2 damaged candidate refuses before reserving a serial",()=>{
  const f=fixture(),o=f.owner as any,write=o.writeNew.bind(o);
  o.writeNew=(root:any,name:string,bytes:string)=>{write(root,name,bytes);if(name.startsWith("trusted-peers.v2.data."))writeFileSync(join(root.path,name),bytes.replace('"two"','"bad"'));};
  expect(()=>f.owner.mutate(1,"two",{type:"grant",peer})).toThrow("capsule_candidate_changed");
  expect(f.owner.read().revision).toBe(1);expect(readdirSync(f.root).filter(n=>n.includes(".commit."))).toEqual([commitName(1)]);
  expect(readdirSync(f.root).filter(n=>n.startsWith(".pairing-v2"))).toEqual([]);
});
test("v2 permanent managed policy cannot disappear with the marker",()=>{
  const f=fixture({prepare(o){removers.push(o.register(adapter()));o.withInvocation(c=>o.mutate(1,"manage",{type:"manage"},c));}});
  expect(f.owner.read().revision).toBe(2);
  rewriteHead(f,h=>{h.policy=null;});unlinkSync(join(f.root,"trusted-peers.managed.json"));
  expect(()=>f.owner.read()).toThrow("managed_downgrade");
});
test("v2 managed adoption through the real writer retains holder enforcement",()=>{
  const f=fixture();removers.push(f.owner.register(adapter()));
  f.owner.withInvocation(c=>f.owner.mutate(1,"manage",{type:"manage"},c));
  expect(f.owner.read().revision).toBe(2);removers.pop()!();
  expect(()=>new PairingTrustOwner(f.root).read()).toThrow("managed_adapter_required");
});
test("v2 managed holder is checked after projection I/O and contexts expire",()=>{
  let holder:object|null=null,lost=false;
  const a:PairingTrustAdapter={id:"capsule.test",withGate(_r,body){holder={};try{return body(holder);}finally{holder=null;}},currentHolder(){return lost?null:holder;}};
  const f=fixture({prepare(o){removers.push(o.register(a));o.withInvocation(c=>o.mutate(1,"manage",{type:"manage"},c));}});
  const o=f.owner as any,read=o.readFile.bind(o);let armed=false;
  o.readFile=(root:any,name:string,...rest:any[])=>{const bytes=read(root,name,...rest);if(armed && name==="trusted-peers.json")lost=true;return bytes;};
  let captured:any;f.owner.withInvocation(c=>{captured=c;armed=true;expect(()=>f.owner.read(c)).toThrow("invalid_context");});
  armed=false;lost=false;expect(()=>f.owner.read(captured)).toThrow("invalid_context");
});
test("v2 raw projection hashes, pending adoption and empty versus encoded array survive",()=>{
  const f=fixture({projection:" [ ]\n"});expect(f.owner.read().peers).toEqual([]);expect(f.owner.pairingAuthorityStamp()).toBe(f.stamp);
  f.owner.mutate(1,"after-adoption",{type:"grant",peer});
  const h=JSON.parse(readFileSync(join(f.root,commitName(2)),"utf8")).capsule;
  expect(h.adoption).toEqual({fromProjectionHash:f.barrier.logicalPeersHash,toProjectionHash:digest(" [ ]\n")});
  expect(f.owner.read().peers).toEqual([peer]);
  const empty=fixture({generations:0,keys:0,projection:null});const before=empty.owner.pairingAuthorityStamp();
  writeFileSync(join(empty.root,"trusted-peers.json"),"[]",{mode:0o600});expect(empty.owner.read().peers).toEqual([]);expect(empty.owner.pairingAuthorityStamp()).not.toBe(before);
  empty.owner.mutate(0,"first",{type:"grant",peer});expect(empty.owner.read().revision).toBe(1);
  const malformed=fixture({generations:0,keys:0,projection:null});writeFileSync(join(malformed.root,"trusted-peers.json"),"",{mode:0o600});
  expect(()=>malformed.owner.read()).toThrow();expect(()=>malformed.owner.pairingAuthorityStamp()).toThrow();
});
test("v2 unsupported highest serial refuses rather than falling back",()=>{
  const f=fixture();const bad={...f.head,serial:2,schema:"future/v99"};writeFileSync(join(f.root,commitName(2)),pack("capsule",bad),{mode:0o600});
  expect(()=>f.owner.read()).toThrow("capsule_version_unsupported");
});
test("v2 resurfaced legacy generations and authority links refuse at their actual boundary",()=>{
  const f=fixture();writeFileSync(join(f.root,"trusted-peers.owner.1.json"),"{}",{mode:0o600});
  expect(()=>f.owner.read()).toThrow("capsule_unexpected_history");unlinkSync(join(f.root,"trusted-peers.owner.1.json"));
  const p=join(f.root,f.head.parts[0]!.name),backup=join(f.root,"test-backup");renameSync(p,backup);symlinkSync(backup,p);
  expect(()=>f.owner.read()).toThrow("ELOOP");unlinkSync(p);renameSync(backup,p);
  linkSync(p,backup);expect(()=>f.owner.read()).toThrow("unsafe_path");unlinkSync(backup);
});
test("v2 eight live token-bearing claims refuse new staging without age takeover",()=>{
  const f=fixture(),o=f.owner as any;
  o.operation(undefined,(root:any)=>{
    const claims=Array.from({length:8},()=>o.claimCapsuleSlot(root));
    expect(f.owner.read().revision).toBe(1);expect(()=>f.owner.mutate(1,"full",{type:"grant",peer})).toThrow("capsule_staging_capacity");
    for(const claim of claims)o.releaseCapsuleSlot(root,claim);
  });
});
test("v2 abandoned empty slots are replaceable, not live pre-token claims",()=>{
  const f=fixture();for(let i=0;i<8;i++)mkdirSync(join(f.root,slotName(i)),{mode:0o700});
  expect(f.owner.mutate(1,"reclaimed",{type:"grant",peer}).revision).toBe(2);
  expect(f.owner.read().peers.some(p=>p.publicKey===other)).toBe(true);
});

test("v2 charge records, part counts and lifetime counters are validated",()=>{
  const f=fixture();rewriteHead(f,h=>{h.chargedBytes--;});expect(()=>f.owner.read()).toThrow("capsule_outcomes_invalid");
});

// Synthetic completed authority at format boundaries, not a migration. Rows
// remain exhaustive and the real owner must validate them before each write.
function boundary(count:number,charge=600,perPart=1400,peers:any[]=[]){
  const f=fixture({generations:0,keys:0}),rows:CapsuleRow[]=Array.from({length:count},(_,i)=>[
    `boundary-${i}`,i+1,"revoke",other,false,JSON.stringify([i,"revoke",other,null]),charge,null]);
  const parts=[];
  for(let i=0;i<count;i+=perPart){const group=rows.slice(i,i+perPart),bytes=JSON.stringify(group),name=dataName(randomUUID());
    writeFileSync(join(f.root,name),bytes,{mode:0o600});parts.push({name,bytes:Buffer.byteLength(bytes),sha256:digest(bytes),count:group.length});}
  const raw=JSON.stringify(peers,null,2),peersHash=digest(raw),outcomesDigest=digest(JSON.stringify(rows));
  const b={...f.barrier,revision:count,logicalPeersHash:peersHash,checkpointPeersHash:peersHash,projectionHash:peersHash,parts,outcomesDigest,chargedBytes:count*charge};
  unlinkSync(join(f.root,f.barrierName));const barrierName=`trusted-peers.owner.${count+1}.json`,barrier=pack("barrier",b),cutHash=digest(barrier);
  const h={...f.head,revision:count,cutHash,previousPhysicalHead:cutHash,peers,logicalPeersHash:peersHash,checkpointPeersHash:peersHash,projectionHash:peersHash,parts,outcomesDigest,chargedBytes:count*charge};
  writeFileSync(join(f.root,barrierName),barrier,{mode:0o600});writeFileSync(join(f.root,CUTOVER),pack("receipt",{schema:"scout.pairing-cutover-done/v2",rootId:f.rootId,cutHash}));
  writeFileSync(join(f.root,"trusted-peers.json"),raw,{mode:0o600});
  const header=pack("capsule",h);writeFileSync(join(f.root,commitName(1)),header);
  writeFileSync(join(f.root,doneName(1)),pack("receipt",{schema:"scout.pairing-collected/v2",rootId:f.rootId,serial:1,physicalHash:digest(header)}));
  return {...f,head:h,barrier:b,barrierName};
}
test("v2 enforces 65536 logical mutations without resetting the ledger",()=>{
  const f=boundary(65536);expect(f.owner.read().revision).toBe(65536);
  expect(()=>f.owner.mutate(65536,"overflow",{type:"grant",peer})).toThrow("capacity");
  const tooMany=fixture();rewriteHead(tooMany,h=>{h.revision=65537;});expect(()=>tooMany.owner.read()).toThrow("capsule_invalid");
});
test("v2 enforces 128 MiB lifetime charge and validates every retained charge",()=>{
  const f=boundary(256,524288);expect(f.owner.read().revision).toBe(256);
  expect(()=>f.owner.mutate(256,"overflow",{type:"grant",peer})).toThrow("capacity");
  const bad=fixture();rewriteHead(bad,h=>{h.chargedBytes=128*1024*1024+1;});expect(()=>bad.owner.read()).toThrow("capsule_invalid");
  const zeroCharge=boundary(2,0);expect(()=>zeroCharge.owner.read()).toThrow("capsule_outcome_invalid");
  const physical=fixture();rewriteHead(physical,h=>{
    h.parts=[...h.parts,...Array.from({length:128},()=>({name:dataName(randomUUID()),sha256:"a".repeat(64),bytes:1024*1024,count:1}))];
  });expect(()=>physical.owner.read()).toThrow("capacity");
});
test("v2 enforces 4096 peers, 1 MiB files, and 256 chunks",()=>{
  const peers=Array.from({length:4096},(_,i)=>({publicKey:(i+1).toString(16).padStart(64,"0"),pairedAt:"date"}));
  const f=boundary(0,600,1400,peers);expect(f.owner.read().peers.length).toBe(4096);
  expect(()=>f.owner.mutate(0,"overflow",{type:"grant",peer})).toThrow("invalid_peers");
  const chunks=boundary(256,600,1);expect(chunks.owner.read().revision).toBe(256);
  expect(()=>chunks.owner.mutate(256,"chunk-overflow",{type:"grant",peer})).toThrow("capacity");
  const oversized=fixture();writeFileSync(join(oversized.root,oversized.head.parts[0]!.name),Buffer.alloc(1024*1024+1));
  expect(()=>oversized.owner.read()).toThrow("unsafe_path");
});
test("v2 slot claims enforce 3 MiB and stale release cannot remove a reused index",()=>{
  const f=fixture(),o=f.owner as any;
  o.operation(undefined,(root:any)=>{
    const old=o.claimCapsuleSlot(root);o.releaseCapsuleSlot(root,old);const next=o.claimCapsuleSlot(root);
    expect(next.index).toBe(old.index);o.releaseCapsuleSlot(root,old);
    expect(readdirSync(join(f.root,slotName(next.index)))).toEqual([`${next.token}.json`]);
    for(const role of ["peers","marker","done","commit"] as const)writeFileSync(join(f.root,stageName(next.token,role)),Buffer.alloc(800000),{mode:0o600});
    expect(()=>o.read()).toThrow("capacity");
  });
});
