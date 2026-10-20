import { decodeJournalLine } from "./broker-journal-framing.js";
import { EventEmitter } from "node:events";
import { writeBrokerSnapshot } from "./broker-snapshot-response.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";
import { afterEach, expect, test } from "bun:test";
import { ftruncateSync, writeSync, appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRecord } from "@openscout/protocol";
import { BrokerMessageBodyCache, BrokerMessageBodyCacheUnavailable } from "./broker-message-body-cache.js";
import { FileBackedBrokerJournal } from "./broker-journal.js";
import { createInMemoryControlRuntime } from "./broker.js";
import { BrokerDurableStore } from "./broker-durable-store.js";
import { BrokerDurableRecordStore } from "./broker-durable-record-store.js";
import { json } from "./broker-http-helpers.js";

const roots: string[] = [];
const owners: Array<{ close(): void }> = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.close(); for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function directory() { const root=mkdtempSync(join(tmpdir(),"scout-body-cache-test-")); roots.push(root); return root; }
function message(id: string, body: string): MessageRecord {
  return {id,body,conversationId:"c",actorId:"operator",originNodeId:"n",class:"agent",visibility:"private",policy:"durable",createdAt:100};
}

test("cold bodies retain exact JSON strings with bounded hot character storage", () => {
  const root=directory(); const cache=new BrokerMessageBodyCache(root,{minBodyBytes:0,maxResidentBytes:16,maxResidentBodies:2}); owners.push(cache);
  const inputs=["abcd","雪😀","x\ud800y","\\\n\"", "z".repeat(100)];
  const records=inputs.map((body,i)=>cache.prepare(message(String(i),body)));
  expect(readdirSync(root)).toEqual([]); // only a process-owned unlinked descriptor
  expect(cache.status().hotBodies).toBe(0);
  for(let repeat=0;repeat<3;repeat++) for(let i=0;i<records.length;i++) {
    expect(records[i]!.body).toBe(inputs[i]);
    expect(JSON.parse(JSON.stringify(records[i])).body).toBe(inputs[i]);
    expect(cache.status().hotBodies).toBeLessThanOrEqual(2);
    expect(cache.status().hotUtf16Bytes).toBeLessThanOrEqual(16);
  }
  expect(cache.status().diskBytes).toBeGreaterThan(0);
  cache.close();
  expect(()=>records[0]!.body).toThrow(BrokerMessageBodyCacheUnavailable);
});

test("journal reconstructs exact historical bodies without SQLite and retains old captured versions", async () => {
  const path=join(directory(),"journal.jsonl");
  const first=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0,maxResidentBytes:8,maxResidentBodies:1}});owners.push(first);await first.load();
  await first.appendEntries({kind:"message.record",message:message("m","first-body")});
  const captured=first.snapshot().messages.m!;
  await first.appendEntries({kind:"message.record",message:message("m","second-body")});
  expect(captured.body).toBe("first-body");expect(first.snapshot().messages.m!.body).toBe("second-body");
  first.close();
  const second=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0,maxResidentBytes:8,maxResidentBodies:1}});owners.push(second);await second.load();
  expect(second.snapshot().messages.m!.body).toBe("second-body");
  expect(readFileSync(path,"utf8")).toContain('"body":"first-body"');
  expect(readFileSync(path,"utf8")).toContain('"body":"second-body"');
});

test("live durable commits install cached records in runtime while preserving canonical bytes", async () => {
  const path=join(directory(),"journal.jsonl");
  const journal=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0,maxResidentBodies:0}});owners.push(journal);await journal.load();
  const runtime=createInMemoryControlRuntime();
  await runtime.upsertConversation({id:"c",kind:"channel",title:"test",visibility:"private",shareMode:"local",authorityNodeId:"n",participantIds:["operator"]});
  let releaseProjection!: () => void;
  const projectionGate = new Promise<void>(resolve => { releaseProjection=resolve; });
  const durableStore=new BrokerDurableStore({journal,projection:{async applyEntries(){await projectionGate; return [];}},threadEvents:{publish(){}}});
  const records=new BrokerDurableRecordStore({runtime,durableStore,knownInvocations:new Map()});
  const input=message("live","exact live body");await records.recordMessage(input);
  expect(Object.getOwnPropertyDescriptor(runtime.message("live")!,"body")?.get).toBeFunction();
  expect(runtime.message("live")!.body).toBe(input.body);
  const entries=readFileSync(path,"utf8").trimEnd().split("\n").flatMap(decodeJournalLine);
  expect(entries.find(entry => entry.kind === "message.record" && entry.message.id === input.id)).toEqual({kind:"message.record",message:input});
  const durableRead=await journal.readCanonicalMessage(input.id);
  expect(durableRead.kind).toBe("found");
  if(durableRead.kind==="found")expect(durableRead.value).toEqual(input);
  releaseProjection(); await durableStore.flushProjectedEntries();
});

