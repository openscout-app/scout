import { numericWitness } from "../../../../scripts/extension-numeric-spike/witness.ts";
import { checkReclaimedDescriptors } from "./extension-descriptor-witness.ts";
import { scoutExtensionContextBackend } from "./extension-context-host.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, fstatSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseExtensionChannelCodeForWitness, BoundedChannelDescriptor } from "../../../runtime/src/extension-channel-io.ts";
import {
  applyOpenScoutInstanceEnvironment,
  deriveOpenScoutInstanceLayout,
  selectCliOpenScoutInstance,
  resolveOpenScoutPairingHomeForEnv,
  resolveOpenScoutHomeForEnv,
  resolveScoutHome,
} from "@openscout/runtime/config";
import { findScoutExtension, scoutExtensionEnv } from "./extensions.ts";
import { SCOUT_APP_VERSION } from "../lib/shared/product.ts";
import { mutateScoutExtension, readScoutExtensionInstallReceipt } from "./extension-install.ts";
import { captureScoutExtensionSelection, projectScoutExtensionContext, encodeScoutExtensionContext, EXTENSION_CONTEXT_MAX_BYTES, type ScoutExtensionContext } from "./extension-context.ts";
import { prepareScoutExtensionContext, runScoutExtensionWithQualifiedContext, runScoutExtensionWithContext, scoutExtensionContextStdio, stopScoutExtensionContextChild } from "./extension-context-runner.ts";
import { INHERITED_DESCRIPTOR_LAYOUTS, MAX_INHERITED_DESCRIPTOR_SLOT } from "@openscout/runtime/daemon";
const root = mkdtempSync(join(import.meta.dir, "../../node_modules/.extension-context-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const invocation = { context: "scout.extension-context/v1" as const, requires: ["selection/v1", "web.selection/v1", "distribution.endpoint/v1", "pair.configuration/v1", "runtime.tools/v1", "menu.bootstrap/v1", "server.configuration/v1"] as const };
const provider = `#!${process.execPath}
import { createReadStream, fstatSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const chunks=[];
if(process.env.SCOUT_EXTENSION_API==='2') {
 for await(const part of createReadStream(null,{fd:5,autoClose:true,highWaterMark:7})) chunks.push(part);
 const bytes=Buffer.concat(chunks); const wire=bytes.toString('utf8');
 if(bytes.length>65536||!wire.endsWith('\\n')||wire.trim().split('\\n').length!==1) process.exit(90);
 const frame=JSON.parse(wire);
 if(frame.schema!=='scout.extension-context/v1'||frame.api!==2||!frame.features.includes('selection/v1')) process.exit(91);
 if(process.argv.includes('fail'))process.exit(23);
 const input=[];for await(const part of process.stdin)input.push(part);
 const child=spawn('/bin/sh',['-c','if test -r /dev/fd/5; then echo inherited; else echo closed; fi'],{stdio:['ignore','pipe','ignore']});
 let descendant='';for await(const part of child.stdout)descendant+=part;
 console.log(JSON.stringify({frame,stdin:Buffer.concat(input).toString('base64'),argv:process.argv.slice(2),cwd:process.cwd(),descendant:descendant.trim(),api:process.env.SCOUT_EXTENSION_API}));
} else {
 const descriptors=[];for(let fd=3;fd<=7;fd++){try{let s=fstatSync(fd);descriptors.push([fd,s.isFIFO(),s.isSocket(),s.isFile()]);}catch{descriptors.push([fd,'closed']);}}
 console.log(JSON.stringify({env:Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(SCOUT_|OPENSCOUT_|SYNTHETIC_)/.test(k))),descriptors,argv:process.argv.slice(2),cwd:process.cwd()}));
}
`;
let counter = 0;
function fixture(api = 2, extra: Record<string, unknown> = {}) {
 const base = join(root, `f${++counter}`), source = join(base, "artifact"), home = join(base, "home"), extensions = join(base, "extensions");
 mkdirSync(source, { recursive: true }); mkdirSync(home);
 writeFileSync(join(source, "extension.json"), JSON.stringify({ api, command: "run", summary: "Context fixture", version: "9.8.7", ...(api===2?{invocation}:{}), ...extra }));
 writeFileSync(join(source, "run"), provider, { mode: 0o700 });
 const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, SCOUT_HOME: join(home, "scout"), OPENSCOUT_HOME: join(home, "legacy"), OPENSCOUT_EXTENSIONS_HOME: extensions, OPENSCOUT_INSTANCE: "prod", FORCE_COLOR: "3", SCOUT_CONTEXT_SECRET: "synthetic-secret-do-not-project", OPENSCOUT_PUSH_RELAY_SESSION: "synthetic-push-secret", SYNTHETIC_NORMAL: "passed", OPENSCOUT_WEB_CLIENT_PROFILE: "basic", SYNTHETIC_MAINTENANCE_FILE: join(base,"maintenance") };
 return { base, source, home, extensions, env };
}
const main = join(import.meta.dir, "main.ts");
const preload = join(root,"preload.ts");
writeFileSync(preload, `import {mock} from "bun:test";import {SCOUT_COMMANDS} from ${JSON.stringify(join(import.meta.dir,"registry.ts"))};
SCOUT_COMMANDS.push({name:"context-fixture",summary:"Context test",provider:"extension"});
mock.module(${JSON.stringify(join(import.meta.dir,"broker-update.ts"))},()=>({brokerUpdateDebugEnabled:()=>false,ensureBrokerUptodate:async()=>{if(process.env.SYNTHETIC_MAINTENANCE_FILE) (await import("node:fs")).appendFileSync(process.env.SYNTHETIC_MAINTENANCE_FILE,"maintenance\\n");}}));`);
async function cli(f: ReturnType<typeof fixture>, args: string[], input = Buffer.alloc(0), entry = main) {
 const child=spawn(process.execPath,["--preload",preload,entry,...args],{env:f.env,cwd:f.base,stdio:["pipe","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);child.stdin.on("error",()=>{});child.stdin.end(input);
 const timer=setTimeout(()=>child.kill("SIGKILL"),20_000);
 try { const code=await new Promise<number|null>((done,reject)=>{child.once("error",reject);child.once("close",done);});return {code,stdout,stderr}; }
 finally {clearTimeout(timer);}
}
async function installed(f: ReturnType<typeof fixture>) {const result=await cli(f,["--json","extensions","install","context-fixture",f.source]);expect(result.code).toBe(0);return JSON.parse(result.stdout);}
function pure(f = fixture()) {
 const env={...f.env}, layout=deriveOpenScoutInstanceLayout({env,home:f.home,name:"prod",hostname:"fixture"});
 const selection=captureScoutExtensionSelection({layout,env,home:f.home,uid:process.getuid!(),cwd:f.base});
 const input={selection,extension:{name:"context-fixture",selectedRoot:f.extensions,readRoots:[f.extensions],artifact:join(f.extensions,"generation"),version:"9.8.7",treeDigest:"sha256:scout-extension-tree-v1:"+"a".repeat(64)},invocation:{context:invocation.context,requires:[...invocation.requires]},cli:{version:"1.2.3",executable:main,runtimeExecutable:process.execPath,output:"json" as const,cwd:f.base},brokerUrl:"http://127.0.0.1:43110"};
 return {f,env,input};
}
function typed(result:{code:number|null;stdout:string;stderr:string},reason:string) {expect(result.code).toBe(69);expect(result.stdout).toBe("");expect(result.stderr).not.toContain("\x1b");expect(JSON.parse(result.stderr)).toMatchObject({schema:"scout.cli.command-unavailable/v1",error:"command_unavailable",reason});}

test("pure projection freezes two-user roots, aliases, client selection and finite secret-free fields",()=>{
 for(const uid of [1001,1002]) {
  const {f,env,input}=pure(); env.SCOUT_HOME="relative/scout";env.OPENSCOUT_SCOUT_HOME="relative/runtime-scout";env.OPENSCOUT_CONTROL_HOME="relative/control";env.SCOUT_PAIRING_HOME="relative/pairing";env.OPENSCOUT_SETUP_CWD="relative/setup";
  env.OPENSCOUT_DIST_URL="https://downloads.example.test/prefix/";env.OPENSCOUT_BROKER_INTERNAL_URL="http://127.0.0.1:43111";
  const selection=captureScoutExtensionSelection({...input.selection,env,uid});expect(JSON.stringify(selection)).not.toContain("synthetic-secret");expect(JSON.stringify(selection)).not.toContain("synthetic-push");
  env.OPENSCOUT_CLIENT_INSTANCE="another-instance";env.SCOUT_HOME="another-home";env.OPENSCOUT_DIST_URL="https://changed.example.test";
  const before=readdirSync(f.home);const frame=projectScoutExtensionContext({...input,selection});
  expect(frame.selection.uid).toBe(uid);expect(frame.selection.instance).toBe("prod");expect(frame.paths.scoutHome).toBe(resolve(f.base,"relative/scout"));
  expect(frame.paths.runtimeScoutHome).toBe(resolve(f.base,"relative/runtime-scout"));expect(frame.paths.controlPlaneDb).toBe(resolve(f.base,"relative/control/control-plane.sqlite"));expect(frame.paths.pairingHome).toBe(resolve(f.base,"relative/pairing"));
  expect(frame.paths.setupCwd).toBe(resolve(f.base,"relative/setup"));expect(frame.cli.version).toBe("1.2.3");expect(frame.extensions.version).toBe("9.8.7");
  expect(frame.broker.controlUrl).not.toBe(frame.broker.internalUrl);expect(frame.configuration["distribution.endpoint/v1"]!.endpoint!.value).toBe("https://downloads.example.test/prefix/");
  const wire=encodeScoutExtensionContext(frame).toString();expect(wire).not.toContain("synthetic-secret");expect(wire).not.toContain("synthetic-push");expect(wire).not.toContain("SCOUT_CONTEXT_SECRET");expect(frame.credentialInputs).toEqual([]);expect(readdirSync(f.home)).toEqual(before);
 }
});
test("projection uses post-fence non-prod layout without claiming another slot or recovering removed inputs",()=>{
 const f=fixture();const env:NodeJS.ProcessEnv={...f.env,OPENSCOUT_CLIENT_INSTANCE:"context-dev",OPENSCOUT_INSTANCE_ROOT:join(f.base,"relocated"),OPENSCOUT_INSTANCE_PORT_BASE:"25200",OPENSCOUT_PAIRING_RELAY_URL:"https://must-be-fenced.test"};delete env.OPENSCOUT_INSTANCE;
 selectCliOpenScoutInstance(env);const {layout}=applyOpenScoutInstanceEnvironment(env,{home:f.home,hostname:"fixture"});
 const {input}=pure(f);const selection=captureScoutExtensionSelection({layout,env,home:f.home,uid:process.getuid!(),cwd:f.base});
 const before=JSON.stringify(env);const frame=projectScoutExtensionContext({...input,selection,brokerUrl:`http://127.0.0.1:${layout.ports.broker}`});
 expect(frame.selection.instance).toBe("context-dev");expect(frame.selection.instanceRoot).toBe(layout.root);expect(frame.selection.meshAllowed).toBe(false);
 expect(frame.paths.pairingHome).toBe(resolveOpenScoutPairingHomeForEnv(env));expect(frame.paths.openScoutHome).toBe(resolveOpenScoutHomeForEnv(env));expect(frame.paths.scoutHome).toBe(resolveScoutHome({env}));
 expect(frame.configuration["pair.configuration/v1"]!.relayUrl!.present).toBe(false);expect(frame.configuration["pair.configuration/v1"]!.discovery!.value).toBe("0");expect(JSON.stringify(env)).toBe(before);
});
test("unknown required features, unsafe URLs, identity inconsistencies and control-bearing fields refuse without values",()=>{
 for(const value of ["https://user:synthetic-secret@example.test","https://example.test/?token=synthetic-secret","https://example.test/#synthetic-secret","file:///tmp/secret"]){
  const {input}=pure();input.selection.values.OPENSCOUT_DIST_URL=value;
  expect(()=>projectScoutExtensionContext(input)).toThrow("context_invalid");
  expect(()=>projectScoutExtensionContext({...input,brokerUrl:value})).toThrow("context_invalid");
 }
 for(const mutation of ["uid","cwd","feature","control"]){const {input}=pure();if(mutation==="uid")input.selection.uid=-1;if(mutation==="cwd")input.cli.cwd="/different";if(mutation==="feature")input.invocation.requires.push("unknown/v1" as never);if(mutation==="control")input.selection.values.OPENSCOUT_SETUP_CWD="bad\npath";expect(()=>projectScoutExtensionContext(input)).toThrow("context_invalid");}
});
test("context framing accepts exactly 64 KiB and refuses one byte more",()=>{
 const {input}=pure();const frame=projectScoutExtensionContext(input);const initial=encodeScoutExtensionContext(frame);expect(initial.at(-1)).toBe(10);expect(initial.toString().split("\n")).toHaveLength(2);expect(JSON.parse(initial.toString()).schema).toBe("scout.extension-context/v1");expect(frame.api).toBe(2);const empty=initial.length;
 frame.cli.version+="x".repeat(EXTENSION_CONTEXT_MAX_BYTES-empty);expect(encodeScoutExtensionContext(frame).length).toBe(EXTENSION_CONTEXT_MAX_BYTES);frame.cli.version+="x";expect(()=>encodeScoutExtensionContext(frame)).toThrow("context_invalid");
});
test("mapping takes registry context only and never maps credentials or worker authority",()=>{
 const stdio=scoutExtensionContextStdio(33);expect(stdio).toHaveLength(MAX_INHERITED_DESCRIPTOR_SLOT+1);
 expect(stdio[INHERITED_DESCRIPTOR_LAYOUTS.extensionApi2.context]).toBe(33);expect(stdio[INHERITED_DESCRIPTOR_LAYOUTS.extensionApi2.credential]).toBe("ignore");
 for(const slot of Object.values(INHERITED_DESCRIPTOR_LAYOUTS.roleCustody))expect(stdio[slot]).toBe("ignore");expect(stdio.slice(0,3)).toEqual(["inherit","inherit","inherit"]);
});
test("delivery adapter handles partial/backpressured writes and closes once for EOF",async()=>{
 const bytes:number[]=[];let closes=0,calls=0;
 const endpoint=new BoundedChannelDescriptor(99,{read(){return -1;},write(_fd,part){if(++calls===1)return -1;const n=Math.min(7,part.length);bytes.push(...part.subarray(0,n));return n;},close(){closes++;return 0;}});
 await endpoint.write(Buffer.from('{"schema":"test"}\n'),{timeoutMs:5000});endpoint.close();endpoint.close();
 expect(Buffer.from(bytes).toString()).toBe('{"schema":"test"}\n');expect(closes).toBe(1);expect(endpoint.stats.writeWouldBlock).toBe(1);
});
test("delivery adapter timeout, native error and cancellation terminate once",async()=>{
 for(const mode of ["timeout","error","exit"]){let closes=0;const abort=new AbortController();const endpoint=new BoundedChannelDescriptor(99,{read(){return -1;},write(){return mode==="error"?-132:-1;},close(){closes++;return 0;}});
 const pending=endpoint.write(Buffer.from("{}\n"),{timeoutMs:10,signal:abort.signal});if(mode==="exit")abort.abort();await expect(pending).rejects.toThrow(/extension_channel_/);endpoint.close();expect(closes).toBe(1);}
});

test("public API2 install, binary stdin, argv, context EOF, cwd, output and descendant closure",async()=>{
 const f=fixture();const receipt=await installed(f);
 if(!scoutExtensionContextBackend()){typed(await cli(f,["--json","context-fixture"]),"context_backend_unproven");expect(existsSync(f.env.SYNTHETIC_MAINTENANCE_FILE!)).toBe(false);return;}const data=Buffer.from([0,255,1,10,13,128,33]);const result=await cli(f,["--json","context-fixture","login","--key","-"],data);expect(result.code).toBe(0);expect(result.stderr).toBe("");expect(existsSync(f.env.SYNTHETIC_MAINTENANCE_FILE!)).toBe(false);
 const value=JSON.parse(result.stdout);expect(value.stdin).toBe(data.toString("base64"));expect(value.argv).toEqual(["login","--key","-"]);expect(value.cwd).toBe(f.base);expect(value.descendant).toBe("closed");
 expect(value.frame.extensions.treeDigest).toBe(receipt.treeDigest);expect(value.frame.extensions.treeDigest).not.toBe(receipt.digest);expect(value.frame.extensions.artifact).toBe(receipt.publishedGeneration);
 expect(value.frame.cli.output).toBe("json");expect(value.frame.extensions.version).toBe("9.8.7");expect(value.api).toBe("2");expect(result.stdout).not.toContain("synthetic-secret");expect(result.stdout).not.toContain("synthetic-push");
 const failure=await cli(f,["--json","context-fixture","fail"]);expect(failure.code).toBe(23);expect(failure.stdout).toBe("");expect(failure.stderr).toBe("");
 const help=await cli(f,["context-fixture","--help"]);expect(help.code).toBe(0);expect(JSON.parse(help.stdout).frame.credentialInputs).toEqual([]);
 const staticHelp=await cli(f,["--json","context-fixture","--help"]);expect(staticHelp.code).toBe(0);expect(JSON.parse(staticHelp.stdout).frame).toBeUndefined();expect(JSON.parse(staticHelp.stdout).provider).toBe("extension");
},30_000);
test("API2 declaration and schema negotiations refuse at install and dispatch before execution",async()=>{
 for(const extra of [{api:99},{invocation:{...invocation,context:"unknown/v1"}},{invocation:{...invocation,requires:["unknown/v1"]}},{invocation:{...invocation,credentialInputs:[{id:"anything"}]}},{complete:"run"},{invocation:{...invocation,extra:true}}]) {
  const f=fixture(2,extra);const install=await cli(f,["--json","extensions","install","context-fixture",f.source]);expect(install.code).toBe(1);
  mkdirSync(f.extensions,{recursive:true});const receipt=mutateScoutExtension("install","context-fixture",fixture().source,f.env);writeFileSync(join(receipt.publishedGeneration,"extension.json"),readFileSync(join(f.source,"extension.json")));
  const result=await cli(f,["--json","context-fixture"]);typed(result,"incompatible");expect(result.stderr).not.toContain("synthetic-secret");
 }
},30_000);
test("dispatch revalidates auxiliary bytes, declarations, generation, removal and root before spawn",async()=>{
 for(const mutation of ["auxiliary","declaration","update","remove","root"]){
  const f=fixture();const receipt=mutateScoutExtension("install","context-fixture",f.source,f.env);const extension=findScoutExtension("context-fixture",f.env)!;const {input}=pure(f);
  const frame=prepareScoutExtensionContext({extension,env:f.env,selection:input.selection,cli:input.cli,brokerUrl:input.brokerUrl});
  if(mutation==="auxiliary")writeFileSync(join(receipt.publishedGeneration,"new-asset"),"changed");
  if(mutation==="declaration")writeFileSync(join(receipt.publishedGeneration,"extension.json"),JSON.stringify({api:2,version:"9.8.7",command:"run",invocation:{...invocation,requires:["selection/v1"]}}));
  if(mutation==="update")mutateScoutExtension("update","context-fixture",f.source,f.env);if(mutation==="remove")mutateScoutExtension("remove","context-fixture",undefined,f.env);if(mutation==="root")f.env.OPENSCOUT_EXTENSIONS_HOME=join(f.base,"other");
  await expect(runScoutExtensionWithContext(extension,[],scoutExtensionEnv({env:f.env,extension,cliVersion:"1",outputMode:"json",brokerUrl:input.brokerUrl}),frame,f.env)).rejects.toThrow("selection_changed");
 }
});

test("API1 filtered environment and descriptor ABI equal the prior inherit-only runner",async()=>{
 const f=fixture(1);await installed(f);const extension=findScoutExtension("context-fixture",f.env)!;
 const expected={...Object.fromEntries(Object.entries(f.env).filter(([key])=>!/^(OPENSCOUT|SCOUT)_/.test(key)||["SCOUT_HOME","OPENSCOUT_HOME"].includes(key))),PATH:[join(process.execPath,".."),f.env.PATH].filter(Boolean).join(":"),SCOUT_EXTENSION_API:"1",SCOUT_EXTENSION_NAME:"context-fixture",SCOUT_CLI_VERSION:SCOUT_APP_VERSION,SCOUT_OUTPUT:"json",OPENSCOUT_BROKER_URL:"http://127.0.0.1:43110"};
 const projected=scoutExtensionEnv({env:f.env,extension,cliVersion:SCOUT_APP_VERSION,outputMode:"json",brokerUrl:"http://127.0.0.1:43110"});expect(projected).toEqual(expected);
 const oldRunner=join(f.base,"old-runner.ts");
 writeFileSync(oldRunner,`import {spawn} from "node:child_process";const child=spawn(${JSON.stringify(extension.command)},['unchanged'],{env:process.env,stdio:'inherit'});child.once('exit',code=>process.exitCode=code??1);`);
 const baseline=await new Promise<{code:number|null;stdout:string}>((done,reject)=>{const child=spawn(process.execPath,[oldRunner],{env:expected,cwd:f.base,stdio:["ignore","pipe","pipe"]});let stdout="";child.stdout.on("data",chunk=>stdout+=chunk);child.once("error",reject);child.once("close",code=>done({code,stdout}));});
 const current=await cli(f,["--json","context-fixture","unchanged"]);expect(current.code).toBe(baseline.code);expect(JSON.parse(current.stdout)).toEqual(JSON.parse(baseline.stdout));
},30_000);
test("API2 real non-prod dispatch has selected relocated paths and refuses unsafe URL before maintenance",async()=>{
 const f=fixture();f.env.OPENSCOUT_CLIENT_INSTANCE="ctx-real";delete f.env.OPENSCOUT_INSTANCE;f.env.OPENSCOUT_INSTANCE_ROOT=join(f.base,"instance");f.env.OPENSCOUT_INSTANCE_PORT_BASE="25300";
 const receipt=await installed(f);const result=await cli(f,["--json","context-fixture","inspect"]);if(!scoutExtensionContextBackend()){typed(result,"context_backend_unproven");return;}expect(result.code).toBe(0);const frame=JSON.parse(result.stdout).frame;
 expect(frame.selection.instance).toBe("ctx-real");expect(frame.selection.instanceRoot).toBe(join(f.base,"instance"));expect(frame.paths.openScoutHome).toBe(join(f.base,"instance"));expect(frame.services.ports.broker).toBe(25300);expect(frame.extensions.treeDigest).toBe(receipt.treeDigest);
 f.env.OPENSCOUT_DIST_URL="https://user:synthetic-secret@example.test/";const refused=await cli(f,["--json","context-fixture"]);typed(refused,"context_invalid");expect(refused.stderr).not.toContain("synthetic-secret");expect(existsSync(f.env.SYNTHETIC_MAINTENANCE_FILE!)).toBe(false);
},30_000);
test("API2 SIGTERM and SIGHUP reach only the foreground child and preserve its exit status",async()=>{
 if(!scoutExtensionContextBackend()){const f=fixture();await installed(f);typed(await cli(f,["--json","context-fixture"]),"context_backend_unproven");return;}
 for(const signal of ["SIGTERM","SIGHUP"] as const){
  const f=fixture();const ready=join(f.base,"ready"),stopped=join(f.base,"stopped");
  writeFileSync(join(f.source,"run"),`#!${process.execPath}\nimport{createReadStream,writeFileSync}from'node:fs';for await(const part of createReadStream(null,{fd:5,autoClose:true})){};process.on('${signal}',()=>{writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(19);});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);\n`);
  await installed(f);const child=spawn(process.execPath,["--preload",preload,main,"context-fixture"],{env:f.env,cwd:f.base,stdio:"ignore"});const closed=new Promise<number|null>(done=>child.once("close",done));
  const deadline=Date.now()+10_000;try {while(!existsSync(ready)&&Date.now()<deadline)await Bun.sleep(10);expect(existsSync(ready)).toBe(true);child.kill(signal);expect(await closed).toBe(19);expect(readFileSync(stopped,"utf8")).toBe("stopped");const pid=Number(readFileSync(ready,"utf8"));expect(()=>process.kill(pid,0)).toThrow();}
  finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;}
 }
},30_000);

test("nonrequested configuration stays absent and effective service ports reject invalid values",()=>{
 const {input}=pure();input.invocation.requires=["selection/v1"];const frame=projectScoutExtensionContext(input);expect(frame.configuration).toEqual({});
 expect(()=>projectScoutExtensionContext({...input,ports:{broker:0}})).toThrow("context_invalid");
 input.selection.values.OPENSCOUT_SERVICE_LABEL="selected.label";input.selection.values.OPENSCOUT_BROKER_SERVICE_LABEL="lower-priority.label";
 expect(projectScoutExtensionContext(input).services.label).toBe("selected.label");
 input.selection.values.OPENSCOUT_SYSTEMD_UNIT="custom";input.selection.values.OPENSCOUT_BROKER_SERVICE_MODE=" Production ";
 expect(projectScoutExtensionContext(input).services.systemdUnit).toBe("custom.service");expect(projectScoutExtensionContext(input).services.mode).toBe("prod");
 input.selection.values.OPENSCOUT_SYSTEMD_UNIT="custom.service";input.selection.values.OPENSCOUT_BROKER_SERVICE_MODE="CUSTOM";
 expect(projectScoutExtensionContext(input).services.systemdUnit).toBe("custom.service");expect(projectScoutExtensionContext(input).services.mode).toBe("custom");
 delete input.selection.values.OPENSCOUT_BROKER_SERVICE_MODE;expect(projectScoutExtensionContext(input).services.mode).toBeNull();
});
test("context failure cleanup sends TERM, escalates only a stubborn child, and reaps it",async()=>{
 for(const stubborn of [false,true]) {
  const f=fixture();const ready=join(f.base,"cleanup-ready"),term=join(f.base,"cleanup-term");
  const script=`const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},'term');${stubborn?"":"process.exit(19);"}});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,["-e",script],{env:f.env,cwd:f.base,stdio:"ignore"});const closed=new Promise<void>(done=>child.once("close",()=>done()));
  try {const deadline=Date.now()+5000;while(!existsSync(ready)&&Date.now()<deadline)await Bun.sleep(5);expect(existsSync(ready)).toBe(true);await Promise.race([stopScoutExtensionContextChild(child,closed), Bun.sleep(5000).then(()=>{throw Error("cleanup did not reap the child");})]);expect(existsSync(term)).toBe(true);expect(stubborn?child.signalCode:child.exitCode).toBe(stubborn?"SIGKILL":19);expect(()=>process.kill(child.pid!,0)).toThrow();}
  finally {if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;}
 }
},10_000);
test("spawn failure is a typed context refusal with empty stdout",async()=>{
 const f=fixture();writeFileSync(join(f.source,"run"),"#!/missing-context-interpreter\nexit 0\n");await installed(f);typed(await cli(f,["--json","context-fixture"]),scoutExtensionContextBackend()?"context_delivery_failed":"context_backend_unproven");
},10_000);

test("unqualified context backends refuse before descriptor creation",()=>{
 expect(scoutExtensionContextBackend()).toBe(false); // No revision/platform is qualified.
});

test("unqualified host emits the versioned backend refusal without starting a provider",async()=>{
 if(scoutExtensionContextBackend())return;const f=fixture();await installed(f);typed(await cli(f,["--json","context-fixture"]),"context_backend_unproven");
});

test("dormant context refuses eight invocations without creating an extra pipe",async()=>{
 const f=fixture();mutateScoutExtension("install","context-fixture",f.source,f.env);const extension=findScoutExtension("context-fixture",f.env)!;const {input}=pure(f);
 const frame=prepareScoutExtensionContext({extension,env:f.env,selection:input.selection,cli:input.cli,brokerUrl:input.brokerUrl});
 expect(scoutExtensionContextBackend()).toBe(false);
 try{releaseExtensionChannelCodeForWitness(()=>{});}catch(error){expect(String(error)).toContain("no extension channel code loaded");}
 const raw=Bun.spawn;let spawns=0;Bun.spawn=((...args:unknown[])=>{spawns++;return Reflect.apply(raw,Bun,args);}) as typeof Bun.spawn;
 try{for(let i=0;i<8;i++)await expect(runScoutExtensionWithContext(extension,["fail"],scoutExtensionEnv({env:f.env,extension,cliVersion:"1",outputMode:"json",brokerUrl:input.brokerUrl}),frame,f.env)).rejects.toThrow("context_backend_unproven");}
 finally{Bun.spawn=raw;}
 expect(spawns).toBe(0);expect(()=>releaseExtensionChannelCodeForWitness(()=>{})).toThrow("no extension channel code loaded");
});
test("independent credential guard refuses before native load/allocation or provider spawn",async()=>{
 const f=fixture();mutateScoutExtension("install","context-fixture",f.source,f.env);const extension=findScoutExtension("context-fixture",f.env)!;const {input}=pure(f);
 const frame=prepareScoutExtensionContext({extension,env:f.env,selection:input.selection,cli:input.cli,brokerUrl:input.brokerUrl});
 try{releaseExtensionChannelCodeForWitness(()=>{});}catch(error){expect(String(error)).toContain("no extension channel code loaded");}
 extension.invocation={...extension.invocation!,credentialInputs:[{id:"distribution-key"}] as never};
 const raw=Bun.spawn;let spawns=0;Bun.spawn=((...args:unknown[])=>{spawns++;return Reflect.apply(raw,Bun,args);}) as typeof Bun.spawn;
 try{await expect(runScoutExtensionWithQualifiedContext(extension,[],f.env,frame,f.env)).rejects.toThrow("input_backend_unproven");}
 finally{Bun.spawn=raw;}
 expect(spawns).toBe(0);expect(()=>releaseExtensionChannelCodeForWitness(()=>{})).toThrow("no extension channel code loaded");
});
// Candidate apparatus only: exercise real numeric channels AFTER context work,
// without reopening the product gate or treating this run as qualification.
const numericCandidateTest = Bun.revision === "0d9b296af33f2b851fcbf4df3e9ec89751734ba4" && ["darwin", "linux"].includes(process.platform) ? test : test.skip;
numericCandidateTest("after-context numeric candidate: both registry forms survive reclaim and GC", async () => {
 for (const form of ["context", "credential"] as const) {
  const events: Record<string, unknown>[] = [];
  await numericWitness(form, event => events.push(event));
  expect(events.filter(event => event.event === "native-collected")).toHaveLength(9);
  expect(events.filter(event => event.event === "collection-observed")).toHaveLength(1);
 }
}, 30_000);
const asyncCandidateTest = Bun.revision === "0d9b296af33f2b851fcbf4df3e9ec89751734ba4" && (process.platform === "darwin" && process.arch === "arm64" || process.platform === "linux" && process.arch === "x64") ? test : test.skip;
asyncCandidateTest("after-context production async candidate: both registry forms pass the whole witness", async () => {
 for (const form of ["context", "credential"] as const) {
  const events: Record<string, unknown>[] = [];
  await numericWitness(form, event => events.push(event), undefined, {io: "async"});
  expect(events.filter(event => event.event === "native-collected")).toHaveLength(9);
  expect(events.filter(event => event.event === "async-io")).toHaveLength(9);
 }
}, 30_000);
// This MUST follow the context tests in the same process. Fresh files can reclaim numbers
// released by earlier tests; a bystander opened before those tests cannot see a stale close.
test("after-context sentinel keeps fresh descriptor identities through repeated GC",async()=>{
 const directory=join(root,"after-context-reclaim");mkdirSync(directory);
 await checkReclaimedDescriptors({former:[],directory});
});
