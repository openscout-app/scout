import {loadOrCreateNodeIdentity} from "@openscout/runtime/mesh/node-identity";
import {PairingTrustOwner} from "@openscout/runtime/pairing-security/trust-owner";
import { createPendingPairRequestStore, pairRequestStatePath } from "../pairing-pair-requests.ts";
import { localConfigHome } from "@openscout/runtime/local-config";
// Run with HOME pointed at a scratch directory: pairing identity paths are
// fixed from homedir() at module load.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createScoutPairingBridgeClient } from "../pairing.ts";
import { startBridgeServerTRPC } from "../core/pairing/runtime/bridge/server-trpc.ts";
import { bytesToHex, generateKeyPair, loadOrCreateIdentity, SecureTransport } from "../core/pairing/runtime/security/index.ts";
import type { Bridge } from "../core/pairing/runtime/bridge/bridge.ts";
import { resolveOpenScoutPairingHome } from "@openscout/runtime/support-paths";

loadOrCreateNodeIdentity();
const identity = loadOrCreateIdentity();
const bridge = {
  listSessions: () => [],
  getSessionSummaries: () => [],
  onEvent: () => () => {},
} as unknown as Bridge;
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const port = reservation.port!;
reservation.stop(true);
let invitationOpens=0;
const server = startBridgeServerTRPC({ bridge, port, secure: true, identity, pairingControl: (action) => {
  if(action === "open" || action === "request-open") invitationOpens++;
  return null;
} });

const client = await createScoutPairingBridgeClient(port);
const status = await client.query<{ sessions: unknown[] }>("bridgeStatus");
client.close();

// A stranger with its own key completes Noise but is not on the paired list.
const strangerCloseCode = await new Promise<number>((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}?events=0`);
  const transport = { current: null as SecureTransport | null };
  socket.onopen = () => {
    transport.current = new SecureTransport(
      { send: (frame) => socket.send(frame) },
      "initiator",
      generateKeyPair(),
      {},
      { trustOnComplete: false },
    );
  };
  socket.onmessage = (event) => transport.current?.receive(event.data as string);
  socket.onclose = (event) => resolve(event.code);
});

const ingressOrigin = `http://127.0.0.1:${port}`;
const operatorHeaders = { authorization: `Bearer ${process.env.OPENSCOUT_WEB_AUTH_TOKEN}` };
const unauthenticated = await fetch(`${ingressOrigin}/api/pairing/requests`).then(r => r.status);
const authenticated = await fetch(`${ingressOrigin}/api/pairing/requests`, {headers: operatorHeaders}).then(r => r.status);
const forwarded = await fetch(`${ingressOrigin}/api/pairing/requests`, {headers: {...operatorHeaders, "x-forwarded-for": "192.0.2.10"}}).then(r => r.status);
const noClient = await fetch(`${ingressOrigin}/`).then(r => r.status);
const pairKnock = await fetch(`${ingressOrigin}/pair`, {headers: {accept: "application/json"}, redirect: "manual"}).then(r => r.status);
const accountSpoof=await fetch(`${ingressOrigin}/pair?route=account`,{headers:{accept:"application/json"}}).then(r=>r.status);
const requests=createPendingPairRequestStore({statePath:pairRequestStatePath(localConfigHome())});
const row=requests.create({requesterIp:"key aaaaaaaaaaaa",requesterPublicKey:"a".repeat(64),route:"account"});
const decide=(decision:string)=>fetch(`${ingressOrigin}/api/pairing/requests/${row.token}/decide`,{method:"POST",headers:{...operatorHeaders,"content-type":"application/json"},body:JSON.stringify({decision})});
const approval=await decide("approve").then(r=>r.status);
const repeated=await decide("deny").then(r=>r.status);
const accountPoll=await fetch(`${ingressOrigin}/pair?token=${row.token}`,{headers:{accept:"application/json"}}).then(r=>r.status);
requests.dispose();
server.stop();
const trustedPeersWritten = existsSync(join(resolveOpenScoutPairingHome(), "trusted-peers.json"));

// Even when this key is already on the paired list, neither side rewrites it.
const peersFile = join(resolveOpenScoutPairingHome(), "trusted-peers.json");
const seeded = JSON.stringify([{ publicKey: bytesToHex(identity.publicKey), pairedAt: "2026-01-01T00:00:00.000Z" }]);
writeFileSync(peersFile, seeded, {mode:0o600});
// The fixture deliberately imports legacy bytes under quiescent maintenance.
// Local readers still leave those bytes and paired-device membership untouched.
new PairingTrustOwner(resolveOpenScoutPairingHome()).bindToHost("secure-reader-fixture",{quiescent:true});
const seededServer = startBridgeServerTRPC({ bridge, port, secure: true, identity });
const seededClient = await createScoutPairingBridgeClient(port);
await seededClient.query("bridgeStatus");
seededClient.close();
seededServer.stop();
const seededRecordUntouched = readFileSync(peersFile, "utf8") === seeded;
rmSync(peersFile);

// A squatter on the port that claims plaintext cannot talk the reader down:
// with no config the bridge is secure, so the reader insists on Noise.
const squatter = Bun.serve<{ t?: SecureTransport }>({
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, mode: "plaintext" });
    return srv.upgrade(req, { data: {} }) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    message(ws, raw) {
      // Play along with Noise using a key that is not the bridge's.
      const state = ws.data;
      state.t ??= new SecureTransport({ send: (f) => ws.send(f) }, "responder", generateKeyPair(), {}, { trustOnComplete: false });
      state.t.receive(typeof raw === "string" ? raw : new Uint8Array(raw));
    },
  },
});
const squatterError = await createScoutPairingBridgeClient(squatter.port!)
  .then((c) => { c.close(); return "connected"; }, (e: Error) => e.message);
squatter.stop(true);

console.log(JSON.stringify({
  ingress: { unauthenticated, authenticated, forwarded, noClient, pairKnock },
  accountHost: {accountSpoof,approval,repeated,accountPoll,invitationOpens},
  sessions: status.sessions,
  strangerCloseCode,
  trustedPeersWritten,
  seededRecordUntouched,
  squatterError,
}));
