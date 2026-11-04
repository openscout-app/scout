import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bridgeLaunch, readSecretFile } from './bridge-config.ts';
import { MeshRelayServerTransport, parseBridgeBoundEnvelope } from './mesh-bridge.ts';
import { selectRuntimeClient } from './cli-context.ts';
import { RuntimeHttpClient } from './http-client.ts';
import { runMeshApprovalsCommand } from './mesh-approvals.ts';
const dir=mkdtempSync(join(tmpdir(),'mesh-detached-'));
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const executable=join(dir,'artifact/bin/scout-mesh');
const build=Bun.spawn([process.execPath,'run',resolve(import.meta.dir,'../scripts/build.ts'),join(dir,'artifact')],{stdout:'ignore',stderr:'pipe'});
if(await build.exited)throw new Error(await new Response(build.stderr).text());
function command(args:string[],env:Record<string,string>={}){return Bun.spawn([process.execPath,executable,...args],{cwd:dir,env:{HOME:dir,PATH:'/usr/bin:/bin',...env},stdout:'pipe',stderr:'pipe'});}
async function result(p:ReturnType<typeof command>){return {code:await p.exited,out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text()};}
test('artifact is relocatable, help-first and contains no runtime paths or stores',async()=>{
  const r=await result(command(['--config',join(dir,'nonexistent'),'--help']));expect(r.code).toBe(0);expect(r.out).toContain('HTTP runtime client');
  const help=await result(command(['access','--help','--config',join(dir,'nonexistent')]));expect(help.code).toBe(0);expect(help.out).toContain('admin-key create');
  const manifest=JSON.parse(readFileSync(join(dir,'artifact/extension.json'),'utf8'));expect(manifest).toMatchObject({api:1,command:'bin/scout-mesh',name:'mesh'});
  const code=readFileSync(executable,'utf8');for(const forbidden of ['apps/desktop/src','packages/runtime/src/node-identity.ts','packages/runtime/src/support-paths.ts','packages/runtime/src/broker-runtime.ts'])expect(code).not.toContain(forbidden);
});
test('detached executable reads HTTP status and canonical ping only',async()=>{
  const calls:string[]=[];const server=Bun.serve({port:0,fetch:async request=>{const p=new URL(request.url).pathname;calls.push(p);if(p==='/v1/mesh/ping'){expect(await request.json()).toEqual({target:'https://peer.invalid'});return Response.json({ok:true});}return Response.json(p==='/v1/mesh/nodes'?{local:{id:'local',registeredAt:Date.now()-8*24*60*60*1000},remote:{id:'remote',registeredAt:Date.now()-8*24*60*60*1000}}:p==='/v1/node'?{id:'local'}:{ok:true});}});
  try{const env={OPENSCOUT_BROKER_URL:server.url.origin};const status=await result(command(['status','--json'],env));expect(status.code).toBe(0);expect(JSON.parse(status.out).nodes.local).toBeDefined();expect(JSON.parse(status.out).nodes.remote).toBeUndefined();expect(calls.sort()).toEqual(['/health','/v1/mesh/diagnostics','/v1/mesh/nodes','/v1/node']);calls.length=0;expect((await result(command(['ping','https://peer.invalid'],env))).code).toBe(0);expect(calls).toEqual(['/v1/mesh/ping']);}finally{server.stop(true);}
});
test('join reports discovery unavailable without undoing successful bind',async()=>{
  const calls:string[]=[];const server=Bun.serve({port:0,fetch:r=>{calls.push(new URL(r.url).pathname);return new URL(r.url).pathname.endsWith('/bind')?Response.json({bind:{scope:'mesh'}}):new Response('unavailable',{status:503});}});
  try{const r=await result(command(['join','--json'],{OPENSCOUT_BROKER_URL:server.url.origin}));expect(r.code).toBe(0);expect(JSON.parse(r.out)).toMatchObject({bind:{scope:'mesh'},discovery:{unavailable:true}});expect(calls).toHaveLength(2);}finally{server.stop(true);}
});
test('bridge fails closed with exit78, no env-token fallback and named tools refusal',async()=>{
  let r=await result(command(['bridge'],{OPENSCOUT_MCP_TOKEN:'must-not-appear'}));expect(r.code).toBe(78);expect(r.err).not.toContain('must-not-appear');
  const path=join(dir,'config.json');writeFileSync(path,JSON.stringify({brokerUrl:'http://127.0.0.1:1',relayUrl:'https://relay.invalid',token:'redact-me',tools:['private_desktop_tool']}),{mode:0o600});
  r=await result(command(['bridge','--config',path]));expect(r.code).toBe(78);expect(r.err).toContain('private_desktop_tool');expect(r.err).not.toContain('redact-me');
  expect((await bridgeLaunch(path,'core')).toolNames).toHaveLength(20);
  chmodSync(path,0o644);await expect(bridgeLaunch(path)).rejects.toThrow();
});
test('credential reader rejects symlinks, oversized and world-readable files',()=>{
  const p=join(dir,'secret');writeFileSync(p,'x',{mode:0o600});symlinkSync(p,p+'.link');expect(()=>readSecretFile(p+'.link')).toThrow();expect(()=>readSecretFile(p,0)).toThrow();chmodSync(p,0o644);expect(()=>readSecretFile(p)).toThrow();
});
test('bridge parser bounds frames, transport cancellation reaches SDK and duplicate IDs refuse',()=>{
  expect(parseBridgeBoundEnvelope('x'.repeat(256*1024+1))).toBeNull();const t=new MeshRelayServerTransport(), emitted:any[]=[],messages:any[]=[];t.bindEmitter(e=>emitted.push(e));t.onmessage=m=>messages.push(m);
  const request=(id:string)=>({v:1 as const,kind:'mcp_request' as const,id,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{}})});
  t.deliver(request('a'));t.deliver(request('b'));expect(emitted[0].status).toBe(409);t.deliver({v:1,kind:'mcp_cancel',id:'a'});expect(messages.at(-1)).toMatchObject({method:'notifications/cancelled',params:{requestId:1}});
});
test('approvals converts a label to an active canonical key and persists through HTTP only',async()=>{
  const key='a'.repeat(64);let config={share:[] as string[],watch:false};const writes:any[]=[];
  const client=new RuntimeHttpClient({brokerUrl:'http://127.0.0.1:1',fetch:(async(input,init)=>{const p=new URL(String(input)).pathname;if(p.includes('approvals')){if(init?.body){config=JSON.parse(String(init.body));writes.push(config);}return Response.json(config);}return Response.json({peers:[{keyId:key,label:'my-peer',fingerprint:'osc1:test',nodeId:'peer'}]});}) as typeof fetch});
  selectRuntimeClient(client);const ctx:any={output:{writeValue:()=>{},writeText:()=>{}}};
  try{await runMeshApprovalsCommand(ctx,['share','my-peer']);await runMeshApprovalsCommand(ctx,['unshare','my-peer']);expect(writes).toEqual([{share:[key],watch:false},{share:[],watch:false}]);}finally{selectRuntimeClient(undefined);}
});

