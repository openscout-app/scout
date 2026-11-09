import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRootKey, writeTestIdentity } from "../../../../scripts/fixtures/pairing-identity.ts";
import { PairingTrustOwner, pairingTrustOwner, type PairingTrustAdapter, type PairingRootIdentity, type PairingTrustContext } from "./trust-owner.ts";

const roots: string[] = [], unregister: Array<() => void> = [];
const keyA = "a".repeat(64), keyB = "b".repeat(64);
const peer = (publicKey = keyA) => ({publicKey, pairedAt: "2026-01-01T00:00:00Z"});
function root() { const path = mkdtempSync(join(tmpdir(), "pairing-owner-")); roots.push(path); writeTestIdentity(path); return path; }
function owner() { return pairingTrustOwner(root()); }
function adapter() {
  const storage = new AsyncLocalStorage<{root: string; holder: object}>();
  const trace: string[] = []; let valid = true;
  const result: PairingTrustAdapter = {
    id: "test.adapter",
    withGate<T>(r: PairingRootIdentity, body: (holder: object) => T): T {
      const holder = {};
      return storage.run({root: r.id, holder}, () => {
        trace.push("acquire");
        try {
          const output = body(holder);
          if (output && typeof (output as any).then === "function") return Promise.resolve(output).finally(() => {trace.push("release");}) as T;
          trace.push("release"); return output;
        } catch (error) { trace.push("release"); throw error; }
      });
    },
    currentHolder(r) { const current = storage.getStore(); return valid && current?.root === r.id ? current.holder : null; },
  };
  return {value: result, trace, lose: () => { valid = false; }};
}
function manage(o: PairingTrustOwner) {
  const a = adapter(); unregister.push(o.register(a.value));
  o.withInvocation(context => o.mutate(o.read(context).revision, "adopt", {type: "manage"}, context));
  return a;
}
function pending(o: PairingTrustOwner) {
  const revision=o.read().revision, file=join(o.path,`trusted-peers.owner.${revision}.json`);
  const bytes=readFileSync(join(o.path,"trusted-peers.json"));
  const generation=JSON.parse(readFileSync(file,"utf8")).generation;
  writeFileSync(join(o.path,generation.projectionStage),bytes,{mode:0o600});
  const witness=join(o.path,".pairing-owner-00000000-0000-0000-0000-000000000001.tmp");
  linkSync(file,witness); writeFileSync(join(o.path,"trusted-peers.json"),"[]");
  return {file,bytes,generation,witness};
}
afterEach(() => { for (const remove of unregister.splice(0)) remove(); for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true}); });

