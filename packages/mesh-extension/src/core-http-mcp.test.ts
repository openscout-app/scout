import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SCOUT_MCP_CORE_TOOL_NAMES, type McpEventPrincipal } from '@openscout/protocol';
import { CoreHttpAdapter, selectCoreTools } from './core-http-mcp.ts';
import { RuntimeHttpClient } from './http-client.ts';
import { localAdminProof } from './local-admin-proof.ts';
import { verifyLocalAdminRequest } from '../../runtime/src/mesh-access-local-auth.ts';
const principal: McpEventPrincipal = { kind:'oauth', id:'identity', ownerKey:'owner', node:'node', agentId:'sender' };
function fixture() {
  const calls: { url: URL; body: any; headers: Headers }[] = [];
  const snap: any = { agents: { target: { id:'target', definitionId:'target', displayName:'Target' } }, actors:{}, conversations:{ c:{id:'c',kind:'direct',visibility:'private',participantIds:['sender','target']} }, messages: { m: {id:'m',conversationId:'c',actorId:'target',body:'question'} }, flights:{f:{id:'f',invocationId:'i',state:'completed',requesterId:'sender',targetAgentId:'target',labels:['label']}}, collaborationRecords:{w:{id:'w',kind:'work_item',title:'Work',state:'open',labels:['label'],updatedAt:1}} };
  const client = new RuntimeHttpClient({brokerUrl:'http://127.0.0.1:1234', fetch: (async (input:any, init:any) => {
    const url = new URL(input);const body = init.body ? JSON.parse(init.body) : undefined;calls.push({url,body,headers:new Headers(init.headers)});
    const path = url.pathname;
    const result = path === '/v1/snapshot' ? snap : path === '/v1/node' ? {nodeId:'node',capabilities:['ask-reply/1'],keyId:'a'.repeat(64)} : path === '/v1/deliver' ? {kind:'delivery',message:{id:'message'},conversation:{id:'c'},flight:{id:'f',invocationId:'i',state:'queued'}} : path.endsWith('/collect') ? {id:'report',status:'saved',diagnosticsIncluded:!!body.diagnostics} : path.endsWith('/upload') ? {id:'report',status:'uploaded'} : path === '/v1/messages' && !body ? [] : path === '/v1/collaboration/events' && !body ? [] : path === '/v1/tail/recent' ? { events:[],limit:80,cursor:null } : {ok:true};
    return Response.json(result);
  }) as typeof fetch});
  return {calls,snap,client,adapter:new CoreHttpAdapter({client,principal,currentDirectory:'/project'})};
}
test('all default tools have SDK discovery and real HTTP-backed handlers', async () => {
  const f=fixture();const server=f.adapter.server(), client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  try {expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual([...SCOUT_MCP_CORE_TOOL_NAMES].sort());} finally {await client.close();await server.close();}
  const cases: Record<string,any> = {sessions_attach:{nativeSessionId:'native'},sessions_get:{sessionId:'s'},sessions_poll:{sessionId:'s'},sessions_ack:{sessionId:'s',deliveryId:'d'},whoami:{},feedback_send:{note:'feedback'},messages_inbox:{},messages_channel:{channel:'room'},broker_feed:{},tail_events:{},current_reply_context:{},reply:{body:'answer',to:'m'},agents_search:{query:'Target'},agents_resolve:{label:'target'},ask:{to:'id:target',body:'work',requestId:'request',workItem:{title:'task'}},invocations_get:{flightId:'f'},invocations_wait:{flightId:'f',timeoutSeconds:1},labels_brief:{label:'label'},labels_feed:{label:'label'},work_update:{work:{workId:'w',state:'working'}}};
  for(const name of SCOUT_MCP_CORE_TOOL_NAMES) {const result=await f.adapter.call(name,cases[name]);expect(result).toBeDefined();}
  expect(f.calls.every(c=>c.url.origin==='http://127.0.0.1:1234')).toBe(true);
  expect(f.calls.find(c=>c.url.pathname==='/v1/external-sessions/attach')?.body.ownerId).toBe('sender');
  expect(f.calls.filter(c=>c.url.pathname==='/v1/deliver').every(c=>c.body.caller.actorId==='sender')).toBe(true);
  expect(f.calls.find(c=>c.body?.recordKind==='work_item')?.body.kind).toBe('claimed');
});
test('unknown custom tools fail at startup by name, not silently skipped',()=>{
  expect(()=>selectCoreTools(['whoami','route_context','private_tool'])).toThrow('route_context, private_tool');
  expect(()=>selectCoreTools([])).toThrow('empty list');
});
test('principal and owner IDs cannot be supplied or changed by a tool caller',async()=>{
  const f=fixture();
  await expect(f.adapter.call('whoami',{senderId:'victim'})).rejects.toThrow('pinned');
  await expect(f.adapter.call('sessions_attach',{nativeSessionId:'n',ownerId:'victim'})).rejects.toThrow('invalid arguments');
  await expect(f.adapter.call('feedback_send',{note:'n',principal:{...principal,agentId:'victim'}})).rejects.toThrow('invalid arguments');
  expect(f.calls).toHaveLength(0);
});
test('feedback uses only bridge collect/upload and never rescues failures via local provenance',async()=>{
  const f=fixture();await f.adapter.call('feedback_send',{note:'n',diagnostics:true});
  expect(f.calls.map(c=>c.url.pathname)).toEqual(['/v1/mesh/bridge/feedback/collect','/v1/mesh/bridge/feedback/upload']);
  expect(f.calls[0]?.body).toEqual({message:'n',diagnostics:true,principal});
  const unverified = new CoreHttpAdapter({client:f.client,principal,diagnosticsIdentityVerified:false});
  await unverified.call('feedback_send',{note:'n',diagnostics:true,localOnly:true});
  expect(f.calls.at(-1)?.body.diagnostics).toBe(false);
});
test('tail arguments survive HTTP encoding including repeated sources and all filters',async()=>{
  const f=fixture();await f.adapter.call('tail_events',{sources:['Codex','Claude'],kinds:['assistant'],sessionId:'s',project:'Project',cwd:'/repo',query:'hello world',transcripts:true,limit:3});
  const q=f.calls[0]!.url.searchParams;expect(q.getAll('sources')).toEqual(['Codex','Claude']);expect(q.getAll('kinds')).toEqual(['assistant']);
  for(const [key,value] of Object.entries({sessionId:'s',project:'Project',cwd:'/repo',query:'hello world',transcripts:'1',limit:'3'}))expect(q.get(key)).toBe(value);
});
test('reply uses canonical typed completion endpoint and pinned sender',async()=>{
  const f=fixture();await f.adapter.call('reply',{body:'answer',ref:'i',progress:true,requestId:'stable'});
  expect(f.calls.at(-1)!.url.pathname).toBe('/v1/messages/reply');
  expect(f.calls.at(-1)!.body).toMatchObject({senderId:'sender',ref:'i',progress:true,requestId:'stable'});
});
test('FYI is deliberate and channel work fails before any HTTP call',async()=>{
  const f=fixture();
  await expect(f.adapter.call('ask',{body:'n',channel:'shared'})).rejects.toThrow('--channel');
  expect(f.calls).toHaveLength(0);
  await f.adapter.call('ask',{body:'n',to:'id:target',fyi:true});
  expect(f.calls.at(-1)?.body).toMatchObject({intent:'task_ask',task:{version:1,fyi:true},ensureAwake:false});
  expect(f.calls.at(-1)?.body.execution).toBeUndefined();
});
test('local-admin proof interoperates with runtime verification without reading runtime keys',async()=>{
  const key='a'.repeat(64),destinationKeyId='b'.repeat(64), input={method:'POST',path:'/v1/deliver?q=1',body:'{"body":"test"}'};
  const headers=await localAdminProof(key,destinationKeyId)(input);
  expect(verifyLocalAdminRequest(key,{...input,destinationKeyId,headers,bootedAt:Date.now()-1000,nonceClaim:{claim:()=>true}})).toEqual({ok:true});
  expect(JSON.stringify(headers)).not.toContain(key);
});
test('HTTP transport rejects credential URLs, cross-origin paths, unbounded responses and raw errors',async()=>{
  expect(()=>new RuntimeHttpClient({brokerUrl:'http://user:secret@localhost'})).toThrow();
  const f=fixture();await expect(f.client.request('https://outside.example/v1/node')).rejects.toThrow('API path');
  const c=new RuntimeHttpClient({brokerUrl:'http://localhost',fetch:(async()=>new Response('private-transport-detail',{status:500})) as typeof fetch});
  await expect(c.request('/v1/node')).rejects.toThrow('runtime request refused (500)');
});
test('HTTP response size and cancellation bounds fail closed', async()=>{
  const huge = new RuntimeHttpClient({brokerUrl:'http://localhost',fetch:(async()=>new Response(new Uint8Array(8*1024*1024+1))) as typeof fetch});
  await expect(huge.request('/v1/node')).rejects.toThrow('size bound');
  const controller=new AbortController();controller.abort();
  const f=fixture();await expect(f.adapter.call('invocations_get',{flightId:'f'},controller.signal)).rejects.toBeDefined();
});
test('session targets remain exact continuations and work metadata is requester scoped',async()=>{
  const f=fixture();await f.adapter.call('ask',{to:'session:sess.exact',body:'continue',requestId:'same',workspace:'same',workItem:{title:'Task'}});
  const a=f.calls.at(-1)!.body;expect(a.targetSessionId).toBe('sess.exact');expect(a.execution.session).toBe('existing');
  expect(a.invocationMetadata.askWorkspace).toBe('same');expect(a.invocationMetadata.workId).toBe(a.collaborationRecordId);
  const other=new CoreHttpAdapter({client:f.client,principal:{...principal,agentId:'another'}});
  await other.call('ask',{to:'id:target',body:'work',requestId:'same',workItem:{title:'Task'}});
  expect(f.calls.at(-1)!.body.collaborationRecordId).not.toBe(a.collaborationRecordId);
  await expect(f.adapter.call('ask',{to:'id:target',body:'work',workItem:{title:'Task',id:'forged'}})).rejects.toThrow('invalid arguments');
});