test("failed body staging does not append a canonical message or publish a phantom record", async () => {
  const path=join(directory(),"journal.jsonl");
  const journal=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0}});owners.push(journal);await journal.load();journal.close();
  await expect(journal.appendEntries({kind:"message.record",message:message("never","unaccepted")})).rejects.toThrow(BrokerMessageBodyCacheUnavailable);
  expect(journal.snapshot().messages.never).toBeUndefined();
  expect(()=>readFileSync(path)).toThrow();
  await journal.appendEntries({kind:"deliveries.record",deliveries:[{id:"control",targetId:"a",targetKind:"agent",transport:"local_socket",reason:"direct_message",policy:"durable",status:"pending"}]});
  await journal.appendEntries({kind:"delivery.status.update",deliveryId:"control",status:"acknowledged"});
  expect(journal.getDelivery("control")!.status).toBe("acknowledged");
});

test("an unavailable existing body produces a 503 response, not absence or an empty body", () => {
  const cache=new BrokerMessageBodyCache(directory(),{minBodyBytes:0});owners.push(cache);
  const record=cache.prepare(message("existing","body"));cache.close();
  let status=0;let output="";
  json({writeHead(value){status=value;},write(){},end(value){output=String(value);},on(){}},200,record);
  expect(status).toBe(503);expect(JSON.parse(output).error).toBe("body_cache_unavailable");
});

test("canonical reader preserves large fields and proves absence independently of the cold cache", async () => {
  const path=join(directory(),"journal.jsonl");
  const journal=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0}});owners.push(journal);await journal.load();
  const input={...message("rich", "雪😀\ud800".repeat(20000)),metadata:{large:"metadata".repeat(20000),nested:{v:[null,true,1]}},attachments:[{id:"blob",mediaType:"application/octet-stream",metadata:{custom:"preserve"}}]};
  await journal.appendEntries({kind:"message.record",message:input});journal.close();
  const read=await journal.readCanonicalMessage("rich");
  expect(read.kind).toBe("found");if(read.kind==="found")expect(read.value).toEqual(input);
  const absent=await journal.readCanonicalMessage("absent");expect(absent.kind).toBe("not_found");
  if(absent.kind==="not_found")expect(absent.coverage.endByteExclusive).toBeGreaterThan(0);
  rmSync(path);
  expect((await journal.readCanonicalMessage("rich")).kind).toBe("unavailable");
  expect((await journal.readCanonicalMessage("absent")).kind).toBe("unavailable");
});

test("journal compaction and restart reconstruct body references without changing canonical reads", async () => {
  const path=join(directory(),"journal.jsonl");
  const first=new FileBackedBrokerJournal(path);owners.push(first);await first.load();
  await first.appendEntries({kind:"actor.upsert",actor:{id:"operator",kind:"person",displayName:"old"}});
  const input=message("kept","exact after compaction\ud800雪".repeat(100));
  await first.appendEntries({kind:"message.record",message:input});
  await first.appendEntries({kind:"actor.upsert",actor:{id:"operator",kind:"person",displayName:"new"}});
  const rebuilt=new FileBackedBrokerJournal(path,{messageBodyCache:{minBodyBytes:0},compactionPolicy:{minimumReclaimBytes:1}});owners.push(rebuilt);
  expect((await rebuilt.load()).compactionRequired).toBe(true);
  expect(rebuilt.snapshot().messages.kept!.body).toBe(input.body);
  const read=await rebuilt.readCanonicalMessage("kept");expect(read.kind).toBe("found");
  if(read.kind==="found")expect(read.value).toEqual(input);
});

