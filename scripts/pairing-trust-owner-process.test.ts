import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pairingTrustOwner, type PairingTrustAdapter } from "../packages/runtime/src/pairing-security/trust-owner.ts";
import {loadOrCreateNodeIdentity} from "../packages/runtime/src/node-identity.ts";
import {capsuleFixture} from "./fixtures/pairing-capsule.ts";

const project = fileURLToPath(new URL("..", import.meta.url)), worker = join(project, "scripts/pairing-trust-owner-worker.ts");
const roots: string[] = [], cleanups: Array<() => void> = [];
// Share an independent host key across parent and real workers. Bind fixtures
// before tracing fault-injected I/O, exactly as production maintenance does.
const support=mkdtempSync(join(tmpdir(),"pairing-owner-host-"));
const priorSupport=process.env.OPENSCOUT_SUPPORT_DIRECTORY;
process.env.OPENSCOUT_SUPPORT_DIRECTORY=support;loadOrCreateNodeIdentity(support);
afterAll(()=>{if(priorSupport===undefined)delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;else process.env.OPENSCOUT_SUPPORT_DIRECTORY=priorSupport;rmSync(support,{recursive:true,force:true});});
const key = "a".repeat(64), peer = {publicKey: key, pairedAt: "2026-01-01T00:00:00Z"};
function fixture() { const root = mkdtempSync(join(tmpdir(), "pairing-owner-process-")); roots.push(root); const data = join(root,"data"), coordination = join(root,"coordination"); mkdirSync(data, {mode: 0o700}); mkdirSync(coordination); pairingTrustOwner(data).bindToHost("fixture-host",{quiescent:true}); return {root, data, coordination}; }
function launch(mode: string, data: string, coordination: string, detail = "", extra: Record<string,string> = {}) {
  return Bun.spawn([process.execPath, "--no-install", worker, mode, data, coordination, detail], {
    cwd: project, env: {...process.env, HOME: dirname(data), OPENSCOUT_HOME: join(dirname(data),"home"), OPENSCOUT_CONTROL_HOME: join(dirname(data),"control"), OPENSCOUT_PAIRING_HOME: data, ...extra}, stdout: "pipe", stderr: "pipe",
  });
}
async function result(child: ReturnType<typeof launch>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {code, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)!) : null};
}
async function ready(path: string) { const end = Date.now()+10_000; while (!existsSync(path)) { if (Date.now()>end) throw Error("ready timeout"); await Bun.sleep(5); } }
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

