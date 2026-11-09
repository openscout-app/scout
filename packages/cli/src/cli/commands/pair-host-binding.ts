import {existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, openSync, closeSync, fsyncSync, readdirSync, unlinkSync} from "node:fs";
import {join} from "node:path";
import {PairingTrustOwner} from "@openscout/runtime/pairing-security/trust-owner";
import {resolveOpenScoutSupportPaths} from "@openscout/runtime/support-paths";
import {resolveScoutPairingSupervisorPaths, readScoutPairingProcessPid, isScoutPairingProcessRunning,
  readScoutPairingSupervisorIntent} from "@openscout/runtime/pairing-supervisor";
import type {ScoutCommandContext} from "../context.ts";

/** Trusted operator maintenance, deliberately independent of a running runtime.
 * --quiescent asserts exclusion of any untracked/older writers; known services
 * are also checked rather than trusting the assertion alone. */
export function runPairHostBinding(context: ScoutCommandContext, args: string[]): void {
  if (args.length !== 2 || !/^[a-zA-Z0-9._:-]{1,128}$/.test(args[0] ?? "") || args[1] !== "--quiescent")
    throw Error("Usage: scout pair bind-host <migration-id> --quiescent. Stop Scout and exclude all old writers first.");
  const paths=resolveScoutPairingSupervisorPaths(), support=resolveOpenScoutSupportPaths();
  const assertStopped=()=>{
    for(const file of [paths.runtimePidPath,paths.supervisorPidPath])
      if(isScoutPairingProcessRunning(readScoutPairingProcessPid(file))) throw Error("Stop Scout's runtime, pairing controller and supervisor before scout pair bind-host.");
    if(readScoutPairingSupervisorIntent(paths.intentPath).desiredState === "running")
      throw Error("Pairing restart intent is running; stop Scout before scout pair bind-host.");
    for(const [file,keys] of [["broker-heartbeat.json",["pid"]],["scoutd-state.json",["scoutdPid","basePid","probePid"]]] as const){
      const path=join(support.runtimeDirectory,file);if(!existsSync(path))continue;
      let record:Record<string,unknown>;try{record=JSON.parse(readFileSync(path,"utf8"));}catch{throw Error("Cannot verify stopped runtime: "+file);}
      if(!record||typeof record!=="object"||Array.isArray(record))throw Error("Invalid runtime status: "+file);
      for(const key of keys){const pid=record[key];if(pid!==undefined&&pid!==null&&(!Number.isInteger(pid)||Number(pid)<0))throw Error("Invalid runtime pid: "+file);
        if(isScoutPairingProcessRunning(typeof pid==="number"?pid:null))throw Error("Stop Scout's runtime before scout pair bind-host ("+file+").");}
    }
  };
  assertStopped();
  const inventory=readdirSync(paths.rootDir);
  if(inventory.some(name=>name==='trusted-peers.managed.json'||name.startsWith('trusted-peers.v2.')
    ||name.startsWith('.pairing-')&&!/^\.pairing-host-binding-[a-f0-9-]{36}\.tmp$/.test(name)))
    throw Error('Managed, capsule or pending pairing stores require separate reviewed recovery before host binding.');
  // Existing authority is validated through the explicit legacy-maintenance
  // seam before a private, retained backup and before signing any binding.
  const owner=new PairingTrustOwner(paths.rootDir),before=owner.readAuthority();
  const backup=join(support.supportDirectory,"recovery",`pairing-host-binding-${args[0]}-${Date.now()}`);
  mkdirSync(backup,{recursive:true,mode:0o700});
  const names=["trusted-peers.json",...Array.from({length:before.revision},(_,i)=>`trusted-peers.owner.${i+1}.json`),"trusted-peers.host-binding.json"];
  const sync=(path:string)=>{const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}};
  // Only unlinked binding temporaries are unpublished evidence. Quarantine
  // them during explicit quiescent maintenance; never infer stale live claims.
  const orphans=readdirSync(paths.rootDir).filter(name=>/^\.pairing-host-binding-[a-f0-9-]{36}\.tmp$/.test(name));
  for(const name of [...names,...orphans]){const source=join(paths.rootDir,name);if(!existsSync(source))continue;
    const stat=lstatSync(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw Error("Unsafe pairing backup source: "+name);
    writeFileSync(join(backup,name),readFileSync(source),{mode:0o600,flag:"wx"});sync(join(backup,name));}
  sync(backup);sync(join(support.supportDirectory,"recovery"));
  assertStopped();
  for(const name of orphans){const source=join(paths.rootDir,name),stat=lstatSync(source);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)||!readFileSync(source).equals(readFileSync(join(backup,name))))throw Error("Unpublished binding stage changed; keep Scout stopped.");
    unlinkSync(source);}
  if(orphans.length)sync(paths.rootDir);
  assertStopped();
  const binding=owner.bindToHost(args[0]!,{quiescent:true}),after=owner.readAuthority();
  if(before.revision!==after.revision||JSON.stringify(before.peers)!==JSON.stringify(after.peers))throw Error("Pairing authority changed during host binding; keep Scout stopped and inspect backup.");
  context.output.writeValue({ok:true,revision:after.revision,peers:after.peers.length,hostKeyId:binding.hostKeyId,
    storeId:binding.storeId,migrationId:binding.migrationId,backup},value=>`Bound pairing store to this host: revision ${value.revision}, ${value.peers} peers. Backup: ${value.backup}`);
}