describe("pairing canonical owner", () => {
  test("missing read is inert; lazy adoption preserves legacy record shape", () => {
    const parent = root(), path = join(parent, "missing"), o = pairingTrustOwner(path, {rootKey: testRootKey()});
    expect(o.read()).toEqual({revision: 0, peers: []}); expect(readdirSync(parent)).toEqual(["identity.json"]);
    mkdirSync(path, {mode: 0o700}); writeFileSync(join(path, "trusted-peers.json"), JSON.stringify([peer()]), {mode: 0o600});
    expect(o.read().revision).toBe(0);
    const result = o.mutate(0, "one", {type: "grant", peer: peer(keyB)});
    expect(result.revision).toBe(1); expect(o.read().peers).toEqual([peer(), peer(keyB)]);
    expect(JSON.parse(readFileSync(join(path, "trusted-peers.json"), "utf8"))).toEqual([peer(), peer(keyB)]);
    expect(readdirSync(path).some(n => n.includes("lock"))).toBe(false);
    const gen = JSON.parse(readFileSync(join(path, "trusted-peers.owner.1.json"), "utf8")).generation;
    expect(gen.mutation.outcome).toEqual(result); expect(gen.managed).toBeNull();
  });
  test("stale revision refuses byte-identically, without a silent lost update", () => {
    const o = owner(), stale = o.read().revision;
    o.mutate(stale, "one", {type: "grant", peer: peer()});
    const before = readFileSync(join(o.path, "trusted-peers.json"));
    expect(() => o.mutate(stale, "two", {type: "grant", peer: peer(keyB)})).toThrow("revision_conflict");
    expect(readFileSync(join(o.path, "trusted-peers.json"))).toEqual(before);
    expect(o.read().peers).toEqual([peer()]);
  });
  test("ACK-loss retry returns recorded outcome, even after a later revision", () => {
    const o = owner(), mutation = {type: "grant" as const, peer: peer()};
    const lostAck = o.mutate(0, "lost", mutation);
    o.mutate(1, "later", {type: "grant", peer: peer(keyB)});
    expect(new PairingTrustOwner(o.path).mutate(0, "lost", mutation)).toEqual(lostAck);
    expect(o.read().revision).toBe(2);
    expect(() => o.mutate(2, "lost", mutation)).toThrow("mutation_id_reused");
    expect(() => o.mutate(0, "lost", {type: "revoke", publicKey: keyA})).toThrow("mutation_id_reused");
  });
  test("revoke versus a paused reconnect cannot resurrect its stale peer", () => {
    const o = owner(); o.mutate(0, "grant", {type: "grant", peer: peer()});
    const paused = o.read();
    o.mutate(paused.revision, "revoke", {type: "revoke", publicKey: keyA});
    expect(paused.peers[0]!.publicKey).toBe(keyA);
    expect(() => o.refresh(keyA, "later")).toThrow("peer_revoked");
    expect(o.read().peers).toEqual([]);
  });
  test("ambiguous-prefix DELETE refuses; a revoke outcome persists the full key", () => {
    const o = owner(), collision = keyA.slice(0,16) + "b".repeat(48);
    o.mutate(0, "a", {type: "grant", peer: peer()}); o.mutate(1, "b", {type: "grant", peer: peer(collision)});
    expect(() => o.revokePrefix(keyA.slice(0,16))).toThrow("ambiguous_prefix"); expect(o.read().peers.length).toBe(2);
    expect(o.revokePrefix(keyA, "full-revoke")).toBe(true);
    const gen = JSON.parse(readFileSync(join(o.path, "trusted-peers.owner.3.json"), "utf8")).generation;
    expect(gen.mutation.outcome.publicKey).toBe(keyA);
    expect(o.read().peers).toEqual([peer(collision)]);
  });
  test("pending head rolls forward on the next read in both modes without a new generation", () => {
    for (const managed of [false,true]) {
      const o=owner(); o.mutate(0,"grant",{type:"grant",peer:peer()}); if (managed) manage(o);
      const fixture=pending(o), generation=readFileSync(fixture.file);
      expect(o.read()).toEqual({revision:managed?2:1,peers:[peer()]});
      expect(readFileSync(join(o.path,"trusted-peers.json"))).toEqual(fixture.bytes);
      expect(readFileSync(fixture.file)).toEqual(generation);
      expect(readdirSync(o.path).filter(n=>n.endsWith(".tmp"))).toEqual([]);
    }
  });
  test("legacy pending envelopes recover from their unique retained projection source", () => {
    const o=owner();o.mutate(0,"grant",{type:"grant",peer:peer()});const fixture=pending(o);
    delete fixture.generation.projectionStage;
    writeFileSync(fixture.file,JSON.stringify({generation:fixture.generation,sha256:createHash("sha256").update(JSON.stringify(fixture.generation)).digest("hex")}));
    expect(o.read()).toEqual({revision:1,peers:[peer()]});
    expect(readFileSync(join(o.path,"trusted-peers.json"))).toEqual(fixture.bytes);
  });
  test("unfinishable pending read refuses publication_incomplete, not outside-change or unsafe-path", () => {
    const o=owner(); o.mutate(0,"grant",{type:"grant",peer:peer()}); const fixture=pending(o);
    unlinkSync(join(o.path,fixture.generation.projectionStage));
    expect(()=>o.read()).toThrow("publication_incomplete");
    expect(readFileSync(join(o.path,"trusted-peers.json"),"utf8")).toBe("[]");
  });
  test("recovery refuses a tampered shared projection stage before any rename", () => {
    const o=owner(); o.mutate(0,"grant",{type:"grant",peer:peer()}); const fixture=pending(o);
    writeFileSync(join(o.path,fixture.generation.projectionStage),JSON.stringify([peer(keyB)]));
    expect(()=>o.read()).toThrow("publication_incomplete");
    expect(readFileSync(join(o.path,"trusted-peers.json"),"utf8")).toBe("[]");
  });
  test("pending unmanaged roll-forward overwrites outside writes but never changes the owner outcome", () => {
    const o=owner(), mutation={type:"grant" as const,peer:peer()}; const outcome=o.mutate(0,"grant",mutation);
    pending(o); writeFileSync(join(o.path,"trusted-peers.json"),JSON.stringify([peer(keyB)]));
    expect(o.mutate(0,"grant",mutation)).toEqual(outcome); expect(o.read().peers).toEqual([peer()]);
    expect(o.read().revision).toBe(1);
  });
  test("pending recovery preserves marker, checksum, gaps and exactly-one-witness refusals", () => {
    for (const kind of ["checksum","gap","marker","aliases","projection-link"]) {
      const o=owner(); o.mutate(0,"grant-a",{type:"grant",peer:peer()}); o.mutate(1,"grant-b",{type:"grant",peer:peer(keyB)});
      if (kind === "marker") manage(o);
      const fixture=pending(o);
      if (kind === "checksum") { const env=JSON.parse(readFileSync(fixture.file,"utf8")); env.sha256="0".repeat(64);writeFileSync(fixture.file,JSON.stringify(env)); }
      if (kind === "gap") unlinkSync(join(o.path,"trusted-peers.owner.1.json"));
      if (kind === "marker") unlinkSync(join(o.path,"trusted-peers.managed.json"));
      if (kind === "aliases") linkSync(fixture.file,join(o.path,".pairing-owner-00000000-0000-0000-0000-000000000002.tmp"));
      if (kind === "projection-link") linkSync(join(o.path,"trusted-peers.json"),join(o.path,"projection-alias"));
      expect(()=>o.read()).toThrow(); expect(readFileSync(join(o.path,"trusted-peers.json"),"utf8")).toBe("[]");
    }
  });
  test("reconnect storm writes zero generations or projection bytes; advisory lastSeen stays current", () => {
    for (const managed of [false, true]) {
      const o = owner(); o.mutate(0,"grant",{type:"grant",peer:{...peer(),lastSeen:peer().pairedAt}});
      if (managed) manage(o);
      const revision = o.read().revision;
      const authority = () => readdirSync(o.path).filter(name => name !== "trusted-peers.last-seen.json").sort().map(name => [name,readFileSync(join(o.path,name),"utf8")]);
      const before = authority(); let newest = "";
      for (let i=0;i<1000;i++) { newest = new Date(Date.UTC(2026,1,1)+i*1000).toISOString(); o.refresh(keyA,newest); if (i === 0) expect(o.read().revision).toBe(revision); }
      expect(o.read().revision).toBe(revision); expect(o.read().peers[0]!.lastSeen).toBe(newest);
      expect(authority()).toEqual(before);
      const advisory = join(o.path,"trusted-peers.last-seen.json");
      expect(lstatSync(advisory).mode & 0o777).toBe(0o600);
      expect(lstatSync(advisory).uid).toBe(process.getuid!());
      expect(JSON.parse(readFileSync(advisory,"utf8")).entries).toEqual([{publicKey:keyA,lastSeen:newest}]);
    }
  });
  test("advisory merge takes the later projection or reconnect time with grant time as floor", () => {
    const o = owner(), projection = join(o.path,"trusted-peers.json");
    o.mutate(0,"grant",{type:"grant",peer:peer()});
    o.refresh(keyA,"2025-01-01T00:00:00Z"); expect(o.read().peers[0]!.lastSeen).toBe(peer().pairedAt);
    o.refresh(keyA,"2026-02-01T00:00:00Z"); expect(o.read().peers[0]!.lastSeen).toBe("2026-02-01T00:00:00Z");
    o.refresh(keyA,"2026-01-02T00:00:00Z"); expect(o.read().peers[0]!.lastSeen).toBe("2026-02-01T00:00:00Z");
    writeFileSync(projection,JSON.stringify([{...peer(),lastSeen:"2026-03-01T00:00:00Z"}]));
    expect(o.read().peers[0]!.lastSeen).toBe("2026-03-01T00:00:00Z");
    o.refresh(keyA,"2026-02-02T00:00:00Z"); expect(o.read().peers[0]!.lastSeen).toBe("2026-03-01T00:00:00Z");
    // Merged display metadata must never leak into later authority publications.
    o.mutate(1,"grant-b",{type:"grant",peer:peer(keyB)});
    expect(JSON.parse(readFileSync(projection,"utf8"))[0].lastSeen).toBe("2026-03-01T00:00:00Z");
    o.refresh(keyA,"2026-04-01T00:00:00Z"); o.mutate(2,"revoke-b",{type:"revoke",publicKey:keyB});
    expect(JSON.parse(readFileSync(projection,"utf8"))[0].lastSeen).toBe("2026-03-01T00:00:00Z");
    expect(o.read().peers[0]!.lastSeen).toBe("2026-04-01T00:00:00Z");
  });
  test("revoked and non-member advisory entries never grant membership and are pruned on refresh", () => {
    const o = owner(), file = join(o.path,"trusted-peers.last-seen.json");
    o.mutate(0,"grant-a",{type:"grant",peer:peer()}); o.mutate(1,"grant-b",{type:"grant",peer:peer(keyB)});
    o.refresh(keyA,"2026-02-01T00:00:00Z"); o.mutate(2,"revoke-a",{type:"revoke",publicKey:keyA});
    expect(()=>o.refresh(keyA,"2026-03-01T00:00:00Z")).toThrow("peer_revoked");
    expect(o.read().peers).toEqual([peer(keyB)]);
    o.refresh(keyB,"2026-03-01T00:00:00Z");
    expect(JSON.parse(readFileSync(file,"utf8")).entries).toEqual([{publicKey:keyB,lastSeen:"2026-03-01T00:00:00Z"}]);
  });
  test("broken or unsafe advisory files are ignored and replaced without following links", () => {
    for (const kind of ["json","mode","symlink","hardlink","oversize","duplicate","timestamp","non-member"]) {
      const o = owner(); o.mutate(0,"grant",{type:"grant",peer:peer()});
      const file=join(o.path,"trusted-peers.last-seen.json"), outside=join(root(),"outside");
      const entry={publicKey:kind === "non-member" ? keyB : keyA,lastSeen:"2026-02-01T00:00:00Z"};
      const content=JSON.stringify({schema:"scout.pairing-last-seen/v1",entries:[entry]});
      writeFileSync(outside,content,{mode:0o600});
      if (kind === "symlink") symlinkSync(outside,file);
      else if (kind === "hardlink") linkSync(outside,file);
      else writeFileSync(file, kind === "json" ? "{bad" : kind === "oversize" ? " ".repeat(1024*1024+1) : kind === "duplicate" ? JSON.stringify({schema:"scout.pairing-last-seen/v1",entries:[entry,entry]}) : kind === "timestamp" ? JSON.stringify({schema:"scout.pairing-last-seen/v1",entries:[{...entry,lastSeen:"bad"}]}) : content,{mode:kind === "mode" ? 0o644 : 0o600});
      expect(o.read().peers).toEqual([peer()]);
      expect(()=>o.refresh(keyA,"2026-03-01T00:00:00Z")).not.toThrow();
      expect(o.read().peers).toEqual([{...peer(),lastSeen:"2026-03-01T00:00:00Z"}]);
      expect(lstatSync(file).isSymbolicLink()).toBe(false); expect(lstatSync(file).nlink).toBe(1);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(outside,"utf8")).toBe(content);
      expect(JSON.parse(readFileSync(file,"utf8")).entries).toEqual([{publicKey:keyA,lastSeen:"2026-03-01T00:00:00Z"}]);
    }
  });
  test("advisory write failure never fails refresh or changes authority", () => {
    for (const managed of [false,true]) {
      const o=owner(); o.mutate(0,"grant",{type:"grant",peer:peer()}); if (managed) manage(o);
      mkdirSync(join(o.path,"trusted-peers.last-seen.json"),{mode:0o700});
      const revision=o.read().revision, projection=readFileSync(join(o.path,"trusted-peers.json"));
      expect(()=>o.refresh(keyA,"2026-02-01T00:00:00Z")).not.toThrow();
      expect(o.read().peers).toEqual([peer()]); expect(o.read().revision).toBe(revision);
      expect(readFileSync(join(o.path,"trusted-peers.json"))).toEqual(projection);
      expect(readdirSync(o.path).filter(n=>n.endsWith(".tmp"))).toEqual([]);
    }
  });
  test("advisory entries are bounded to authoritative peers and the file limit", () => {
    const o=owner(), peers=Array.from({length:4096},(_,i)=>peer(i.toString(16).padStart(64,"0")));
    writeFileSync(join(o.path,"trusted-peers.json"),JSON.stringify(peers),{mode:0o600});
    writeFileSync(join(o.path,"trusted-peers.last-seen.json"),JSON.stringify({schema:"scout.pairing-last-seen/v1",entries:peers.map(p=>({publicKey:p.publicKey,lastSeen:"2026-02-01T00:00:00Z"}))}),{mode:0o600});
    o.refresh(peers[0]!.publicKey,"2026-03-01T00:00:00Z");
    const file=join(o.path,"trusted-peers.last-seen.json");
    expect(JSON.parse(readFileSync(file,"utf8")).entries.length).toBe(4096); expect(lstatSync(file).size).toBeLessThanOrEqual(1024*1024);
    expect(o.read().revision).toBe(0);
  });
  test("unmanaged old-binary writes are adopted without replaying or rewriting the owner ledger", () => {
    const o = owner(), grant = {type:"grant" as const,peer:peer()};
    const first = o.mutate(0,"grant",grant); o.mutate(1,"revoke",{type:"revoke",publicKey:keyA});
    const ledger = readFileSync(join(o.path,"trusted-peers.owner.2.json"));
    // An old writer can even resurrect a key: unmanaged mode does not exclude it.
    const external = JSON.stringify([peer(),peer(keyB)]);
    writeFileSync(join(o.path,"trusted-peers.json"),external);
    expect(o.read()).toEqual({revision:2,peers:[peer(),peer(keyB)]});
    expect(o.mutate(0,"grant",grant)).toEqual(first); expect(o.read().revision).toBe(2);
    expect(readFileSync(join(o.path,"trusted-peers.json"),"utf8")).toBe(external);
    expect(readFileSync(join(o.path,"trusted-peers.owner.2.json"))).toEqual(ledger);
    o.mutate(2,"revoke-b",{type:"revoke",publicKey:keyB});
    const next = JSON.parse(readFileSync(join(o.path,"trusted-peers.owner.3.json"),"utf8")).generation;
    expect(next.adoption.fromProjectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(next.adoption.toProjectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(next.adoption.fromProjectionHash).not.toBe(next.adoption.toProjectionHash);
    expect(o.read()).toEqual({revision:3,peers:[peer()]});
  });
  test("unmanaged deletion adopts empty; malformed external projections still refuse", () => {
    const o = owner(); o.mutate(0,"grant",{type:"grant",peer:peer()});
    unlinkSync(join(o.path,"trusted-peers.json")); expect(o.read().peers).toEqual([]);
    o.mutate(1,"new-grant",{type:"grant",peer:peer(keyB)}); expect(o.read().peers).toEqual([peer(keyB)]);
    writeFileSync(join(o.path,"trusted-peers.json"),"{bad"); expect(()=>o.read()).toThrow();
  });
  test("external changes in both directions refuse without a watcher", () => {
    for (const replacement of [[], [peer(), peer(keyB)]]) {
      const o = owner(); o.mutate(0, "grant", {type: "grant", peer: peer()}); manage(o);
      writeFileSync(join(o.path, "trusted-peers.json"), JSON.stringify(replacement), {mode: 0o600});
      expect(() => o.read()).toThrow("external_change_or_incomplete");
      expect(() => o.mutate(2, "mutate", {type: "revoke", publicKey: keyA})).toThrow("external_change_or_incomplete");
    }
  });
  test("managed missing/corrupt generation or projection never falls back", () => {
    for (const kind of ["projection", "gap", "corrupt", "root"]) {
      const o = owner(); o.mutate(0, "one", {type: "grant", peer: peer()}); o.mutate(1, "two", {type: "grant", peer: peer(keyB)}); manage(o);
      if (kind === "projection") unlinkSync(join(o.path, "trusted-peers.json"));
      if (kind === "gap") unlinkSync(join(o.path, "trusted-peers.owner.1.json"));
      if (kind === "corrupt") writeFileSync(join(o.path, "trusted-peers.owner.2.json"), "{bad");
      if (kind === "root") { const old = o.path + "-old"; renameSync(o.path, old); roots.push(old); mkdirSync(o.path, {mode: 0o700}); }
      expect(() => o.read()).toThrow();
    }
  });
  test("generation checksum detects an otherwise valid outcome edit", () => {
    const o = owner(); o.mutate(0, "grant", {type: "grant", peer: peer()});
    const path = join(o.path, "trusted-peers.owner.1.json"), envelope = JSON.parse(readFileSync(path,"utf8"));
    envelope.generation.mutation.request = "changed outside owner";
    writeFileSync(path,JSON.stringify(envelope));
    expect(() => o.read()).toThrow("generation_checksum");
  });
  test("managed marker refuses without adapter and after downgrade/missing marker", () => {
    const o = owner(), a = adapter(), remove = o.register(a.value); unregister.push(remove);
    o.withInvocation(c => o.mutate(0, "manage", {type: "manage"}, c));
    expect(o.read().revision).toBe(1); remove();
    expect(() => o.read()).toThrow("managed_adapter_required");
    expect(() => o.mutate(1, "bad", {type: "grant", peer: peer()})).toThrow("managed_adapter_required");
    unregister.push(o.register(a.value));
    unlinkSync(join(o.path, "trusted-peers.managed.json"));
    expect(() => o.read()).toThrow("managed_marker_mismatch");
  });
  test("registration alone does not adopt or create a managed default", () => {
    const o = owner(), a = adapter(), remove = o.register(a.value); unregister.push(remove);
    expect(o.read().revision).toBe(0);
    expect(readdirSync(o.path)).toEqual(["identity.json"]);
    o.mutate(0,"ordinary-grant",{type:"grant",peer:peer()});
    writeFileSync(join(o.path,"trusted-peers.json"),JSON.stringify([peer(keyB)]));
    expect(o.read().peers).toEqual([peer(keyB)]); remove();
    expect(o.read().revision).toBe(1);
    expect(readdirSync(o.path)).not.toContain("trusted-peers.managed.json");
  });
  test("unknown marker protocol, root and adapter mismatch refuse", () => {
    for (const change of [{schema: "unknown"}, {rootId: "elsewhere"}, {adapterId: "other.adapter"}]) {
      const o = owner(); manage(o);
      const file = join(o.path, "trusted-peers.managed.json"), marker = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({...marker, ...change}));
      expect(() => o.read()).toThrow();
    }
  });
  test("same root spelling/ancestor alias shares owner; separate roots do not", () => {
    const path = root(); expect(pairingTrustOwner(path)).toBe(pairingTrustOwner(join(path, ".")));
    const parent = root(), link = join(parent, "alias"); symlinkSync(path, link);
    expect(() => pairingTrustOwner(link)).toThrow("unsafe_path");
    mkdirSync(join(path, "child"), {mode: 0o700});
    expect(pairingTrustOwner(join(link, "child"))).toBe(pairingTrustOwner(join(path, "child")));
    expect(owner()).not.toBe(pairingTrustOwner(path));
  });
  test("unsafe root ownership, mode, symlink, files and hard links refuse", () => {
    expect(lstatSync("/").uid).not.toBe(process.getuid!());
    expect(() => pairingTrustOwner("/")).toThrow("unsafe_path");
    const path = root(); chmodSync(path, 0o777); expect(() => pairingTrustOwner(path)).toThrow("unsafe_path"); chmodSync(path, 0o700);
    const o = pairingTrustOwner(path), other = join(root(), "other"); writeFileSync(other, "[]", {mode: 0o600});
    symlinkSync(other, join(path, "trusted-peers.json")); expect(() => o.read()).toThrow(); unlinkSync(join(path, "trusted-peers.json"));
    writeFileSync(join(path, "trusted-peers.json"), "[]", {mode: 0o600}); chmodSync(join(path, "trusted-peers.json"), 0o666); expect(() => o.read()).toThrow("unsafe_path");
  });
});

