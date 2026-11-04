import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SCOUT_MCP_CORE_TOOL_NAMES } from '@openscout/protocol';
import { createScoutMcpServer } from '../../cli/src/mcp/scout-mcp.ts';
import { selectCoreTools } from './core-http-mcp.ts';
// Zod's stdio validator strips undeclared object keys; the portable HTTP
// adapter rejects them. Normalize only that documented stronger HTTP policy
// plus annotations, retaining every actual type/enum/bound/required keyword.
function wire(value:any, stdio=false):any {
  if(Array.isArray(value))return value.map(item=>wire(item,stdio));
  if(value && typeof value==='object') {
    const result=Object.fromEntries(Object.entries(value).filter(([key])=>!['description','title'].includes(key)).map(([key,v])=>[key,wire(v,stdio)]));
    if(stdio && result.type==='object' && !Object.hasOwn(result,'additionalProperties'))result.additionalProperties=false;
    return result;
  }
  return value;
}
test('all 20 HTTP tool argument schemas retain the existing public core wire types',async()=>{
  const server=createScoutMcpServer({defaultCurrentDirectory:'/',env:{},toolFilter:n=>SCOUT_MCP_CORE_TOOL_NAMES.includes(n as never)});
  const client=new Client({name:'parity',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a),client.connect(b)]);const current=(await client.listTools()).tools;
    expect(current.map(t=>t.name).sort()).toEqual([...SCOUT_MCP_CORE_TOOL_NAMES].sort());
    expect(selectCoreTools()).toHaveLength(20);
    for(const tool of selectCoreTools())expect({name:tool.name,schema:wire(tool.inputSchema),annotations:tool.annotations}).toEqual({name:tool.name,schema:wire(current.find(v=>v.name===tool.name)!.inputSchema,true),annotations:current.find(v=>v.name===tool.name)!.annotations});
  } finally {await client.close();await server.close();}
});
