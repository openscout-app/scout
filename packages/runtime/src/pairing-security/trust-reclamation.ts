/** Internal trusted-local maintenance. No activation or filesystem I/O on import.
 * This is not a liveness detector. The caller must exclude ALL root users. */
import {constants,openSync,closeSync,fstatSync,lstatSync,mkdirSync,readdirSync,readFileSync,
  writeFileSync,fsyncSync,renameSync,type Stats} from "node:fs";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {pack,unpack,token,integer,hex,same,dataName,stageName,type CapsuleSlot} from "./trust-capsule.js";
import type {PairingRootIdentity} from "./trust-owner.js";
export type ReclamationAuthority = {revision:number;logicalHead:string;physicalHead:string;cutHash:string;
  references:Set<string>;tokens:Set<string>};
export type CapsuleReclamationReceipt = Readonly<{
  schema:"scout.pairing-staging-reclaimed/v1";reclamationId:string;rootId:string;planHash:string;
  evidenceDirectory:string;verified:{revision:number;logicalHead:string;physicalHead:string};
  moved:readonly {kind:"candidate"|"claim"|"payload";from:string;to:string;token:string;why:string}[];
  retained:readonly {source:string;why:string}[];
}>;
type FileProof={source:string;identity:string;bytes:number;sha256:string};
type Claim=CapsuleSlot&{rootId:string};
type Group={kind:"candidate"|"claim";source:string;claim:Claim;claimFile:FileProof;payloads:FileProof[]};
type Plan={schema:"scout.pairing-staging-reclamation/v1";reclamationId:string;rootId:string;
  authority:{revision:number;logicalHead:string;physicalHead:string;cutHash:string};groups:Group[];
  retained:{source:string;why:string}[]};
/** objectId/objectIs/rootIs come from the owner: persisted ids are keyed by the
 * host identity, and legacy dev:ino ids match by inode. */
type Hooks={check():void;authority():ReclamationAuthority;fail(code:string):never;
  objectId(s:Stats):string;objectIs(value:unknown,s:Stats):boolean;rootIs(value:unknown):boolean};
const LIMIT=1024*1024,WHY="verified full token; unreferenced by completed authority";
// Same-boot pin identity only. Never persisted.
const identity=(s:Stats)=>`${s.dev}:${s.ino}`;
const digest=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const candidates=/^\.pairing-claim-[a-f0-9-]{36}$/;
const slots=/^\.pairing-v2-slot-[0-7]$/;
const identityFormat=(v:unknown)=>typeof v==="string"&&/^(?:o2:[a-f0-9]{64}|\d+:\d+)$/.test(v);
const payloads=(t:string)=>[dataName(t),...(["peers","commit","marker","done"] as const).map(r=>stageName(t,r))];
/** Exported only for the canonical owner. All proof callbacks are lexically
 * supplied there, never selected by an application, wire field or environment. */