function completedCapsule(managed=false,generations=1){
  const f=fixture(),data=join(f.root,"pairing-capsule-data");mkdirSync(data,{mode:0o700});
  let unregister:(()=>void)|undefined;
  const store=capsuleFixture(data,{generations,migrate:true,bindHost:true,prepare:managed?owner=>{
    let holder:object|null=null;
    unregister=owner.register({id:"test.adapter",withGate(_r,body){holder={};try{return body(holder);}finally{holder=null;}},currentHolder(){return holder;}});
    owner.withInvocation(c=>owner.mutate(1,"fixture-manage",{type:"manage"},c));
  }:undefined});
  unregister?.();
  return {...f,data,store};
}
describe("v2 real process publication and recovery",()=>{
  test("actual v2 barriers bracket CAS, retirement, receipt and claim release",async()=>{
    const {data,coordination}=completedCapsule(),output=await result(launch("capsule-write",data,coordination,JSON.stringify({expected:1})));
    expect(output.value).toMatchObject({ok:true,result:{revision:2}});
    const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    const linked=events.findIndex(e=>e.event==="link"),projection=events.findIndex(e=>e.event==="rename" && e.target.endsWith("trusted-peers.json"));
    const retired=events.map((e,i)=>e.event==="unlink" && (e.path.includes(".commit.") || e.path.includes(".done."))?i:-1).filter(i=>i>=0);
    const receipt=events.findIndex(e=>e.event==="rename" && e.target.includes(".done."));
    const released=events.findIndex(e=>e.event==="unlink" && e.path.includes(".pairing-v2-slot-"));
    const dirsync=(from:number,to:number)=>events.slice(from+1,to).some(e=>e.event==="sync_success" && e.directory && e.path.endsWith("/pairing-capsule-data"));
    expect(linked).toBeGreaterThan(0);expect(projection).toBeGreaterThan(linked);expect(retired).toHaveLength(2);
    expect(dirsync(linked,retired[0]!)).toBe(true);expect(dirsync(retired.at(-1)!,receipt)).toBe(true);expect(dirsync(receipt,released)).toBe(true);
    const staged=events.slice(0,linked).filter(e=>e.event==="sync_success" && !e.directory);
    expect(staged).toHaveLength(5);expect(events.filter(e=>e.event==="sync_success")).toHaveLength(16);
    expect(dirsync(-1,linked)).toBe(true);
  }, 30000);
  test("fresh process validates early outcome bytes rather than a prior positive",async()=>{
    const {data,coordination,store}=completedCapsule();
    expect((await result(launch("read",data,coordination))).value.ok).toBe(true);
    const path=join(data,store.head.parts[0]!.name),bytes=readFileSync(path,"utf8");
    writeFileSync(path,bytes.replace("fixture-final","fixture-dirty"));
    const changed=await result(launch("read",data,coordination));expect(changed.value.ok).toBe(false);expect(changed.value.error).toContain("capsule_chunk_checksum");
  }, 30000);
  test("runtime and desktop Noise plus web revoke use the same managed v2 owner",async()=>{
    const {data,coordination}=completedCapsule(false,0),output=await result(launch("capsule-paths",data,coordination));
    expect(output.code,output.stderr).toBe(0);expect(output.value).toEqual({ok:true,removed:true,revision:4,peers:1,reconnectGenerations:0});
    const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    const publications=events.filter(e=>(e.event==="link" || e.event==="rename") && !e.target.endsWith("trusted-peers.last-seen.json"));
    expect(publications.filter(e=>!/\.pairing-v2-slot-[0-7]$/.test(e.target))).toHaveLength(13);
    expect(publications.filter(e=>/\.pairing-v2-slot-[0-7]$/.test(e.target))).toHaveLength(4);
    expect(publications.every(e=>e.held===true)).toBe(true);
    expect(readdirSync(data).filter(n=>n.includes(".commit."))).toEqual(["trusted-peers.v2.commit.5.json"]);
  }, 30000);
  test("real interruptions retain exact retries, bounded collection and fresh readers",async()=>{
    for(const managed of [false,true])for(const point of ["after-staging","after-cas","after-publication-sync","after-projection","after-witness","during-collection","after-receipt","after-token-release","lost-ack"]){
      const {data,coordination}=completedCapsule(managed),expected=managed?2:1;
      const options={point,managed,expected,id:"capsule-write"};
      const crashed=await result(launch("capsule-write",data,coordination,JSON.stringify(options)));
      expect(crashed.code,`${managed}:${point}: ${crashed.stderr}`).toBe(point==="lost-ack"?82:81);
      const recovered=await result(launch("capsule-recover",data,coordination,JSON.stringify({managed})));
      expect(recovered.value,`${managed}:${point}`).toMatchObject({ok:true,snapshot:{revision:expected+(point==="after-staging"?0:1)}});
      // A pre-CAS crash is a bounded abandoned resource claim, not authority.
      const retried=await result(launch("capsule-write",data,coordination,JSON.stringify({managed,expected,id:"capsule-write"})));
      expect(retried.value,`${managed}:${point}`).toMatchObject({ok:true,result:{mutationId:"capsule-write",revision:expected+1}});
      expect(readdirSync(data).filter(n=>n.includes(".commit.")).length).toBe(1);
      expect(readdirSync(data).filter(n=>n.includes(".done.")).length).toBe(1);
      expect(readdirSync(data).filter(n=>n.startsWith(".pairing-v2-slot-")).length).toBe(["after-staging","after-token-release"].includes(point)?1:0);
      if(point==="after-token-release"){
        // An exact retry need not stage anything. A NEW mutation proves the
        // empty slot is reclaimable and can no longer brick revocation.
        const later=await result(launch("capsule-write",data,coordination,JSON.stringify({managed,expected:expected+1,id:"reclaim-after-release",mutation:{type:"revoke",publicKey:key}})));
        expect(later.value).toMatchObject({ok:true,result:{revision:expected+2}});
        expect(readdirSync(data).filter(n=>n.startsWith(".pairing-v2-slot-")).length).toBe(0);
      }
      console.log(JSON.stringify({capsuleCrash:{managed,point},events:readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(JSON.parse)}));
    }
  },60000);
  test("late helpers cannot recreate consumed projection or receipt after a later revoke",async()=>{
    for(const point of ["before-projection","before-receipt"]){
      const {data,coordination,store}=completedCapsule();
      const first=launch("capsule-write",data,coordination,JSON.stringify({point,expected:1,id:"capsule-write"}));
      try{
        await ready(join(coordination,`ready-${point}`));
        expect(store.owner.read().revision).toBe(2);
        store.owner.mutate(2,"later-revoke",{type:"revoke",publicKey:key});
      }finally{writeFileSync(join(coordination,"go"),"go");}
      const output=await result(first);expect(output.value,output.stderr).toMatchObject({ok:true,result:{revision:2}});
      expect(store.owner.read().revision).toBe(3);expect(store.owner.read().peers.some(p=>p.publicKey===key)).toBe(false);
      expect(readdirSync(data).filter(n=>n.includes(".commit."))).toEqual(["trusted-peers.v2.commit.3.json"]);
      expect(readdirSync(data).filter(n=>n.includes(".done."))).toEqual(["trusted-peers.v2.done.3.json"]);
      const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
      expect(events.filter(e=>e.event==="rename" && !/\.pairing-v2-slot-[0-7]$/.test(e.target))).toHaveLength(point==="before-receipt"?1:0);
      expect(events.filter(e=>e.event==="rename" && /\.pairing-v2-slot-[0-7]$/.test(e.target))).toHaveLength(1);
    }
  },30000);
  test("concurrent v2 staging refuses interference without merging stale mutations",async()=>{
    const {data,coordination,store}=completedCapsule();
    const children=["a","b"].map(id=>launch("capsule-race",data,coordination,JSON.stringify({id,expected:1,mutation:{type:"grant",peer:{...peer,publicKey:id.repeat(64)}}})));
    await Promise.all([ready(join(coordination,"ready-a")),ready(join(coordination,"ready-b"))]);writeFileSync(join(coordination,"go"),"go");
    const outputs=await Promise.all(children.map(result));expect(outputs.filter(o=>o.value.ok).length).toBeLessThanOrEqual(1);
    expect(outputs.filter(o=>!o.value.ok).length).toBeGreaterThanOrEqual(1);
    console.log(JSON.stringify({concurrentCapsuleReplies:outputs}));
    const snapshot=store.owner.read();expect([1,2]).toContain(snapshot.revision);
    expect(snapshot.peers).toHaveLength(snapshot.revision);
    // Interference can refuse both candidates before CAS, or lose the winner's
    // ACK after CAS. A caller must obtain a fresh view, not merge stale edits.
    if(snapshot.revision===1)store.owner.mutate(1,"explicit-fresh-attempt",{type:"grant",peer});
    expect(store.owner.read().revision).toBe(2);
  }, 30000);
  test("two paused next-serial CAS contenders publish exactly one head",async()=>{
    const {data,coordination,store}=completedCapsule();
    const children:ReturnType<typeof launch>[]=[];
    try{for(const id of ["a","b"]){children.push(launch("capsule-write",data,coordination,JSON.stringify({point:"before-cas",id,expected:1,mutation:{type:"grant",peer:{...peer,publicKey:id.repeat(64)}}})));await ready(join(coordination,`ready-before-cas-${id}`));}}
    finally{writeFileSync(join(coordination,"go"),"go");}
    const outputs=await Promise.all(children.map(result));
    // The winner may lose its ACK while the loser cleans its candidate. Disk
    // authority, not number of replies, determines the one winning mutation.
    expect(outputs.filter(o=>o.value.ok).length).toBeLessThanOrEqual(1);
    const snapshot=store.owner.read();expect(snapshot.revision).toBe(2);expect(snapshot.peers).toHaveLength(2);
    const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    expect(events.filter(e=>e.event==="link")).toHaveLength(1);
    const winner=snapshot.peers.some(p=>p.publicKey===key)?"a":"b";
    expect(store.owner.mutate(1,winner,{type:"grant",peer:{...peer,publicKey:winner.repeat(64)}}).revision).toBe(2);
  }, 30000);
  test("failed candidate leaves no authority; failed collector refuses new epochs until repaired",async()=>{
    for(const point of ["sync-fail","rename-fail","collector-fail"]){
      const {data,coordination,store}=completedCapsule();
      const output=await result(launch("capsule-write",data,coordination,JSON.stringify({point,expected:1})));
      expect(output.value.ok).toBe(false);
      if(point==="sync-fail"){
        expect(store.owner.read().revision).toBe(1);expect(readdirSync(data).filter(n=>n.startsWith(".pairing-v2"))).toEqual([]);
      }else{
        expect(output.value.error).toContain(point==="collector-fail"?"capsule_collection_failed":"publication_incomplete");
        const failed=await result(launch("capsule-recover",data,coordination,JSON.stringify({point})));
        expect(failed.value.ok).toBe(false);expect(readdirSync(data).filter(n=>n.includes(".commit.")).length).toBe(2);
        const blocked=await result(launch("capsule-write",data,coordination,JSON.stringify({point,expected:2,id:"must-not-pile-up"})));
        expect(blocked.value.ok).toBe(false);expect(readdirSync(data).filter(n=>n.includes(".commit.")).length).toBe(2);
        expect(store.owner.read().revision).toBe(2);
        expect(readdirSync(data).filter(n=>n.includes(".commit.")).length).toBe(1);
      }
    }
  },30000);
  test("first managed adoption can recover after consuming its sole marker stage",async()=>{
    const {data,coordination}=completedCapsule();
    const output=await result(launch("capsule-write",data,coordination,JSON.stringify({point:"after-marker",managed:true,expected:1,id:"first-manage",mutation:{type:"manage"}})));
    expect(output.code).toBe(81);
    const recovered=await result(launch("capsule-recover",data,coordination,JSON.stringify({managed:true})));
    expect(recovered.value).toMatchObject({ok:true,snapshot:{revision:2}});
    const unregistered=await result(launch("read",data,coordination));expect(unregistered.value.error).toContain("managed_adapter_required");
  },30000);
});