test('external HTTP replies derive stable delivery keys and keep progress separate',async()=>{
  const f=fixture(), args={ref:'task',sessionId:'session',deliveryId:'delivery',body:'done'};
  await f.adapter.call('reply',args);await f.adapter.call('reply',args);
  await f.adapter.call('reply',{...args,progress:true});
  expect(f.calls[0]!.body.requestId).toBe(f.calls[1]!.body.requestId);
  expect(f.calls[2]!.body.requestId).not.toBe(f.calls[0]!.body.requestId);
});

test.each([
  ['already_answered', 'task already has a final reply'],
  ['completed', 'task is already completed'],
])('portable MCP reply exposes only the typed task-closed diagnostic: %s', async (reason, detail) => {
  const http = new RuntimeHttpClient({ brokerUrl: 'http://runtime.test', fetch: (async (_input, init) =>
    init?.method === 'POST'
      ? Response.json({ error: 'task_closed', taskId: 'task', flightId: 'flight', messageId: 'answer', reason, detail: 'private-transport-detail' }, { status: 409 })
      : Response.json({ capabilities: ['ask-reply/1'] })) as typeof fetch });
  const server = new CoreHttpAdapter({ client: http, principal }).server();
  const client = new Client({ name: 'closed-reply', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    for (const route of [{}, { sessionId: 'session', deliveryId: 'delivery' }]) {
      const result = await client.callTool({ name: 'reply', arguments: { ref: 'task', body: 'done', ...route } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(detail);
      expect(JSON.stringify(result.content)).not.toContain('private-transport-detail');
    }
  } finally { await client.close(); await server.close(); }
});

test('untyped task-closed errors keep their raw details redacted', async () => {
  const client = new RuntimeHttpClient({ brokerUrl: 'http://runtime.test', fetch: (async () =>
    Response.json({ error: 'task_closed', detail: 'private-transport-detail' }, { status: 409 })) as typeof fetch });
  await expect(client.request('/v1/messages/reply', {})).rejects.toThrow('runtime request refused (409)');
});
