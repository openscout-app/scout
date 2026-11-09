/** Test-only completed-store builder. This is NOT a migration implementation or
 * runtime API. It only writes an empty, explicitly supplied temporary fixture. */
import {randomUUID} from "node:crypto";
import {lstatSync,readFileSync,writeFileSync,readdirSync,unlinkSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pairingTrustOwner, type PairingTrustOwner, type TrustedPeer} from "../../packages/runtime/src/pairing-security/trust-owner.ts";
import {pack,digest,CUTOVER,commitName,doneName,dataName,CHUNK_TARGET,
  type CapsuleRow,type CapsuleBarrier,type CapsuleHead,type ManagedPolicy} from "../../packages/runtime/src/pairing-security/trust-capsule.ts";

export function legacyFixture(path:string, options:{generations?:number;keys?:number;factory?:typeof pairingTrustOwner;
  prepare?:(owner:PairingTrustOwner)=>void;projection?:string|null;bindHost?:boolean}={}) {
  const root=realpathSync(path), temp=realpathSync(tmpdir());
  if(!root.startsWith(temp+"/") || !root.split("/").at(-1)!.startsWith("pairing-capsule-") || readdirSync(root).length)throw Error("empty temporary capsule fixture required");
  const generations=options.generations??1, keyCount=options.keys??(generations?1:0);
  const stat=lstatSync(root), rootId=`${stat.dev}:${stat.ino}`;
  const owner=(options.factory??pairingTrustOwner)(root), keys=Array.from({length:keyCount},(_,i)=>(i+1).toString(16).padStart(64,"0"));
  const peers:TrustedPeer[]=[]; let previousHash=digest(JSON.stringify(peers,null,2));
  for(let revision=1;revision<generations;revision++){
    let peer:TrustedPeer;
    if(revision<=keyCount){peer={publicKey:keys[revision-1]!,pairedAt:"2026-01-01T00:00:00Z"};peers.push(peer);}
    else{peer={...peers[0]!,name:`name-${revision%2}`};peers[0]=peer;}
    const generation={schema:"scout.pairing-trust-owner/v1",rootId,revision,previousHash,
      peersHash:digest(JSON.stringify(peers,null,2)),peers,managed:null,
      mutation:{request:JSON.stringify([revision-1,"grant",peer,null]),outcome:{mutationId:`fixture-${revision}`,revision,type:"grant",publicKey:peer.publicKey,changed:true}}};
    const bytes=pack("generation",generation);writeFileSync(join(root,`trusted-peers.owner.${revision}.json`),bytes,{mode:0o600});previousHash=digest(bytes);
  }
  if(generations>1)writeFileSync(join(root,"trusted-peers.json"),JSON.stringify(peers,null,2),{mode:0o600});
  if(options.bindHost)owner.bindToHost("fixture-host",{quiescent:true});
  if(generations){
    const before=owner.read();if(before.revision!==generations-1)throw Error("legacy fixture verification failed");
    const peer={publicKey:keys[0]!,pairedAt:"2026-01-01T00:00:00Z",name:"final-name"};
    owner.mutate(generations-1,"fixture-final-publication",{type:"grant",peer});
  }
  options.prepare?.(owner);
  if(options.projection===null){try{unlinkSync(join(root,"trusted-peers.json"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  else if(options.projection!==undefined)writeFileSync(join(root,"trusted-peers.json"),options.projection,{mode:0o600});
  return {root,rootId,owner,keys};
}

export function capsuleFixture(path:string, options:Parameters<typeof legacyFixture>[1]&{migrate?:boolean}={}) {
  const {root,rootId,owner,keys}=legacyFixture(path,options);
  // Test-only access to the real owner's coherent state. Never merge advisory
  // display fields or authorize from a pair of unrelated read/stamp calls.
  const internals=owner as any;
  const state=internals.operation(undefined,(r:unknown)=>internals.readyState(r));
  const stamp=digest(JSON.stringify([rootId,state.revision,state.hash,state.projectionHash,state.managed]));
  const rows:CapsuleRow[]=[]; let charge=0,policy:ManagedPolicy|null=null;
  const legacyNames:string[]=[];
  for(let revision=1;revision<=state.revision;revision++){
    const name=`trusted-peers.owner.${revision}.json`, bytes=readFileSync(join(root,name));legacyNames.push(name);
    const g=JSON.parse(bytes.toString()).generation,{request,outcome:o}=g.mutation;
    const marker=o.type==="manage"?g.managed:null;
    rows.push([o.mutationId,o.revision,o.type,o.publicKey,o.changed,request,bytes.length,marker]);charge+=bytes.length;
    if(marker)policy={revision,marker};
  }
  if(options.migrate){
    owner.migrateToCapsule("fixture-cutover");
    const barrierName=`trusted-peers.owner.${state.revision+1}.json`;
    const barrier=JSON.parse(readFileSync(join(root,barrierName),"utf8")).barrier as CapsuleBarrier;
    const bytes=readFileSync(join(root,commitName(1))),head=JSON.parse(bytes.toString()).capsule as CapsuleHead;
    if(barrier.migration?.migrationId!=="fixture-cutover")throw Error("real cutover receipt required");
    return {root,rootId,owner,keys,rows,barrier,barrierName,head,stamp,physicalHash:digest(bytes),legacyBytes:charge};
  }
  const parts:CapsuleBarrier["parts"]=[];let group:string[]=[],size=2;
  const flush=()=>{if(!group.length)return;const bytes=`[${group.join(",")}]`, name=dataName(randomUUID());
    writeFileSync(join(root,name),bytes,{mode:0o600});parts.push({name,sha256:digest(bytes),bytes:Buffer.byteLength(bytes),count:group.length});group=[];size=2;};
  for(const row of rows){const value=JSON.stringify(row);if(size+Buffer.byteLength(value)+1>CHUNK_TARGET)flush();group.push(value);size+=Buffer.byteLength(value)+1;}flush();
  const outcomesDigest=digest(JSON.stringify(rows)),checkpointPeersHash=digest(JSON.stringify(state.peers,null,2));
  const barrier:CapsuleBarrier={schema:"scout.pairing-cut/v2",rootId,revision:state.revision,logicalHead:state.hash,
    logicalPeersHash:state.peersHash,checkpointPeersHash,projectionHash:state.projectionHash,outcomesDigest,chargedBytes:charge,policy,parts};
  const barrierBytes=pack("barrier",barrier), cutHash=digest(barrierBytes), barrierName=`trusted-peers.owner.${state.revision+1}.json`;
  const head:CapsuleHead={schema:"scout.pairing-capsule/v2",rootId,cutHash,serial:1,revision:state.revision,
    logicalHead:state.hash,previousLogicalHead:state.hash,previousPhysicalHead:cutHash,logicalPeersHash:state.peersHash,
    checkpointPeersHash,projectionHash:state.projectionHash,peers:state.peers,policy,outcomesDigest,chargedBytes:charge,
    parts,adoption:state.adoption,slot:null,retire:[]};
  const header=pack("capsule",head), physicalHash=digest(header);
  writeFileSync(join(root,barrierName),barrierBytes,{mode:0o600});
  writeFileSync(join(root,CUTOVER),pack("receipt",{schema:"scout.pairing-cutover-done/v2",rootId,cutHash}),{mode:0o600});
  writeFileSync(join(root,commitName(1)),header,{mode:0o600});
  writeFileSync(join(root,doneName(1)),pack("receipt",{schema:"scout.pairing-collected/v2",rootId,serial:1,physicalHash}),{mode:0o600});
  for(const name of legacyNames)unlinkSync(join(root,name));
  return {root,rootId,owner,keys,rows,barrier,barrierName,head,stamp,physicalHash,legacyBytes:charge};
}