describe("invocation-scoped managed contexts", () => {
  test("non-serializable, root-bound, single publication, invalid after return", () => {
    const o = owner(), other = owner(); manage(o); manage(other); let captured!: PairingTrustContext;
    o.withInvocation(c => {
      captured = c;
      expect(() => JSON.stringify(c)).toThrow("context_not_serializable"); expect(() => structuredClone(c)).toThrow();
      expect(() => other.read(c)).toThrow("invalid_context");
      o.mutate(1, "first", {type: "grant", peer: peer()}, c);
      expect(() => o.mutate(2, "second", {type: "grant", peer: peer(keyB)}, c)).toThrow("context_already_used");
    });
    expect(() => o.read(captured)).toThrow("invalid_context");
    expect(() => o.read({} as PairingTrustContext)).toThrow("invalid_context");
  });
  test("context is checked against actual current gate holder, before and after I/O", () => {
    const o = owner(), a = manage(o);
    o.withInvocation(c => { a.lose(); expect(() => o.read(c)).toThrow("invalid_context"); });
    expect(a.trace.filter(x => x === "acquire").length).toBe(a.trace.filter(x => x === "release").length);
  });
  test("captured context refuses in a concurrent invocation; async lifetime closes", async () => {
    const o = owner(); manage(o); let captured!: PairingTrustContext, release!: () => void;
    let ready!: () => void; const started = new Promise<void>(r => ready = r), hold = new Promise<void>(r => release = r);
    const pending = o.withInvocation(async c => { captured = c; ready(); await hold; expect(o.read(c).revision).toBe(1); });
    await started;
    o.withInvocation(c => { expect(o.read(c).revision).toBe(1); expect(() => o.read(captured)).toThrow("invalid_context"); });
    release(); await pending; expect(() => o.read(captured)).toThrow("invalid_context");
  });
  test("captured context in an inherited async task is dead after synchronous return", async () => {
    const o = owner(); manage(o); let delayed!: Promise<unknown>;
    o.withInvocation(c => { delayed = Promise.resolve().then(() => o.read(c)); });
    await expect(delayed).rejects.toThrow("invalid_context");
  });
  test("throwing and rejected callbacks close contexts and release adapter", async () => {
    const o = owner(), a = manage(o); let captured!: PairingTrustContext;
    expect(() => o.withInvocation(c => {captured = c; throw Error("stop");})).toThrow("stop");
    expect(() => o.read(captured)).toThrow("invalid_context");
    await expect(o.withInvocation(async c => {captured = c; throw Error("reject");})).rejects.toThrow("reject");
    expect(() => o.read(captured)).toThrow("invalid_context");
    expect(a.trace.filter(x => x === "acquire").length).toBe(a.trace.filter(x => x === "release").length);
  });
  test("adapter cannot be installed from JSON data", () => {
    const o = owner(); expect(() => o.register(JSON.parse('{"id":"test.adapter","withGate":"file:///adapter.js","currentHolder":true}'))).toThrow("invalid_adapter");
    expect(() => o.read({holder: {}} as unknown as PairingTrustContext)).toThrow("invalid_context");
  });
});