test("malformed or unsupported journal suffixes invalidate absence coverage", async () => {
  for(const suffix of ['{broken\n', '{"kind":"future.message.patch","id":"missing"}\n', '{"kind":"message.record","message":{"id":"missing"}}\n']) {
    const path=join(directory(),"journal.jsonl");const journal=new FileBackedBrokerJournal(path);owners.push(journal);await journal.load();
    await journal.appendEntries({kind:"message.record",message:message("present","valid")});appendFileSync(path,suffix);
    expect((await journal.readCanonicalMessage("missing")).kind).toBe("unavailable");
    expect((await journal.readCanonicalMessage("present")).kind).toBe("unavailable");
  }
});

test("concurrent slow snapshots keep the shared hot cache bounded and yield control", async () => {
  class SlowResponse extends EventEmitter {
    body=""; writes=0; stalled=true; destroyed=false; writableEnded=false;
    writeHead(){} write(value:string){this.writes++;this.body+=value;return !this.stalled;}
    end(){this.writableEnded=true;} destroy(){this.destroyed=true;this.emit("close");}
  }
  const cache=new BrokerMessageBodyCache(directory(),{minBodyBytes:0,maxResidentBytes:8192,maxResidentBodies:4});owners.push(cache);
  const records=Object.fromEntries(Array.from({length:1000},(_,i)=>[String(i),cache.prepare(message(String(i),`${i}:`+"雪x".repeat(512)))]));
  const captured=createRuntimeRegistrySnapshot({messages:records});
  const responses=Array.from({length:3},()=>new SlowResponse());
  let ticks=0;let last=performance.now();let maxGapMs=0;
  const timer=setInterval(()=>{ticks++;const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;},1);
  try {
    const writes=responses.map(response=>writeBrokerSnapshot(response,captured,{chunkBytes:8192}));
    await Bun.sleep(10);
    expect(responses.map(r=>r.writes)).toEqual([1,1,1]);
    expect(cache.status().hotUtf16Bytes).toBeLessThanOrEqual(8192);
    responses[0]!.destroy();
    for(const response of responses.slice(1)){response.stalled=false;response.emit("drain");}
    await Promise.all(writes);
    for(const response of responses.slice(1)) {
      const decoded=JSON.parse(response.body);expect(Object.keys(decoded.messages)).toHaveLength(1000);
      for(let i=0;i<1000;i++)expect(decoded.messages[String(i)].body).toBe(`${i}:`+"雪x".repeat(512));
      expect(response.eventNames()).toEqual([]);
    }
    expect(cache.status().hotBodies).toBeLessThanOrEqual(4);
    expect(cache.status().hotUtf16Bytes).toBeLessThanOrEqual(8192);
    expect(ticks).toBeGreaterThan(1);
    console.log(JSON.stringify({probe:"cold_body_snapshot_unit",timerTicks:ticks,maxGapMs,diskBytes:cache.status().diskBytes}));
  } finally {clearInterval(timer);}
});


test("spill checksum rejects valid JSON corruption and truncated backing bytes", () => {
  for (const corrupt of [false, true]) {
    const cache = new BrokerMessageBodyCache(directory(), { minBodyBytes: 0, maxResidentBodies: 0 });
    owners.push(cache);
    const record = cache.prepare(message("checksum", "original"));
    const fd = (cache as unknown as { fd: number }).fd;
    if (corrupt) writeSync(fd, Buffer.from('"tampered"'), 0, 10, 0);
    else ftruncateSync(fd, 3);
    expect(() => record.body).toThrow(BrokerMessageBodyCacheUnavailable);
    expect(cache.status().hotBodies).toBe(0);
  }
});

test("scratch buffers preserve bodies across UTF-8 boundaries and stay capped", () => {
  const cache = new BrokerMessageBodyCache(directory(), { minBodyBytes: 0, maxResidentBodies: 0 });
  owners.push(cache);
  const inputs = ["x".repeat(65532) + "🦉雪\ud800", "雪😀".repeat(240000), "small"];
  const records = inputs.map((body, index) => cache.prepare(message(String(index), body)));
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < records.length; index++) {
      expect(records[index]!.body).toBe(inputs[index]);
      expect(cache.status().scratchBytes).toBeLessThanOrEqual(cache.status().maxScratchBytes);
    }
  }
  cache.close();
  expect(cache.status().scratchBytes).toBe(0);
});
