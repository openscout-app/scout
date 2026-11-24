#!/usr/bin/env bun
import { RuntimeHttpClient } from './http-client.ts';
import { selectRuntimeClient, runtimeClient, resolveScoutBrokerUrl, type ScoutCommandContext } from './cli-context.ts';
import { loadLaunchConfig, bridgeLaunch } from './bridge-config.ts';
import { startScoutMeshMcpBridge } from './mesh-bridge.ts';
import * as trust from './mesh-trust.ts';
import { runMeshGuestsCommand, MESH_GUESTS_HELP } from './mesh-guests.ts';
import { runMeshAccessCommand, MESH_ACCESS_HELP } from './mesh-access.ts';
import { runMeshApprovalsCommand, MESH_APPROVALS_HELP } from './mesh-approvals.ts';
import { visibleMeshNodes } from '@openscout/runtime/mesh';

export const HELP = `scout mesh — portable mesh extension (HTTP runtime client)

status | doctor | nodes [--all] | discover | ping <node|url>
join | announce | leave | bind mesh|local
approvals | guests | peers | grant | revoke | card | enroll | trust | access
bridge --config <file> [--tools core|name,...]
bridge status | configure <json-file> | enable | disable | request-restart

Use --json for structured output. Select OPENSCOUT_BROKER_URL or --config <file>.
Bridge paths and credentials come only from --config. No implicit runtime paths.
Machine-key operations go through runtime HTTP; user-owned keys and SSH stay local.
`;
export async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  // Help must work in a detached artifact with no state, credentials or runtime.
  if (args.some(a=>a==='--help'||a==='-h') || args[0]==='help') {
    const detail = args[0]==='access'?MESH_ACCESS_HELP:args[0]==='approvals'?MESH_APPROVALS_HELP:args[0]==='guests'?MESH_GUESTS_HELP:
      ['trust','peers','grant','revoke','card','enroll'].includes(args[0]??'')?trust.MESH_TRUST_HELP:HELP;
    console.log(detail); return;
  }
  const json = args.includes('--json');args=args.filter(a=>a!=='--json');
  let configFile: string|undefined;
  const i=args.indexOf('--config');if(i>=0){configFile=args[i+1];if(!configFile||configFile.startsWith('--'))throw new Error('--config needs a file');args.splice(i,2);}
  const context: ScoutCommandContext = { env, cwd:process.cwd(),isTty:!!process.stdin.isTTY,
    stdout:t=>console.log(t),stderr:t=>console.error(t),output:{mode:json?'json':'plain',writeText:t=>console.log(t),writeValue:(v,render)=>console.log(json||!render?JSON.stringify(v,null,2):render(v))} };
  const [command='status',...rest]=args;
  if(command==='bridge' && !['status','configure','enable','disable','request-restart'].includes(rest[0]??'')) {
    try {
      if(!configFile)throw new Error('bridge requires --config');
      let tools:'core'|string[]|undefined;
      if(rest.length){if(rest[0]!=='--tools'||!rest[1]||rest.length!==2)throw new Error('bridge accepts only --config and --tools');tools=rest[1]==='core'?'core':rest[1].split(',');}
      const launch=await bridgeLaunch(configFile,tools);
      const handle=await startScoutMeshMcpBridge({client:launch.client,relayUrl:launch.relayUrl,token:launch.token,senderId:launch.config.sender??'bridge',currentDirectory:launch.currentDirectory,toolNames:launch.toolNames,eventsEnabled:launch.config.eventsEnabled,log:t=>console.error(t)});
      await new Promise<void>(resolve=>{
        let closing=false;
        const stop=()=>{if(closing)return;closing=true;clearInterval(parent);const deadline=setTimeout(()=>process.exit(1),5000);void handle.close().finally(()=>{clearTimeout(deadline);resolve();});};
        const parent=setInterval(()=>{if(launch.config.supervisor && process.ppid!==launch.config.supervisor.parentPid)stop();},1000);
        for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.once(signal,stop);
      });
    } catch(error) {
      // Zod/OS exceptions can contain supplied configuration or secret values.
      const message=error instanceof Error && error.message.startsWith('unsupported bridge tools:')?error.message:'bridge configuration refused';
      console.error(message);process.exitCode=78;
    }
    return;
  }
  selectRuntimeClient(configFile?loadLaunchConfig(configFile).client:env.OPENSCOUT_BROKER_URL?new RuntimeHttpClient({brokerUrl:env.OPENSCOUT_BROKER_URL}):undefined);
  const client={request:(path:string,body?:unknown)=>runtimeClient().request(path,body)},write=(v:unknown)=>context.output.writeValue(v);
  switch(command){
    case 'status':case 'doctor': {
      const [health,node,nodes,diagnostics]=await Promise.all([client.request('/health'),client.request('/v1/node'),client.request('/v1/mesh/nodes'),client.request('/v1/mesh/diagnostics')]);
      write({health,node,nodes:visibleMeshNodes(nodes,{localNodeId:node.id,all:rest.includes('--all')}),diagnostics});break;
    }
    case 'nodes': {const nodes=await client.request('/v1/mesh/nodes');const node=await client.request('/v1/node');write(visibleMeshNodes(nodes,{localNodeId:node.id,all:rest.includes('--all')}));break;}
    case 'discover':write(await client.request('/v1/mesh/discover',{}));break;
    case 'ping':if(rest.length!==1)throw new Error('ping needs one target');write(await client.request('/v1/mesh/ping',{target:rest[0]}));break;
    case 'join':case 'announce':case 'leave':case 'bind': {
      const scope=command==='bind'?rest[0]:command==='leave'?'local':'mesh';if(!['local','mesh'].includes(scope??''))throw new Error('bind needs mesh or local');
      const bind=await client.request('/v1/mesh/bind',{scope});
      let discovery:unknown=null;if(scope==='mesh'){try{discovery=await client.request('/v1/mesh/discover',{});}catch{discovery={unavailable:true};}}
      write({...bind,discovery});break;
    }
    case 'approvals':await runMeshApprovalsCommand(context,rest);break;
    case 'guests':await runMeshGuestsCommand(context,rest,{brokerUrl:resolveScoutBrokerUrl()});break;
    case 'access':await runMeshAccessCommand(context,rest);break;
    case 'peers':await trust.runMeshPeersCommand(context,rest);break;
    case 'grant':await trust.runMeshGrantCommand(context,rest);break;
    case 'revoke':await trust.runMeshRevokeCommand(context,rest);break;
    case 'card':await trust.runMeshCardCommand(context,rest);break;
    case 'enroll':await trust.runMeshEnrollCommand(context,rest);break;
    case 'trust':await trust.runMeshTrustCommand(context,rest);break;
    case 'bridge': {
      if(rest[0]==='status')write(await client.request('/v1/mesh/bridge'));
      else if(rest[0]==='configure'){
        if(!rest[1]||rest.length!==2)throw new Error('configure needs one JSON file');
        const {readSecretFile}=await import('./bridge-config.ts');write(await client.request('/v1/mesh/bridge/config',JSON.parse(readSecretFile(rest[1],64*1024))));
      }else write(await client.request('/v1/mesh/bridge/control',{action:rest[0]}));break;
    }
    default:throw new Error('unknown mesh command; use --help');
  }
}
if(import.meta.main) await run(process.argv.slice(2)).catch(()=>{console.error('mesh command failed; check arguments and runtime availability');process.exitCode=1;});
