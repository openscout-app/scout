import {afterEach, expect, test} from "bun:test";
import {generateKeyPairSync} from "node:crypto";
import {chmodSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadOrCreateNodeIdentity, readNodeIdentity} from "../node-identity.ts";
import {PairingTrustOwner, pairingTrustOwner} from "./trust-owner.ts";
import {PAIRING_HOST_BINDING_FILE, persistentFileIdentity, type PairingBindingHost} from "./host-binding.ts";
const dirs:string[]=[];
const dir=()=>{const path=mkdtempSync(join(tmpdir(),"pairing-host-binding-"));dirs.push(path);return path;};
const host=():PairingBindingHost=>{
 const keys=generateKeyPairSync("ed25519");
 return {instanceId:"test",identity:{version:1,createdAt:0,
  publicKey:keys.publicKey.export({type:"spki",format:"der"}).toString("base64"),
  privateKey:keys.privateKey.export({type:"pkcs8",format:"der"}).toString("base64")}};
};
const peer={publicKey:"a".repeat(64),pairedAt:"2026-01-01T00:00:00Z"};
const bound=(path:string,h:PairingBindingHost)=>new PairingTrustOwner(path,{host:()=>h,requireHostBinding:true});
const bytes=(path:string)=>Object.fromEntries(readdirSync(path).sort().map(name=>[name,readFileSync(join(path,name))]));
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});