async function until(predicate:()=>boolean,ms=7000){const start=Date.now();while(!predicate()){if(Date.now()-start>ms)throw new Error('fixture deadline');await Bun.sleep(30);}}
const preload=join(dir,'socket-fixture.ts');
writeFileSync(preload,`import {writeFileSync} from 'node:fs';
class Socket extends EventTarget {
 static OPEN=1;readyState=1;
 constructor(){super();setTimeout(()=>{writeFileSync(process.env.FIXTURE_READY,'ready');this.dispatchEvent(new Event('open'));},10);}
 send(){}close(){writeFileSync(process.env.FIXTURE_CLOSED,'closed');this.readyState=3;}
}globalThis.WebSocket=Socket;
`);
test('detached bridge closes once on SIGTERM with no source or token environment',async()=>{
  const config=join(dir,'signal-config.json'),closed=join(dir,'signal-closed'),ready=join(dir,'signal-ready');
  writeFileSync(config,JSON.stringify({brokerUrl:'http://127.0.0.1:1',relayUrl:'https://relay.invalid',token:'fixture-secret'}),{mode:0o600});
  const p=Bun.spawn([process.execPath,'--preload',preload,executable,'bridge','--config',config],{cwd:dir,env:{HOME:dir,PATH:'/usr/bin:/bin',FIXTURE_READY:ready,FIXTURE_CLOSED:closed},stdout:'pipe',stderr:'pipe'});
  try{await until(()=>Bun.file(ready).size>0);p.kill('SIGTERM');const r=await result(p);expect(r.code).toBe(0);expect(readFileSync(closed,'utf8')).toBe('closed');expect(r.err).not.toContain('fixture-secret');}finally{p.kill();}
});
test('direct child bridge fences parent death using explicit config PID',async()=>{
  const parentScript=join(dir,'parent.ts'),closed=join(dir,'parent-closed'),ready=join(dir,'parent-ready'),pidFile=join(dir,'child.pid');
  writeFileSync(parentScript,`import {writeFileSync} from 'node:fs';
const config=${JSON.stringify(join(dir,'parent-config.json'))};
writeFileSync(config,JSON.stringify({brokerUrl:'http://127.0.0.1:1',relayUrl:'https://relay.invalid',token:'fixture-secret',supervisor:{parentPid:process.pid}}),{mode:0o600});
const child=Bun.spawn([process.execPath,'--preload',${JSON.stringify(preload)},${JSON.stringify(executable)},'bridge','--config',config],{env:{HOME:${JSON.stringify(dir)},PATH:'/usr/bin:/bin',FIXTURE_READY:${JSON.stringify(ready)},FIXTURE_CLOSED:${JSON.stringify(closed)}},stdout:'ignore',stderr:'ignore'});
writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);
`);
  const parent=Bun.spawn([process.execPath,parentScript],{cwd:dir,stdout:'ignore',stderr:'ignore'});let child=0;
  try{await until(()=>Bun.file(ready).size>0);child=Number(readFileSync(pidFile,'utf8'));parent.kill('SIGKILL');await parent.exited;await until(()=>Bun.file(closed).size>0);expect(readFileSync(closed,'utf8')).toBe('closed');}finally{parent.kill();if(child)try{process.kill(child,'SIGKILL');}catch{}}
},12000);