describe("pairing owner real cross-process and I/O paths", () => {
  test("unmanaged CAS race: one winner, one refusal, no lost update", async () => {
    const {data, coordination} = fixture();
    const a = launch("race",data,coordination,"a"), b = launch("race",data,coordination,"b");
    await Promise.all([ready(join(coordination,"ready-a")), ready(join(coordination,"ready-b"))]); writeFileSync(join(coordination,"go"),"go");
    const values = await Promise.all([result(a), result(b)]);
    expect(values.every(v => v.code === 0)).toBe(true);
    expect(values.filter(v => v.value.ok).length).toBe(1);
    expect(values.find(v => !v.value.ok)?.value.error).toMatch(/revision_conflict|publication_incomplete|external_change_or_incomplete|unsafe_path/);
    expect(pairingTrustOwner(data).read().peers.length).toBe(1);
    expect(readdirSync(data).some(name => name.includes("lock"))).toBe(false);
  }, 30000);
  test("a helper completes a live writer; a later revoke survives the original writer resuming", async () => {
    const {data,coordination}=fixture(), first=launch("instrument",data,coordination,"before-projection");
    await ready(join(coordination,"ready-before-projection"));
    const owner=pairingTrustOwner(data);
    expect(owner.read()).toEqual({revision:1,peers:[peer]});
    owner.mutate(1,"revoke",{type:"revoke",publicKey:key});
    writeFileSync(join(coordination,"go"),"go"); const output=await result(first);
    expect(output.value).toMatchObject({ok:true,result:{mutationId:"instrument",revision:1}});
    expect(owner.read()).toEqual({revision:2,peers:[]});
    const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(events.filter(e=>e.event === "rename")).toEqual([]);
  }, 30000);
  test("failed projection rename retains recoverable evidence and reports publication_incomplete", async () => {
    const {data,coordination}=fixture(), output=await result(launch("instrument",data,coordination,"rename-fail"));
    expect(output.value.ok).toBe(false); expect(output.value.error).toContain("publication_incomplete");
    expect(readdirSync(data).filter(n=>n.endsWith(".tmp")).length).toBe(2);
    const owner=pairingTrustOwner(data);
    expect(owner.read()).toEqual({revision:1,peers:[peer]});
    expect(owner.mutate(0,"instrument",{type:"grant",peer}).revision).toBe(1);
  }, 30000);
  test("crash between link and rename rolls forward on the next operation in both modes", async () => {
    for (const managed of [false,true]) for (const revoking of [false,true]) {
      const {data,coordination}=fixture(), owner=pairingTrustOwner(data);
      if (revoking) owner.mutate(0,"seed",{type:"grant",peer});
      if (managed) {
        let holder:object|null=null;
        const remove=owner.register({id:"test.adapter",withGate(_r,body){holder={};try{return body(holder);}finally{holder=null;}},currentHolder(){return holder;}});
        owner.withInvocation(c=>owner.mutate(revoking?1:0,"adopt",{type:"manage"},c));remove();
      }
      const crashed=await result(launch((managed?"managed-instrument":"instrument")+(revoking?"-revoke":""),data,coordination,"after-cas"));
      expect(crashed.code).toBe(73);
      if (managed) expect(()=>owner.read()).toThrow("managed_adapter_required");
      const completed=await result(launch(managed?"recover-managed":"recover",data,coordination));
      expect(completed.value).toEqual({ok:true,snapshot:{revision:(managed?2:1)+(revoking?1:0),peers:revoking?[]:[peer]}});
      const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
      const renames=events.filter(e=>e.event === "rename"); expect(renames.length).toBe(1);
      expect(renames[0].held).toBe(managed);
    }
  }, 30000);
  test("a read unable to finish in-flight publication reports publication_incomplete", async () => {
    const {data,coordination}=fixture(), first=launch("instrument",data,coordination,"before-projection");
    await ready(join(coordination,"ready-before-projection"));
    const reader=await result(launch("recover",data,coordination,"rename-fail"));
    expect(reader.value.ok).toBe(false); expect(reader.value.error).toContain("publication_incomplete");
    writeFileSync(join(coordination,"go"),"go");expect((await result(first)).value.ok).toBe(true);
  }, 30000);
  test("delayed reconnect in another process cannot restore a revoked key", async () => {
    const {data, coordination} = fixture(), owner = pairingTrustOwner(data);
    owner.mutate(0,"seed",{type:"grant",peer});
    const reconnect = launch("reconnect",data,coordination); await ready(join(coordination,"ready-reconnect"));
    owner.mutate(1,"revoke",{type:"revoke",publicKey:key}); writeFileSync(join(coordination,"go"),"go");
    const output = await result(reconnect); expect(output.value.ok).toBe(false); expect(output.value.error).toContain("peer_revoked");
    expect(owner.read().peers).toEqual([]);
  }, 30000);
  test("real barriers reached; crash after publication and ACK-loss retry", async () => {
    for (const point of ["", "after-cas", "after-rename", "sync-1", "sync-2", "sync-3"]) {
      const {data, coordination} = fixture(), output = await result(launch("instrument",data,coordination,point));
      const trace = readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
      expect(trace.some(e=>e.event === "sync")).toBe(true);
      console.log(JSON.stringify({instrument:point||"success",trace}));
      const owner = pairingTrustOwner(data);
      if (point === "after-cas") {
        expect(output.code).toBe(73); expect(owner.read()).toEqual({revision:1,peers:[peer]});
      } else if (point === "after-rename" || point === "sync-3") {
        if (point === "after-rename") expect(output.code).toBe(74); else expect(output.value.ok).toBe(false);
        const retried = owner.mutate(0,"instrument",{type:"grant",peer});
        expect(retried.revision).toBe(1); expect(owner.read().revision).toBe(1);
      } else if (point.startsWith("sync")) {
        expect(output.value.ok).toBe(false); expect(owner.read().revision).toBe(0);
        expect(readdirSync(data).some(n=>n.endsWith(".tmp"))).toBe(false);
      } else {
        expect(output.value.ok).toBe(true);
        expect(trace.filter(e=>e.event === "sync").length).toBe(3);
        expect(trace.filter(e=>e.event === "sync_success").length).toBe(3);
        expect(trace.filter(e=>e.event === "sync_success" && e.directory).length).toBe(1);
        expect(trace.filter(e=>e.event === "link").length).toBe(1);
        expect(trace.filter(e=>e.event === "rename").length).toBe(1);
      }
    }
  }, 30000);
  test("all override spellings select the same owner for runtime and desktop", async () => {
    for (const spelling of ["OPENSCOUT_PAIRING_HOME","SCOUT_PAIRING_HOME","OPENSCOUT_PAIRING_DIR","OPENSCOUT_SCOUT_HOME"]) {
      const fixtureRoot = fixture(), coordination = fixtureRoot.coordination;
      const data = spelling === "OPENSCOUT_SCOUT_HOME" ? join(fixtureRoot.data,"pairing") : fixtureRoot.data;
      if(data!==fixtureRoot.data){mkdirSync(data,{mode:0o700});pairingTrustOwner(data).bindToHost("fixture-host",{quiescent:true});}
      const extra: Record<string,string> = {OPENSCOUT_PAIRING_HOME:"",SCOUT_PAIRING_HOME:"",OPENSCOUT_PAIRING_DIR:"",OPENSCOUT_SCOUT_HOME:"",[spelling]:fixtureRoot.data};
      const output = await result(launch("binding",data,coordination,"",extra));
      expect(output.code).toBe(0); expect(output.value).toMatchObject({ok:true, keys:[key,"b".repeat(64)]});
      expect(pairingTrustOwner(data).read().revision).toBe(2);
    }
  }, 30000);
  test("managed store stays unavailable in another process despite loader-shaped environment/argv/JSON", async () => {
    const {data,coordination} = fixture(), owner = pairingTrustOwner(data);
    let holder: object | null = null;
    const adapter: PairingTrustAdapter = {id:"test.adapter", withGate(_r,body) { holder={}; try {return body(holder);} finally {holder=null;} }, currentHolder(){return holder;}};
    cleanups.push(owner.register(adapter));
    let capture = "";
    owner.withInvocation(context => { capture = JSON.stringify({...context, toJSON:undefined}); owner.mutate(0,"adopt",{type:"manage"},context); });
    const poison = join(coordination,"adapter.ts"); writeFileSync(poison, `throw Error("ENV_ADAPTER_WAS_LOADED");`);
    const output = await result(launch("env",data,coordination,"--pairing-trust-adapter="+poison, {
      OPENSCOUT_PAIRING_TRUST_ADAPTER:poison, OPENSCOUT_PAIRING_TRUST_ADAPTER_MODULE:poison,
      SCOUT_PAIRING_TRUST_ADAPTER:poison, OPENSCOUT_PAIRING_OWNER:JSON.stringify({module:poison,id:"test.adapter"}),
    }));
    expect(output.value.ok).toBe(false); expect(output.value.error).toContain("managed_adapter_required");
    expect(output.stderr).not.toContain("ENV_ADAPTER_WAS_LOADED");
    const forged = await result(launch("forged",data,coordination,capture));
    expect(forged.value.ok).toBe(false); expect(forged.value.error).toContain("invalid_context");
  }, 30000);
  test("real runtime and retained desktop reconnect storm writes zero generations; authority publications stay gated", async () => {
    const {data,coordination}=fixture(), output=await result(launch("managed-paths",data,coordination));
    expect(output.code,output.stderr).toBe(0); expect(output.value).toEqual({ok:true,removed:true,revision:4,peers:1,reconnectGenerations:0});
    const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const advisory=events.filter(e=>e.event === "rename" && e.target.endsWith("trusted-peers.last-seen.json"));
    expect(advisory.length).toBe(200); expect(advisory.every(e=>e.held === false)).toBe(true);
    const publications=events.filter(e=>(e.event === "link" || e.event === "rename") && !e.target.endsWith("trusted-peers.last-seen.json"));
    expect(publications.length).toBe(9); expect(publications.every(e=>e.held === true)).toBe(true);
  }, 30000);
  test("real runtime and desktop handshakes survive advisory sync and rename failures", async () => {
    for (const fault of ["advisory-sync-fail","advisory-rename-fail"]) {
      const {data,coordination}=fixture(), output=await result(launch("managed-paths",data,coordination,fault));
      expect(output.code,output.stderr).toBe(0); expect(output.value).toEqual({ok:true,removed:true,revision:4,peers:1,reconnectGenerations:0});
      const events=readFileSync(join(coordination,"trace.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
      expect(events.filter(e=>e.event === "rename" && e.target.endsWith("trusted-peers.last-seen.json"))).toEqual([]);
      expect(readdirSync(data).filter(n=>n.endsWith(".tmp"))).toEqual([]);
    }
  }, 30000);
  test("actual web DELETE returns ambiguous 409, full-key 200, missing 404 and managed unavailable 503", async () => {
    const {data,coordination}=fixture(), output=await result(launch("routes",data,coordination));
    expect(output.code,output.stderr).toBe(0); expect(output.value).toEqual({ok:true,statuses:[409,200,404,503]});
  }, 30000);
  test("hardlink and unprotected trust files refuse before serving authority", () => {
    const {data,coordination} = fixture(), source = join(coordination,"source");
    writeFileSync(source,"[]",{mode:0o600}); linkSync(source,join(data,"trusted-peers.json"));
    expect(()=>pairingTrustOwner(data).read()).toThrow("unsafe_path");
    chmodSync(data,0o777); expect(()=>pairingTrustOwner(data)).toThrow("unsafe_path"); chmodSync(data,0o700);
  });
});
