/** Isolated process: remap only slot inode observations, never production I/O. */
import fs from "node:fs";
import {expect, mock, test} from "bun:test";
import {join} from "node:path";
import {tmpdir} from "node:os";
const original={...fs}, descriptors=new Map<number,string>();
let reuse:{path:string;ino:number;birthtimeMs:number}|null=null, remapped=0;
// Real slot directory observations. Persisted slot identities are keyed
// hashes, so the test finds the inode behind one by recomputing it.
const seen:{ino:number;birthtimeMs:number}[]=[];
let afterUnlink:((path:string)=>void)|null=null;
const remap=(path:string,stat:fs.Stats)=>{
  if(stat.isDirectory() && (path.includes("/.pairing-claim-") || path.includes("/.pairing-v2-slot-")))seen.push({ino:stat.ino,birthtimeMs:stat.birthtimeMs});
  // Reuse the inode AND the birth time: the identity inputs collide exactly.
  if(reuse && (path===reuse.path || path.includes("/.pairing-claim-") && stat.isDirectory())){
    Object.defineProperty(stat,"ino",{value:reuse.ino,configurable:true});
    Object.defineProperty(stat,"birthtimeMs",{value:reuse.birthtimeMs,configurable:true});remapped++;}
  return stat;
};
fs.lstatSync=((path:any,...args:any[])=>remap(String(path),(original.lstatSync as any)(path,...args))) as any;
fs.openSync=((path:any,...args:any[])=>{const fd=(original.openSync as any)(path,...args);descriptors.set(fd,String(path));return fd;}) as any;
fs.closeSync=((fd:number)=>{descriptors.delete(fd);return original.closeSync(fd);}) as any;
fs.fstatSync=((fd:number,...args:any[])=>remap(descriptors.get(fd)??"",(original.fstatSync as any)(fd,...args))) as any;
fs.renameSync=((source:any,target:any)=>{
  original.renameSync(source,target);
  for(const [fd,path] of descriptors)if(path===String(source))descriptors.set(fd,String(target));
}) as any;
fs.unlinkSync=((path:any)=>{original.unlinkSync(path);afterUnlink?.(String(path));}) as any;
mock.module("node:fs",()=>({...fs}));
const {pairingTrustOwner}=await import("../packages/runtime/src/pairing-security/trust-owner.ts");
const {capsuleFixture}=await import("./fixtures/pairing-capsule.ts");
const peer=(n:number)=>({publicKey:n.toString(16).padStart(64,"0"),pairedAt:"2026-01-01"});
function fixture(body:(f:ReturnType<typeof capsuleFixture>)=>void){
  const path=original.mkdtempSync(join(original.realpathSync(tmpdir()),"pairing-capsule-slot-identity-"));
  try{body(capsuleFixture(path,{generations:3,keys:1,factory:pairingTrustOwner}));}
  finally{reuse=null;afterUnlink=null;original.rmSync(path,{recursive:true,force:true});}
}
function behind(owner:any,slot:any){
  const root=owner.root(),found=seen.find(s=>owner.objectId(root,s)===slot.identity);
  if(!found)throw Error("slot identity was never observed");return found;
}
function observe(owner:any,slot:any){reuse={path:join(owner.path,`.pairing-v2-slot-${slot.index}`),...behind(owner,slot)};remapped=0;}
test("reused inode is not the previous head's token: ordinary v2 writes still succeed",()=>{
  for(const simulate of [false,true])fixture(f=>{
    f.owner.mutate(3,"first",{type:"grant",peer:peer(161)});
    const head=JSON.parse(original.readFileSync(join(f.root,"trusted-peers.v2.commit.2.json"),"utf8")).capsule;
    expect(original.existsSync(join(f.root,`.pairing-v2-slot-${head.slot.index}`))).toBe(false);
    if(simulate)observe(f.owner,head.slot);
    const second=f.owner.mutate(4,"second",{type:"grant",peer:peer(178)});
    expect(second.revision).toBe(5);expect(f.owner.read().revision).toBe(5);
    if(simulate)expect(remapped).toBeGreaterThan(0);
    console.log(JSON.stringify({case:"ordinary-reused-inode",simulate,remapped,result:second}));
  });
});
test("stale release never removes an empty or initialized newer claim with the same inode",()=>fixture(f=>{
  const owner=f.owner as any;
  owner.operation(undefined,(root:any)=>{
    const old=owner.claimCapsuleSlot(root);owner.releaseCapsuleSlot(root,old);observe(owner,old);
    original.mkdirSync(reuse!.path,{mode:0o700});
    owner.releaseCapsuleSlot(root,old);
    expect(original.existsSync(reuse!.path)).toBe(true);
    // Empty canonical slots now prove abandonment; they are deliberately
    // reclaimed by rename. The separate eight-LIVE-claims test still refuses.
    const next=owner.claimCapsuleSlot(root);expect(next.identity).toBe(old.identity);expect(next.token).not.toBe(old.token);
    owner.releaseCapsuleSlot(root,old);
    expect(original.readdirSync(reuse!.path)).toEqual([`${next.token}.json`]);
    expect(()=>owner.syncSlot(root,old)).toThrow("capsule_slot_invalid");
    owner.syncSlot(root,next);
    const slots=owner.capsuleSlots(root,original.readdirSync(f.root));
    expect(slots.claims.has(old.token)).toBe(false);expect(slots.claims.get(next.token)).toEqual(next);
    console.log(JSON.stringify({case:"stale-release-reused-inode",old,next,remapped}));
    owner.releaseCapsuleSlot(root,next);
  });
}));
test("release pins the directory until after token unlink and rmdir",()=>fixture(f=>{
  const owner=f.owner as any;
  owner.operation(undefined,(root:any)=>{
    const slot=owner.claimCapsuleSlot(root),path=join(f.root,`.pairing-v2-slot-${slot.index}`);let observed=false;
    afterUnlink=name=>{
      if(name!==join(path,`${slot.token}.json`))return;
      observed=true;
      // With no descriptor, a filesystem may immediately reuse this inode.
      // Require the pin at the actual unlink boundary, not just on entry.
      expect([...descriptors.values()]).toContain(path);
      original.rmdirSync(path);original.mkdirSync(path,{mode:0o700});
      // Original descriptor still pins the deleted inode; the replacement
      // cannot have that inode. Do not inject impossible reuse while pinned.
      expect(original.lstatSync(path).ino).not.toBe(behind(owner,slot).ino);
    };
    owner.releaseCapsuleSlot(root,slot);afterUnlink=null;
    expect(observed).toBe(true);expect(original.existsSync(path)).toBe(true);
  });
}));