test("new store binds to host and instance, and a fresh owner returns exact mutation retries",()=>{
 const path=dir(),h=host(),o=bound(path,h);
 expect(o.read()).toEqual({revision:0,peers:[]});expect(readdirSync(path)).toEqual([]);
 const mutation={type:"grant" as const,peer};const first=o.mutate(0,"first",mutation);
 const binding=JSON.parse(readFileSync(join(path,PAIRING_HOST_BINDING_FILE),"utf8"));
 expect(binding.authorityId).toStartWith("host-store:");
 expect(new PairingTrustOwner(path,{host:()=>h,requireHostBinding:true}).read().peers).toEqual([peer]);
 expect(bound(path,h).mutate(0,"first",mutation)).toEqual(first);
 expect(binding).not.toHaveProperty("privateKey");expect(lstatSync(join(path,PAIRING_HOST_BINDING_FILE)).mode&0o777).toBe(0o600);
});
test("restart after a directory is restored at the same logical path preserves host ownership",()=>{
 const parent=dir(),path=join(parent,"store"),original=join(parent,"old");mkdirSync(path,{mode:0o700});
 const h=host(),o=bound(path,h);o.mutate(0,"grant",{type:"grant",peer});const before=bytes(path),inode=lstatSync(path).ino;
 renameSync(path,original);mkdirSync(path,{mode:0o700});cpSync(original,path,{recursive:true});
 expect(lstatSync(path).ino).not.toBe(inode);
 expect(()=>o.read()).toThrow("root_replaced");
 expect(bound(path,h).read()).toEqual({revision:1,peers:[peer]});expect(bytes(path)).toEqual(before);
});
test("copied stores refuse another host, instance, or path",()=>{
 const path=dir(),h=host();bound(path,h).mutate(0,"grant",{type:"grant",peer});
 const before=bytes(path);
 expect(()=>bound(path,host()).read()).toThrow("host_identity_mismatch");
 expect(()=>bound(path,{...h,instanceId:"other"}).read()).toThrow("host_binding_scope_mismatch");
 const copied=join(dir(),"copy");cpSync(path,copied,{recursive:true});
 expect(()=>bound(copied,h).read()).toThrow("host_binding_scope_mismatch");expect(bytes(path)).toEqual(before);
});
test("tampered, deleted, symlinked and public-readable bindings refuse",()=>{
 for(const mode of ["signature","delete","symlink","permissions"]){
  const path=dir(),h=host(),o=bound(path,h);o.mutate(0,"grant",{type:"grant",peer});
  const file=join(path,PAIRING_HOST_BINDING_FILE),original=readFileSync(file),record=JSON.parse(original.toString());
  if(mode==="signature"){record.authorityId="host-store:00000000-0000-4000-8000-000000000000";writeFileSync(file,JSON.stringify(record));}
  if(mode==="delete")unlinkSync(file);
  if(mode==="permissions")chmodSync(file,0o644);
  if(mode==="symlink"){unlinkSync(file);const target=join(dir(),"binding");writeFileSync(target,original,{mode:0o600});symlinkSync(target,file);}
  expect(()=>o.read()).toThrow();expect(()=>bound(path,h).read()).toThrow();
 }
});
test("legacy migration is explicit, preserves every journal byte and exact retries",()=>{
 const path=dir(),h=host(),legacy=new PairingTrustOwner(path),mutation={type:"grant" as const,peer};
 const outcome=legacy.mutate(0,"grant",mutation);legacy.mutate(1,"revoke",{type:"revoke",publicKey:peer.publicKey});
 const before=bytes(path),required=bound(path,h);
 expect(()=>required.read()).toThrow("host_binding_required");expect(bytes(path)).toEqual(before);
 expect(()=>required.bindToHost("maintenance",{quiescent:false} as never)).toThrow("quiescence_required");
 const binding=required.bindToHost("maintenance",{quiescent:true});
 expect(required.bindToHost("maintenance",{quiescent:true})).toEqual(binding);
 for(const [name,value] of Object.entries(before))expect(readFileSync(join(path,name))).toEqual(value);
 expect(bound(path,h).read()).toEqual({revision:2,peers:[]});
 expect(bound(path,h).mutate(0,"grant",mutation)).toEqual(outcome);
 expect(()=>required.bindToHost("different",{quiescent:true})).toThrow("host_binding_conflict");
 unlinkSync(join(path,PAIRING_HOST_BINDING_FILE));expect(()=>bound(path,h).read()).toThrow("host_binding_required");
});
test("a legacy root mismatch is never automatically blessed by the host key",()=>{
 const parent=dir(),path=join(parent,"store"),old=join(parent,"old");mkdirSync(path,{mode:0o700});
 new PairingTrustOwner(path).mutate(0,"grant",{type:"grant",peer});renameSync(path,old);mkdirSync(path,{mode:0o700});cpSync(old,path,{recursive:true});
 expect(()=>bound(path,host()).bindToHost("maintenance",{quiescent:true})).toThrow("generation_invalid");
 expect(readdirSync(path)).not.toContain(PAIRING_HOST_BINDING_FILE);
});
test("persistent file claims survive device renumbering and distinguish inode reuse",()=>{
 const stat=lstatSync(dir());
 expect(persistentFileIdentity({...stat,dev:stat.dev+1} as typeof stat)).toBe(persistentFileIdentity(stat));
 expect(persistentFileIdentity({...stat,birthtimeMs:stat.birthtimeMs+1} as typeof stat)).not.toBe(persistentFileIdentity(stat));
});
test("a host-bound store can cut over and resume v2 authority with the same binding",()=>{
 const path=dir(),h=host(),o=bound(path,h);const result=o.mutate(0,"grant",{type:"grant",peer});
 o.migrateToCapsule("cutover");
 expect(bound(path,h).read()).toEqual({revision:1,peers:[peer]});
 expect(bound(path,h).mutate(0,"grant",{type:"grant",peer})).toEqual(result);
 bound(path,h).mutate(1,"revoke",{type:"revoke",publicKey:peer.publicKey});
 expect(bound(path,h).read()).toEqual({revision:2,peers:[]});
});

test("authenticated interrupted binding publication completes without creating trust",()=>{
 const path=dir(),h=host(),o=bound(path,h);o.mutate(0,"grant",{type:"grant",peer});
 const file=join(path,PAIRING_HOST_BINDING_FILE),alias=join(path,".pairing-host-binding-00000000-0000-4000-8000-000000000000.tmp");
 const journal=readFileSync(join(path,"trusted-peers.owner.1.json"));linkSync(file,alias);
 expect(()=>bound(path,host()).read()).toThrow("host_identity_mismatch");expect(lstatSync(file).nlink).toBe(2);
 expect(bound(path,h).read()).toEqual({revision:1,peers:[peer]});expect(lstatSync(file).nlink).toBe(1);
 expect(readFileSync(join(path,"trusted-peers.owner.1.json"))).toEqual(journal);
});

test("a signing failure or orphan stage cannot publish an unbound generation",()=>{
 const path=dir(),h=host();
 writeFileSync(join(path,".pairing-host-binding-00000000-0000-4000-8000-000000000000.tmp"),"unfinished",{mode:0o600});
 expect(()=>bound(path,h).mutate(0,"grant",{type:"grant",peer})).toThrow("host_binding_required");
 expect(readdirSync(path)).toHaveLength(1);
 const empty=dir();
 expect(()=>new PairingTrustOwner(empty,{requireHostBinding:true,host:()=>{throw new Error("host key unavailable");}})
  .mutate(0,"grant",{type:"grant",peer})).toThrow("host key unavailable");
 expect(readdirSync(empty)).toEqual([]);
});