export function reclaimCapsuleStaging(root:PairingRootIdentity,reclamationId:string,hooks:Hooks):CapsuleReclamationReceipt {
 const fail=hooks.fail;
 const owned=(s:Stats,directory=false)=>{
  if(s.isSymbolicLink() || (directory?!s.isDirectory():!s.isFile()) || s.uid!==process.getuid?.()
    || (s.mode&0o022)!==0 || (!directory&&((s.mode&0o077)!==0||s.nlink!==1)))fail("reclamation_unsafe_path");
 };
 const exists=(path:string)=>{try{return lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}};
 type Pin={path:string;fd:number;id:string};
 const pin=(path:string):Pin=>{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const s=fstatSync(fd);owned(s,true);const p={path,fd,id:identity(s)};check(p);return p;}catch(e){closeSync(fd);throw e;}};
 function check(p:Pin){hooks.check();const s=lstatSync(p.path);owned(s,true);
  if(identity(s)!==p.id||identity(fstatSync(p.fd))!==p.id)fail("reclamation_directory_changed");}
 const sync=(p:Pin)=>{check(p);fsyncSync(p.fd);check(p);};
 const read=(p:Pin,name:string):{bytes:Buffer;proof:FileProof}=>{
  check(p);if(name.includes("/")||name==="."||name==="..")fail("reclamation_invalid_plan");
  const fd=openSync(join(p.path,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=fstatSync(fd);owned(s);if(s.size>LIMIT||identity(lstatSync(join(p.path,name)))!==identity(s))fail("reclamation_file_changed");
   const bytes=readFileSync(fd);if(bytes.length!==s.size||identity(lstatSync(join(p.path,name)))!==identity(s))fail("reclamation_file_changed");
   check(p);return {bytes,proof:{source:name,identity:hooks.objectId(s),bytes:bytes.length,sha256:digest(bytes)}};
  }finally{closeSync(fd);}
 };
 const write=(p:Pin,name:string,bytes:string)=>{
  check(p);if(Buffer.byteLength(bytes)>LIMIT)fail("reclamation_capacity");
  writeFileSync(join(p.path,name),bytes,{mode:0o600,flag:"wx"});
  const fd=openSync(join(p.path,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{owned(fstatSync(fd));fsyncSync(fd);}finally{closeSync(fd);}sync(p);
 };
 // With a directory stat, the claim must name that directory. Without one,
 // only its shape is checked (a claim copied into the plan).
 const claimValid=(c:Claim,dir?:Stats)=>{
  if(!c || !hooks.rootIs(c.rootId) || !integer(c.index,0,7) || !token(c.token) || !identityFormat(c.identity)
    || (dir && !hooks.objectIs(c.identity,dir))
    || !same(c,{rootId:c.rootId,index:c.index,token:c.token,identity:c.identity}))fail("reclamation_token_invalid");
 };
 const rootPin=pin(root.path);
 let base:Pin|undefined,op:Pin|undefined;
 try{
  const initial=hooks.authority(); // Complete committed publication BEFORE scanning resources.
  const scan=():Pick<Plan,"groups"|"retained">=>{
   const groups:Group[]=[],retained:Plan["retained"]=[],names=readdirSync(root.path).sort(),seen=new Set<string>();
   const selected=names.filter(n=>n.startsWith(".pairing-claim-")||n.startsWith(".pairing-v2-slot-"));
   if(selected.length>1024)fail("reclamation_capacity");
   for(const name of selected){
    if(!candidates.test(name)&&!slots.test(name))fail("reclamation_token_invalid");
    const dir=pin(join(root.path,name));
    try{
     const children=readdirSync(dir.path);
     if(!children.length){retained.push({source:name,why:"empty directory has no full token; left for structural reclamation or reviewed repair"});continue;}
     if(children.length!==1||!/^([a-f0-9-]{36})\.json$/.test(children[0]!))fail("reclamation_token_invalid");
     const child=children[0]!,file=read(dir,child),claim=unpack<Claim>(file.bytes,"claim",fail);
     claimValid(claim,fstatSync(dir.fd));
     if(child!==`${claim.token}.json`||(slots.test(name)&&name!==`.pairing-v2-slot-${claim.index}`)||seen.has(claim.token))fail("reclamation_token_invalid");
     seen.add(claim.token);
     const g:Group={kind:slots.test(name)?"claim":"candidate",source:name,claim,claimFile:file.proof,payloads:[]};
     assertUnreferenced(g,initial);
     // Candidates never stage bulk. Canonical claims own only these exact names.
     if(g.kind==="claim")for(const n of payloads(claim.token))if(exists(join(root.path,n)))g.payloads.push(read(rootPin,n).proof);
     groups.push(g);check(dir);
    }finally{closeSync(dir.fd);}
   }
   return {groups,retained};
  };
  function assertUnreferenced(g:Group,a:ReclamationAuthority){
   if(a.tokens.has(g.claim.token)||a.references.has(g.source)||payloads(g.claim.token).some(n=>a.references.has(n)))fail("reclamation_referenced");
  }
  const evidence=root.path+".pairing-reclamation",operation=join(evidence,`op.${reclamationId}`);
  const ensure=(path:string)=>{try{mkdirSync(path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
   const p=pin(path);if((fstatSync(p.fd).mode&0o077)!==0||fstatSync(p.fd).dev!==fstatSync(rootPin.fd).dev){closeSync(p.fd);fail("reclamation_unsafe_evidence");}return p;};
  // Plan discovery never moves or deletes. The caller asserts exclusive maintenance.
  const prior=exists(join(operation,"plan.json"));
  let plan:Plan,planHash:string;
  if(prior){base=ensure(evidence);op=ensure(operation);const bytes=read(op,"plan.json").bytes;
   plan=unpack<Plan>(bytes,"reclamation",fail);planHash=digest(bytes);
  }else{
   const found=scan();base=ensure(evidence);
   // The parent is outside the trust boundary: sync its entry exactly as the
   // owner does. Store/evidence objects retain every ownership and pin check.
   const parent=openSync(dirname(root.path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{fsyncSync(parent);}finally{closeSync(parent);}
   op=ensure(operation);sync(base);
   if(readdirSync(op.path).length)fail("reclamation_invalid_plan");
   plan={schema:"scout.pairing-staging-reclamation/v1",reclamationId,rootId:root.id,
    authority:{revision:initial.revision,logicalHead:initial.logicalHead,physicalHead:initial.physicalHead,cutHash:initial.cutHash},...found};
   const bytes=pack("reclamation",plan);write(op,"plan.json",bytes);planHash=digest(bytes);
  }
  if(plan.schema!=="scout.pairing-staging-reclamation/v1"||!hooks.rootIs(plan.rootId)||plan.reclamationId!==reclamationId
    ||!Array.isArray(plan.groups)||plan.groups.length>1024||!Array.isArray(plan.retained)
    ||!integer(plan.authority?.revision,0,65536)||![plan.authority?.logicalHead,plan.authority?.physicalHead,plan.authority?.cutHash].every(hex))fail("reclamation_invalid_plan");
  const sourceNames=new Set<string>(),tokens=new Set<string>();
  const fileValid=(p:FileProof)=>typeof p?.source==="string"&&typeof p.identity==="string"&&identityFormat(p.identity)&&integer(p.bytes,0,LIMIT)&&hex(p.sha256);
  for(const g of plan.groups){
   claimValid(g.claim);
   if(!["candidate","claim"].includes(g.kind)||typeof g.source!=="string"||!(g.kind==="candidate"?candidates.test(g.source):g.source===`.pairing-v2-slot-${g.claim.index}`)
     ||tokens.has(g.claim.token)||!fileValid(g.claimFile)||g.claimFile.source!==`${g.claim.token}.json`||!Array.isArray(g.payloads)
     ||g.payloads.length>5||(g.kind==="candidate"&&g.payloads.length))fail("reclamation_invalid_plan");
   tokens.add(g.claim.token);
   for(const n of [g.source,...g.payloads.map(p=>p.source)]){if(sourceNames.has(n))fail("reclamation_invalid_plan");sourceNames.add(n);}
   if(g.payloads.some(p=>!fileValid(p)||!payloads(g.claim.token).includes(p.source)))fail("reclamation_invalid_plan");
  }
  if(plan.retained.some(p=>typeof p.source!=="string"||(!candidates.test(p.source)&&!slots.test(p.source))||typeof p.why!=="string"))fail("reclamation_invalid_plan");
  const syncFile=(p:Pin,name:string)=>{
   const proof=read(p,name).proof,fd=openSync(join(p.path,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{owned(fstatSync(fd));if(!hooks.objectIs(proof.identity,fstatSync(fd)))fail("reclamation_resource_changed");
    fsyncSync(fd);if(identity(lstatSync(join(p.path,name)))!==identity(fstatSync(fd)))fail("reclamation_resource_changed");
   }finally{closeSync(fd);}check(p);
  };
  // A prior process may have written a complete plan but died before its fsync.
  // Re-establish its durability before ANY resource move on every resume.
  syncFile(op,"plan.json");sync(op);sync(base);
  const locate=(name:string)=>{const source=exists(join(root.path,name)),target=exists(join(op!.path,name));
   if(!!source===!!target)fail("reclamation_resource_changed");return source?rootPin:op!;};
  const verifyFile=(where:Pin,p:FileProof)=>{if(!same(read(where,p.source).proof,p))fail("reclamation_resource_changed");};
  const verifyGroup=(g:Group)=>{
   const where=locate(g.source),dir=pin(join(where.path,g.source));
   try{const c=read(dir,g.claimFile.source);claimValid(unpack<Claim>(c.bytes,"claim",fail),fstatSync(dir.fd));
    if(!hooks.objectIs(g.claim.identity,fstatSync(dir.fd))||!same(readdirSync(dir.path),[g.claimFile.source])||!same(c.proof,g.claimFile)
      ||!same(unpack<Claim>(c.bytes,"claim",fail),g.claim))fail("reclamation_token_invalid");check(dir);
   }finally{closeSync(dir.fd);}
   for(const p of g.payloads)verifyFile(locate(p.source),p);
   if(g.kind==="claim"&&payloads(g.claim.token).some(n=>exists(join(root.path,n))&&!g.payloads.some(p=>p.source===n)))fail("reclamation_resource_changed");
  };
  const moved=plan.groups.flatMap(g=>[...g.payloads.map(p=>({kind:"payload" as const,from:join(root.path,p.source),to:join(op!.path,p.source),token:g.claim.token,why:WHY})),
   {kind:g.kind,from:join(root.path,g.source),to:join(op!.path,g.source),token:g.claim.token,why:WHY}]);
  // Retry validates all retained artifacts and current authority, not an old positive.
  if(exists(join(op.path,"receipt.json"))){
   const receipt=unpack<CapsuleReclamationReceipt>(read(op,"receipt.json").bytes,"receipt",fail);
   if(receipt.schema!=="scout.pairing-staging-reclaimed/v1"||receipt.reclamationId!==reclamationId||!hooks.rootIs(receipt.rootId)
    ||receipt.planHash!==planHash||receipt.evidenceDirectory!==op.path
    ||!integer(receipt.verified?.revision,0,65536)||!hex(receipt.verified?.logicalHead)||!hex(receipt.verified?.physicalHead)||!same(receipt.moved,moved)||!same(receipt.retained,plan.retained))fail("reclamation_invalid_receipt");
   for(const g of plan.groups){verifyGroup(g);if(locate(g.source)!==op||g.payloads.some(p=>locate(p.source)!==op))fail("reclamation_invalid_receipt");}
   hooks.authority();syncFile(op,"receipt.json");sync(op);sync(base);sync(rootPin);return structuredClone(receipt);
  }
  for(const g of plan.groups){assertUnreferenced(g,hooks.authority());verifyGroup(g);}
  for(const g of plan.groups){
   // Payloads precede their token directory: every partial state remains readable.
   for(const p of [...g.payloads,{source:g.source}]){
    assertUnreferenced(g,hooks.authority());verifyGroup(g);check(op);check(rootPin);
    if(locate(p.source)===rootPin){
     // Pin the token-bearing object across validation, rename and destination sync.
     const dir=pin(join(locate(g.source).path,g.source));
     let fileFd:number|undefined;
     try{
      verifyGroup(g);check(dir);
      const fileName=p.source===g.source?join(dir.path,g.claimFile.source):join(root.path,p.source);
      const proof=p.source===g.source?g.claimFile:g.payloads.find(f=>f.source===p.source)!;
      fileFd=openSync(fileName,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      owned(fstatSync(fileFd));
      if(!hooks.objectIs(proof.identity,fstatSync(fileFd)))fail("reclamation_resource_changed");
      fsyncSync(fileFd); // Retain interrupted, possibly unsynced payload bytes too.
      if(identity(lstatSync(fileName))!==identity(fstatSync(fileFd)))fail("reclamation_resource_changed");
      renameSync(join(root.path,p.source),join(op.path,p.source));
      if(p.source===g.source){dir.path=join(op.path,g.source);check(dir);sync(dir);}
      else if(identity(lstatSync(join(op.path,p.source)))!==identity(fstatSync(fileFd)))fail("reclamation_resource_changed");
      sync(op);sync(rootPin);
     }finally{if(fileFd!==undefined)closeSync(fileFd);closeSync(dir.fd);}
    }
    sync(op);sync(rootPin);
   }
  }
  const verified=hooks.authority();
  const receipt:CapsuleReclamationReceipt={schema:"scout.pairing-staging-reclaimed/v1",reclamationId,rootId:root.id,planHash,
   evidenceDirectory:op.path,verified:{revision:verified.revision,logicalHead:verified.logicalHead,physicalHead:verified.physicalHead},moved,retained:plan.retained};
  write(op,"receipt.json",pack("receipt",receipt));sync(op);sync(base);sync(rootPin);
  return structuredClone(receipt);
 }finally{if(op)closeSync(op.fd);if(base)closeSync(base.fd);closeSync(rootPin.fd);}
}
