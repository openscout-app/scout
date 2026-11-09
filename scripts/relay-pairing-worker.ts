import { createAccountAdmission } from "../packages/pairing/src/core/pairing/runtime/account-admission.ts";
import { createPendingPairRequestStore, pairRequestStatePath } from "../packages/pairing/src/pairing-pair-requests.ts";
import { localConfigHome } from "../packages/runtime/src/local-config.ts";
// Process-isolated fixture: actual relay WebSockets and Noise, with application
// sinks instrumented to count dispatches and secret/event delivery.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { generateKeyPair, type KeyPair } from "../packages/runtime/src/pairing-security/noise.ts";
import { SecureTransport } from "../packages/runtime/src/pairing-security/transport.ts";
import { bytesToHex } from "../packages/runtime/src/pairing-security/identity.ts";
import { pairingTrustOwner, type PairingOpportunity } from "../packages/runtime/src/pairing-security/trust-owner.ts";
import { requestLocalPairingOpportunity } from "../packages/runtime/src/pairing-local-socket.ts";
import { startRelay } from "../packages/runtime/src/relay-transport.ts";

const flavor = process.argv[2] ?? "web", scenario = process.argv[3] ?? "revoked";
const base = resolve("packages/pairing/src/core/pairing/runtime");
const { requireCredentialIdentity } = await import(resolve(base, "bridge/credential-binding.ts"));
mock.module(resolve(base, "bridge/mobile-terminal-provision.ts"), () => ({
  provisionMobileTerminalAccess: async (_ssh: string, _device: string, _class: string, binding: unknown) =>
    ({ publicKey: requireCredentialIdentity(binding).publicKey }),
  readMobileTerminalStatus: async (_session: string, _device: string, binding: unknown) =>
    ({ publicKey: requireCredentialIdentity(binding).publicKey }),
}));
const realLegacyServer = await import(resolve(base, "bridge/server.ts"));
const { initTRPC, tracked } = await import(Bun.resolveSync("@trpc/server", base));
let dispatches = 0, subscriptions = 0, streamStops = 0;
const t = initTRPC.create();
mock.module(resolve(base, "bridge/router.ts"), () => ({lookupMobileInboxItemForEvent: () => null, bridgeRouter: t.router({
  probe: t.procedure.query(({ctx}: any) => {
    assert.equal(requireCredentialIdentity(ctx.credentialBinding).publicKey, key);
    dispatches++; return "rpc-secret";
  }),
  stream: t.procedure.subscription(async function* ({signal}) {
    try {
      yield tracked("event-1", { summary: "relay-stream" });
      await new Promise<void>(done => signal?.aborted ? done() : signal?.addEventListener("abort", () => done(), {once:true}));
    } finally { streamStops++; }
  }),
})}));
mock.module(resolve(base, "bridge/server.ts"), () => ({...realLegacyServer, handleRPC: async (_bridge: unknown, req: any, ctx: any) => {
  assert.equal(requireCredentialIdentity(ctx?.credentialBinding).publicKey, key);
  dispatches++; return {id: req.id, result: "rpc-secret"};
}}));
mock.module(resolve(base, "bridge/broker-message-fanout.ts"), () => ({watchSharedScoutMessages: async () => {subscriptions++;}}));
const OriginalWebSocket = globalThis.WebSocket;
const carriers: WebSocket[] = [];
globalThis.WebSocket = class extends OriginalWebSocket {
  constructor(url: any, options?: any) {
    const target = new URL(String(url));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw Error("Fixture refuses non-loopback WebSocket");
    super(url, options);
    if (new URL(String(url)).searchParams.get("role") === "bridge") carriers.push(this);
  }
} as typeof WebSocket;
const { connectToRelay } = await import(pathToFileURL(resolve(base, "bridge/relay-client.ts")).href);
async function freePort() {
  return new Promise<number>((done, fail) => {
    const s = createServer(); s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as {port: number}).port; s.close(e => e ? fail(e) : done(p));
    });
  });
}
const port = await freePort(), relay = startRelay(port, {hostname: "127.0.0.1"}), url = `ws://127.0.0.1:${port}`;
let host = generateKeyPair();
// The trust store keys its root id from the pairing identity on disk. These
// scenarios use an in-memory host key, so save it as the runtime would.
function persistHostIdentity() {
  writeFileSync(join(process.env.OPENSCOUT_PAIRING_HOME!, "identity.json"), JSON.stringify({
    publicKey: bytesToHex(host.publicKey), privateKey: bytesToHex(host.privateKey), createdAt: new Date().toISOString(),
  }), {mode: 0o600, flag: "wx"});
}
const phone = generateKeyPair(), other = generateKeyPair(), key = bytesToHex(phone.publicKey), owner = pairingTrustOwner();
let bridgeEvents: ((e: unknown) => void) | undefined, opportunity: PairingOpportunity | undefined;
const bridge = {
  listSessions: () => [{sessionId: "session-secret"}],
  onEvent: (fn: (e: unknown) => void) => {subscriptions++; bridgeEvents = fn; return () => {bridgeEvents = undefined;};},
};
let runtime: any, bridgePort = 0, workflowRoom: string | undefined;
let connection: ReturnType<typeof connectToRelay>;
let accountStore: ReturnType<typeof createPendingPairRequestStore> | undefined;
let accountSignal: AbortSignal | undefined;
let admittedCallbacks = 0;
const accountMode = scenario.startsWith("account-");
let accountClock = Date.now();
let controllerMode = false;
if (scenario === "account-controller") {
  controllerMode = true;
  // Real controller/runtime/HTTP/Noise, with OS discovery and hosted publishing
  // disabled. No actual Bonjour, Tailscale probe or hosted service is touched.
  mock.module(resolve(base,"relay-runtime.ts"),()=>({startManagedRelay:async()=>null}));
  mock.module(resolve("packages/pairing/src/pairing-lan-beacon.ts"),()=>({startScoutPairLanBeacon:()=>null}));
  mock.module(resolve(base,"rendezvous.ts"),()=>({startPairingRendezvousPublisher:()=>null}));
  bridgePort = await freePort();
  if (bridgePort > 65000) bridgePort = await freePort();
  process.env.OPENSCOUT_PAIRING_PORT=String(bridgePort);
  process.env.OPENSCOUT_PAIRING_RELAY_URL=url;
  writeFileSync(join(process.env.OPENSCOUT_PAIRING_HOME!,"config.json"),JSON.stringify({port:bridgePort,secure:true,relay:url}));
  const {runPairingRuntimeController}=await import(pathToFileURL(resolve(base,"../pairing-runtime-controller.ts")).href);
  await runPairingRuntimeController();
  const snapshot=JSON.parse(readFileSync(join(process.env.OPENSCOUT_PAIRING_HOME!,"runtime.json"),"utf8"));
  assert.equal(snapshot.pairing,null);
  assert(snapshot.accountPairing?.accountRoom);
  workflowRoom=snapshot.accountPairing.accountRoom;
  connection={qrPayload:{...snapshot.accountPairing,room:workflowRoom},disconnect(){},retire(){}} as any;
  accountStore=createPendingPairRequestStore({statePath:pairRequestStatePath(localConfigHome())});
} else if (scenario === "workflow" || scenario === "account-runtime" || scenario === "account-no-gate") {
  bridgePort = await freePort();
  process.env.OPENSCOUT_PAIRING_PORT = String(bridgePort);
  writeFileSync(join(process.env.OPENSCOUT_PAIRING_HOME!, "config.json"), JSON.stringify({port: bridgePort, secure: true}));
  const { startPairingRuntime } = await import(pathToFileURL(resolve(base, "runtime.ts")).href);
  if (scenario === "account-runtime") accountStore = createPendingPairRequestStore({statePath:pairRequestStatePath(localConfigHome())});
  runtime = await startPairingRuntime({relayUrl: url,
    ...(accountStore ? {admitAccountDevice:createAccountAdmission({store:accountStore,pollMs:1,maxWaitMs:2000})} : {}),
  });
  host = runtime.identity;
  connection = runtime.relayConnection;
  if (scenario === "account-runtime") {
    workflowRoom = runtime.accountRoom;
    assert(workflowRoom && runtime.relayConnections.length === 2);
    const room = runtime.accountRoom, opened = runtime.openPairing();
    assert.equal(runtime.accountRoom, room); runtime.cancelPairing(opened.windowId);
  }
} else if (accountMode) {
  persistHostIdentity();
  accountStore = createPendingPairRequestStore({statePath:pairRequestStatePath(localConfigHome())});
  const store = accountStore;
  const decisionStore = scenario === "account-cas-deny" || scenario === "account-cas-delivered" ? {
    ...store, fulfill(token: string, status: any) {
      if (scenario === "account-cas-deny") store.decide(token,"deny"); else store.fulfill(token,"approved");
      return store.fulfill(token,status);
    },
  } : store;
  const admit = createAccountAdmission({store:decisionStore,pollMs:1,maxWaitMs:2000,now:()=>accountClock});
  connection = connectToRelay(url,host,bridge as any,{kind:"account",privateRoom:true,
    admitNewDevice:(key,signal)=>{accountSignal=signal;admittedCallbacks++;return scenario === "account-error" ? Promise.reject(Error("fixture refusal")) : admit(key,signal);},
  });
} else {
  persistHostIdentity();
  connection = connectToRelay(url, host, bridge as any, {
    kind: "pairing",
    admitNewPeer: (k, room, live) => opportunity?.admit(k, room, live) ?? false,
    onPeerAdmitted: () => {opportunity?.cancel(); opportunity = undefined;},
  });
}
const sockets: WebSocket[] = [];
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 3000;
  while (!check()) {if (Date.now() > end) throw Error(`timeout ${label}`); await Bun.sleep(5);}
}
async function connect(pattern: "XX" | "IK", keys: KeyPair = phone, direct: boolean | number = false) {
  const ws = new WebSocket(direct ? `ws://127.0.0.1:${typeof direct === "number" ? direct : bridgePort}?events=0` : `${url}?room=${(workflowRoom ?? connection.qrPayload.room)}&role=client`);
  sockets.push(ws);
  const data: string[] = [], state = {ready: false, closed: 0, reason: ""}; let transport: SecureTransport;
  ws.addEventListener("message", e => transport.receive(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer)));
  ws.addEventListener("close", e => {state.closed = e.code; state.reason = e.reason;});
  await new Promise<void>((done, fail) => {
    ws.addEventListener("open", () => done(), {once: true}); ws.addEventListener("error", () => fail(Error("phone websocket")), {once: true});
  });
  transport = new SecureTransport({send: f => ws.send(f)}, "initiator", keys, {
    onReady: () => {state.ready = true;}, onMessage: m => data.push(m),
  }, {pattern, remoteStaticKey: pattern === "IK" ? host.publicKey : undefined, trustOnComplete: false, skipTrustWrite: () => true});
  await until(() => state.ready || state.closed !== 0, "phone handshake");
  return {ws, data, state, transport};
}
function begin(ms = 1000) {opportunity = owner.openPairingOpportunity(connection.qrPayload.room, Date.now() + ms);}
function revoke() {owner.mutate(owner.read().revision, crypto.randomUUID(), {type: "revoke", publicKey: key});}
function seed() {owner.mutate(owner.read().revision, crypto.randomUUID(), {type: "grant", peer: {publicKey: key, pairedAt: new Date().toISOString()}});}
async function accepted(pattern: "XX" | "IK" = "XX") {
  const p = await connect(pattern);
  p.transport.send(JSON.stringify({id: 3, jsonrpc: "2.0", method: "query", params: {path: "probe"}}));
  await until(() => p.data.some(x => x.includes("rpc-secret")), "accepted RPC");
  assert.equal(p.state.closed, 0); return p;
}
async function denied(pattern: "XX" | "IK", keys = phone) {
  const beforeDispatch = dispatches, beforeSubscriptions = subscriptions;
  const p = await connect(pattern, keys);
  if (p.state.closed === 0) {
    // Pipeline both application protocols as soon as the phone finishes Noise.
    p.transport.send(JSON.stringify({id: "probe", method: "session/list"}));
    p.transport.send(JSON.stringify({id: 4, jsonrpc: "2.0", method: "query", params: {path: "probe"}}));
  }
  await Bun.sleep(60);
  bridgeEvents?.({seq: 9, event: {event: "secret-event"}});
  await Bun.sleep(10);
  assert.equal(p.state.closed, 4003, "unadmitted peer must close 4003");
  assert.equal(p.data.length, 0, "unadmitted peer received data");
  assert.equal(dispatches, beforeDispatch, "unadmitted RPC dispatched");
  assert.equal(subscriptions, beforeSubscriptions, "unadmitted peer started subscriptions");
  return p;
}
try {
  await Bun.sleep(40);
  if (scenario === "account-no-gate") {
    assert.equal(runtime.accountRoom,null); assert.equal(runtime.relayConnections.length,1);
    assert.throws(()=>connectToRelay(url,host,bridge as any,{kind:"account"}),/owner-admission callback/);
    assert.throws(()=>connectToRelay(url,host,bridge as any,{kind:"account",secure:false,admitNewDevice:async()=>"admitted"}),/Noise/);
    assert.equal(owner.read().peers.length,0);
  } else if (accountMode) {
    const p=await connect("XX");
    if(scenario !== "account-error") await until(()=>accountStore!.list().length===1,"account request");
    const row=accountStore?.list()[0];
    if(scenario === "account-error") {await until(()=>p.state.closed===4003,"owner callback error close");}
    else {
      assert(row); assert.equal(row.requesterPublicKey,key); assert.equal(row.route,"account");
      // Actual encrypted pre-admission traffic must never reach RPC, streams,
      // bridge session events, or broker watches. Status is the sole exception.
      p.transport.send(JSON.stringify({id:71,jsonrpc:"2.0",method:"query",params:{path:"probe"}}));
      p.transport.send(JSON.stringify({id:72,jsonrpc:"2.0",method:"subscription",params:{path:"stream"}}));
      p.transport.send(JSON.stringify({id:73,method:"session/list"}));
      p.transport.send(JSON.stringify({id:74,jsonrpc:"2.0",method:"query",params:{path:"web.admission"}}));
      await until(()=>p.data.some(x=>x.includes('"pending"')),"pending admission status");
      assert.equal(dispatches,0);assert.equal(subscriptions,0);assert.equal(streamStops,0);
      assert.equal(owner.read().peers.length,0);assert(!p.data.some(x=>x.includes("session-secret")||x.includes("rpc-secret")));
      if(scenario === "account-runtime" || controllerMode) console.log("ACCOUNT_REQUEST "+row.token);
      else if(scenario === "account-deny") accountStore!.decide(row.token,"deny");
      else if(scenario === "account-expiry") accountClock += 3000;
      else if(scenario === "account-disconnect") p.ws.close();
      else if(scenario === "account-carrier") carriers.at(-1)!.close(1012,"fixture carrier drop");
      else if(scenario === "account-authority") {
        owner.mutate(0,"other-owner-change",{type:"grant",peer:{publicKey:bytesToHex(other.publicKey),pairedAt:"date"}});
        accountStore!.decide(row.token,"approve");
      } else if(scenario.startsWith("account-cas-")) accountStore!.decide(row.token,"approve");
      if(scenario === "account-runtime" || controllerMode) {
        await until(()=>owner.read().peers.some(peer=>peer.publicKey===key),"terminal decision committed canonical trust");
        assert.equal(accountStore!.get(row.token),null);
        p.transport.send(JSON.stringify({id:75,jsonrpc:"2.0",method:"query",params:{path:"probe"}}));
        await until(()=>p.data.some(x=>x.includes("rpc-secret")),"approved RPC");
        assert.equal(owner.read().revision,1);
        if (controllerMode) {
          const statePath=join(process.env.OPENSCOUT_PAIRING_HOME!,"runtime.json");
          const initial=JSON.parse(readFileSync(statePath,"utf8"));
          const opened=await requestLocalPairingOpportunity(bridgePort,"open");assert(opened);
          const rotated=JSON.parse(readFileSync(statePath,"utf8"));
          assert.equal(rotated.accountPairing.accountRoom,initial.accountPairing.accountRoom);
          assert(rotated.accountPairing.expiresAt>=initial.accountPairing.expiresAt);
          assert.notEqual(rotated.pairing.room,rotated.accountPairing.accountRoom);
          await requestLocalPairingOpportunity(bridgePort,"cancel",opened.windowId);
          const closed=JSON.parse(readFileSync(statePath,"utf8"));
          assert.equal(closed.pairing,null);assert.equal(closed.accountPairing.accountRoom,initial.accountPairing.accountRoom);
          console.log("CONTROLLER_OWNER_PATH_VERIFIED");
        }
      } else if(scenario === "account-disconnect" || scenario === "account-carrier") {
        await until(()=>Boolean(accountSignal?.aborted),"departed account waiter aborted");
        accountStore!.decide(row.token,"approve"); await Bun.sleep(20);
        assert(!owner.read().peers.some(peer=>peer.publicKey===key));
      } else {
        await until(()=>p.state.closed===4003,"account refusal close");
        assert(!owner.read().peers.some(peer=>peer.publicKey===key));
        assert.equal(dispatches,0);assert.equal(subscriptions,0);
      }
    }
  } else if (scenario === "revoked") {
    seed(); const first = await accepted(); revoke();
    // Already-connected revocation is the separate registry change. This fix
    // must not let an unadmitted reconnect evict this still-connected peer.
    const retry = await connect("IK"); await Bun.sleep(60);
    const retrusted = owner.read().peers.some(p => p.publicKey === key);
    console.log(JSON.stringify({flavor, scenario, retrusted, phoneClose: retry.state.closed, data: retry.data}));
    assert.equal(retrusted, false, "revoked phone was re-trusted by remembered-room reconnect");
    assert.equal(retry.state.closed, 4003); assert.equal(retry.data.length, 0); assert.equal(first.state.closed, 0);
    await denied("XX");
  } else if (scenario === "subscriptions") {
    seed(); const current = await accepted();
    current.transport.send(JSON.stringify({id: 41, jsonrpc: "2.0", method: "subscription", params: {path: "stream"}}));
    await until(() => current.data.some(x => x.includes("relay-stream")), "stream data");
    const frames = current.data.map(x => JSON.parse(x)).filter(x => x.id === 41);
    assert(frames.some(x => x.result?.type === "started"));
    assert(frames.some(x => x.result?.id === "event-1" && x.result.data.id === "event-1"));
    current.transport.send(JSON.stringify({id: 41, jsonrpc: "2.0", method: "subscription.stop"}));
    await until(() => streamStops === 1, "subscription stop");
    current.transport.send(JSON.stringify({id: 42, jsonrpc: "2.0", method: "subscription", params: {path: "stream"}}));
    await until(() => current.data.some(x => JSON.parse(x).id === 42 && x.includes("relay-stream")), "second stream data");
    current.ws.close(); await until(() => streamStops === 2, "peer-close cleanup");
  } else if (scenario === "lifecycle") {
    await denied("XX");
    begin(); opportunity!.cancel(); await denied("XX");
    begin(15); await Bun.sleep(25); await denied("IK");
    begin(); seed(); revoke(); await denied("XX"); // revision change cancels
    begin(); await accepted(); await denied("IK", other); // completion closes
    const revision = owner.read().revision;
    for (const pattern of ["IK", "XX"] as const) await accepted(pattern);
    assert.equal(owner.read().revision, revision, "trusted reconnect wrote a generation");
    revoke();
    // Changing only the QR display lifetime cannot open an opportunity.
    connection.qrPayload.expiresAt = Date.now() + 300_000;
    await denied("IK"); await denied("XX");
    begin(); await accepted("IK"); assert(owner.read().peers.some(p => p.publicKey === key));
  } else if (scenario === "carrier") {
    seed(); await accepted();
    const old = carriers[0]!; old.close(1012, "test carrier restart");
    await until(() => carriers.length > 1 && carriers.at(-1)!.readyState === WebSocket.OPEN, "carrier reconnect");
    const current = await accepted("IK");
    // Deliver a late callback on the old real socket after a new carrier is up.
    old.dispatchEvent(new Event("close"));
    current.data.length = 0;
    current.transport.send(JSON.stringify({id: 5, jsonrpc: "2.0", method: "query", params: {path: "probe"}}));
    await until(() => current.data.some(x => x.includes("rpc-secret")), "current carrier survived stale close");
    await denied("XX", other);
  } else if (scenario === "authority") {
    begin(); console.log("OPPORTUNITY_READY"); await Bun.stdin.text();
    await denied("XX"); assert(!owner.read().peers.some(p => p.publicKey === key));
  } else if (scenario === "workflow") {
    await denied("XX"); // runtime/daemon start is reconnect-only
    const originalRoom = runtime.qrPayload.room;
    const opened = await requestLocalPairingOpportunity(bridgePort, "open"); assert(opened);
    assert.notEqual(opened.payload.room, originalRoom, "explicit QR must rotate remembered room");
    await requestLocalPairingOpportunity(bridgePort, "cancel", opened.windowId);
    await denied("IK");
    const fresh = await requestLocalPairingOpportunity(bridgePort, "open"); assert(fresh);
    assert.notEqual(fresh.payload.room, opened.payload.room);
    await requestLocalPairingOpportunity(bridgePort, "cancel", opened.windowId); // stale cancel cannot cancel a newer view
    workflowRoom = fresh.payload.room;
    const relayPeer = await accepted();
    relayPeer.transport.send(JSON.stringify({id: "credential-relay-trpc", jsonrpc: "2.0", method: "query", params: {path: "probe"}}));
    await until(() => relayPeer.data.some(x => x.includes("credential-relay-trpc") && x.includes("rpc-secret")), "relay tRPC credential context");
    await denied("XX", other);
    const direct = await connect("XX", phone, true);
    direct.transport.send(JSON.stringify({id: "credential-trpc", jsonrpc: "2.0", method: "query", params: {path: "probe"}}));
    await until(() => direct.data.some(x => x.includes("credential-trpc") && x.includes("rpc-secret")), "direct tRPC credential context");
    direct.transport.send(JSON.stringify({id: "forged-control", method: "pairing/opportunity", params: {action: "open"}}));
    await until(() => direct.data.some(x => x.includes("forged-control")), "remote control refusal");
    assert(direct.data.find(x => x.includes("forged-control"))!.includes("-32001"));
    const legacyPort = await freePort();
    const legacy = realLegacyServer.startBridgeServer(bridge as any, legacyPort, { secure: true, identity: host });
    try {
      const legacyPeer = await connect("XX", phone, legacyPort);
      legacyPeer.transport.send(JSON.stringify({id: "credential-direct-legacy", method: "mobile/terminal/status", params: { credentialBinding: { publicKey: bytesToHex(other.publicKey) } }}));
      await until(() => legacyPeer.data.some(x => x.includes("credential-direct-legacy") && x.includes("rpc-secret")), "direct legacy credential context");
      legacyPeer.ws.close();
    } finally { legacy.stop(); }
    await denied("XX", other);
  } else throw Error("unknown scenario");
  console.log(JSON.stringify({ok: true, flavor, scenario, revision: owner.read().revision, dispatches, subscriptions}));
} catch(error) {
  console.error(error);
  throw error;
} finally {
  if (controllerMode) {
    process.kill(process.pid,"SIGTERM");
    await new Promise(()=>{}); // controller's real shutdown writes withdrawal and exits
  }
  for (const ws of sockets) ws.close();
  if (runtime) await runtime.stop(); else connection.disconnect();
  relay.stop();
  accountStore?.dispose();
}
// Relay idle/grace timers are not application ownership; do not leave a worker
// alive just to wait them out after its explicit shutdown.
process.exit(0);