test("a bound empty-store approval can grant exactly once under its stable identity",()=>{
 const path=dir(),h=host(),o=bound(path,h);const stamp=o.pairingAuthorityStamp();
 const opportunity=o.openPairingOpportunity("room",Date.now()+60_000,peer.publicKey,stamp);
 expect(opportunity.admit(peer.publicKey,"room",()=>true)).toBe(true);
 expect(bound(path,h).read().peers).toHaveLength(1);
 expect(opportunity.admit(peer.publicKey,"room",()=>true)).toBe(false);
});

test("the configured production owner uses the existing independent node identity",()=>{
 const path=dir(),support=dir(),saved={pairing:process.env.OPENSCOUT_PAIRING_HOME,support:process.env.OPENSCOUT_SUPPORT_DIRECTORY,instance:process.env.OPENSCOUT_INSTANCE};
 try{
  process.env.OPENSCOUT_PAIRING_HOME=path;process.env.OPENSCOUT_SUPPORT_DIRECTORY=support;process.env.OPENSCOUT_INSTANCE="binding-test";
  expect(readNodeIdentity()).toBeNull();expect(readdirSync(support)).toEqual([]);
  expect(()=>pairingTrustOwner().mutate(0,"grant",{type:"grant",peer})).toThrow("host_identity_required");
  const identity=loadOrCreateNodeIdentity(support),o=pairingTrustOwner();
  o.mutate(0,"grant",{type:"grant",peer});
  expect(bound(path,{identity,instanceId:"binding-test"}).read().peers).toEqual([peer]);
  expect(readdirSync(path)).not.toContain("node-identity.json");
  const unsafe=dir();process.env.OPENSCOUT_PAIRING_HOME=unsafe;process.env.OPENSCOUT_SUPPORT_DIRECTORY=unsafe;
  loadOrCreateNodeIdentity(unsafe);
  expect(()=>pairingTrustOwner().mutate(0,"bad",{type:"grant",peer})).toThrow("host_identity_not_independent");
 }finally{
  for(const [key,value] of [["OPENSCOUT_PAIRING_HOME",saved.pairing],["OPENSCOUT_SUPPORT_DIRECTORY",saved.support],["OPENSCOUT_INSTANCE",saved.instance]]){
   if(value===undefined)delete process.env[key!];else process.env[key!]=value;
  }
 }
});

test("host-bound capsule reclamation uses stable persisted claims and keeps descriptor guards",()=>{
 const path=dir(),h=host(),o=bound(path,h);o.mutate(0,"grant",{type:"grant",peer});o.migrateToCapsule("cutover");
 const internal=o as any;internal.operation(undefined,(root:any)=>internal.claimCapsuleSlot(root));
 const receipt=o.reclaimCapsuleStaging("reclaim",{quiescent:true});
 expect(receipt.moved.length).toBeGreaterThan(0);
 expect(o.reclaimCapsuleStaging("reclaim",{quiescent:true})).toEqual(receipt);
 expect(bound(path,h).read()).toEqual({revision:1,peers:[peer]});
 rmSync(path+".pairing-reclamation",{recursive:true,force:true});
});

test("a migrated legacy root id is opaque across restoration and host display-name changes",()=>{
 const parent=dir(),path=join(parent,"store"),old=join(parent,"old");mkdirSync(path,{mode:0o700});
 const h=host(),legacy=new PairingTrustOwner(path);legacy.mutate(0,"grant",{type:"grant",peer});
 const binding=bound(path,h).bindToHost("migration",{quiescent:true});
 expect(binding.authorityId).toMatch(/^\d+:\d+$/);
 const before=bytes(path);renameSync(path,old);mkdirSync(path,{mode:0o700});cpSync(old,path,{recursive:true});
 const restored=bound(path,{...h,identity:{...h.identity,nodeQualifier:"renamed-host"}});
 expect(restored.read()).toEqual({revision:1,peers:[peer]});expect(bytes(path)).toEqual(before);
 expect(JSON.parse(readFileSync(join(path,"trusted-peers.owner.1.json"),"utf8")).generation.rootId).toBe(binding.authorityId);
});