test('relay pins full principals, rejects agent-only envelopes and serves all20 HTTP tools',async()=>{
  const original=globalThis.WebSocket;const sent:any[]=[];let socket:any;
  class Socket extends EventTarget {static OPEN=1;readyState=1;constructor(){super();socket=this;}send(s:string){sent.push(JSON.parse(s));}close(){this.readyState=3;} frame(value:any){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}}
  globalThis.WebSocket=Socket as any;const {startScoutMeshMcpBridge}=await import('./mesh-bridge.ts');
  const client=new RuntimeHttpClient({brokerUrl:'http://127.0.0.1:1',fetch:(async()=>new Response('refused',{status:503})) as typeof fetch});
  let handle:Awaited<ReturnType<typeof startScoutMeshMcpBridge>>|undefined;
  try{
    handle=await startScoutMeshMcpBridge({relayUrl:'https://relay.invalid',token:'fixture-secret',senderId:'unused',currentDirectory:dir,client,toolNames:(await import('@openscout/protocol')).SCOUT_MCP_CORE_TOOL_NAMES.slice()});
    const principal={kind:'oauth',id:'user',userId:'user',ownerKey:'owner',node:'node',agentId:'remote-agent'};
    socket.frame({v:1,kind:'mcp_request',id:'no-principal',agent:'remote-agent',payload:'{}'});await until(()=>sent.length>0);expect(sent.shift()).toMatchObject({status:403});
    const send=(id:string,payload:any,p:any=principal)=>socket.frame({v:1,kind:'mcp_request',id,agent:'remote-agent',principal:p,payload:JSON.stringify(payload)});
    send('init',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});await until(()=>sent.some(x=>x.id==='init'));
    send('list',{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});await until(()=>sent.some(x=>x.id==='list'));expect(JSON.parse(sent.find(x=>x.id==='list').payload).result.tools).toHaveLength(20);
    send('mismatch',{jsonrpc:'2.0',id:3,method:'tools/list',params:{}},{...principal,agentId:'somebody-else'});await until(()=>sent.some(x=>x.id==='mismatch'));expect(sent.find(x=>x.id==='mismatch').status).toBe(403);
  }finally{await handle?.close();globalThis.WebSocket=original;}
});
