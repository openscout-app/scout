/** Actual source mutation controls, each paired with its healthy fixture. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statfsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const project=fileURLToPath(new URL("..",import.meta.url)),explicit=process.argv[2];
const output=explicit??mkdtempSync(join(tmpdir(),"pairing-quiescent-controls-"));mkdirSync(output,{recursive:true});
const owner=readFileSync(join(project,"packages/runtime/src/pairing-security/trust-owner.ts"),"utf8");
const engine=readFileSync(join(project,"packages/runtime/src/pairing-security/trust-reclamation.ts"),"utf8");
const guards='if (adapter?.currentHolder(observed) || [...liveInvocations].some(i => i.active && i.root.fs === observed.fs)) refuse("reclamation_holder_active");';
const tokenCheck='if(!c || !hooks.rootIs(c.rootId) || !integer(c.index,0,7) || !token(c.token) || !identityFormat(c.identity)\n    || (dir && !hooks.objectIs(c.identity,dir))\n    || !same(c,{rootId:c.rootId,index:c.index,token:c.token,identity:c.identity}))fail("reclamation_token_invalid");';
const reference='if(a.tokens.has(g.claim.token)||a.references.has(g.source)||payloads(g.claim.token).some(n=>a.references.has(n)))fail("reclamation_referenced");';
const controls=[
 {id:"parent-store-predicate",subject:"engine",test:"a group-writable parent",needle:'const parent=openSync(dirname(root.path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);\n   try{fsyncSync(parent);}finally{closeSync(parent);}',replacement:'const parent=pin(dirname(root.path));try{sync(parent);}finally{closeSync(parent.fd);}'},
 {id:"delete-instead-of-move",subject:"engine",test:"healthy move-only receipt",needle:'renameSync(join(root.path,p.source),join(op.path,p.source));',replacement:'require("node:fs").rmSync(join(root.path,p.source),{recursive:true,force:true});'},
 {id:"skip-full-token-verification",subject:"engine",test:"complete token record is verified",needle:tokenCheck,replacement:'if(false)fail("reclamation_token_invalid");'},
 {id:"skip-holder-preflight",subject:"owner",test:"observable holder refuses",needle:guards,replacement:'if(false)refuse("reclamation_holder_active");'},
 {id:"move-referenced-resource",subject:"engine",test:"a referenced retained chunk",needle:reference,replacement:'if(false)fail("reclamation_referenced");'},
 {id:"omit-evidence-directory-sync",subject:"engine",test:"healthy move-only receipt",needle:'const sync=(p:Pin)=>{check(p);fsyncSync(p.fd);check(p);};',replacement:'const sync=(p:Pin)=>{if(p.path.includes("/op."))return;check(p);fsyncSync(p.fd);check(p);};'},
];
const url=(p:string)=>pathToFileURL(join(project,p)).href,results=[];
try{
 for(const c of controls){
  const disk=statfsSync(process.platform==="darwin"?"/System/Volumes/Data":"/");if(disk.bavail*disk.bsize<3*1024**3)throw Error("3 GiB disk floor");
  const raw=c.subject==="owner"?owner:engine;if(raw.split(c.needle).length!==2)throw Error("nonunique control "+c.id);
  const scratch=mkdtempSync(join(tmpdir(),"pairing-quiescent-control-")),hashes:Record<string,object>={};
  try{
   for(const kind of ["healthy","bypass"]){
    const altered=kind==="bypass"?raw.replace(c.needle,c.replacement):raw;
    let own=c.subject==="owner"?altered:owner,helper=c.subject==="engine"?altered:engine;
    const subject=join(scratch,kind+"-owner.ts"),enginePath=join(scratch,kind+"-engine.ts"),worker=join(scratch,kind+"-worker.ts"),test=join(scratch,kind+".test.ts");
    hashes[kind]={owner:createHash("sha256").update(own).digest("hex"),engine:createHash("sha256").update(helper).digest("hex")};
    for(const [from,to]of [["../support-paths.js","packages/runtime/src/support-paths.ts"],["./trust-capsule.js","packages/runtime/src/pairing-security/trust-capsule.ts"],["./trust-cutover.js","packages/runtime/src/pairing-security/trust-cutover.ts"]])own=own.replaceAll(JSON.stringify(from),JSON.stringify(url(to!)));
    own=own.replaceAll('"./trust-reclamation.js"',JSON.stringify(pathToFileURL(enginePath).href));
    helper=helper.replaceAll('"./trust-capsule.js"',JSON.stringify(url("packages/runtime/src/pairing-security/trust-capsule.ts")));
    writeFileSync(subject,own);writeFileSync(enginePath,helper);
    writeFileSync(worker,readFileSync(join(project,"scripts/pairing-quiescent-reclamation-worker.ts"),"utf8").replace('"../packages/runtime/src/pairing-security/trust-owner.ts"',JSON.stringify(subject)));
    let unit=readFileSync(join(project,"scripts/pairing-quiescent-reclamation-process.test.ts"),"utf8")
      .replace('"../packages/runtime/src/pairing-security/trust-owner.ts"',JSON.stringify(subject))
      .replaceAll('"./fixtures/pairing-capsule.ts"',JSON.stringify(url("scripts/fixtures/pairing-capsule.ts")))
      .replace('"../packages/runtime/src/pairing-security/trust-capsule.ts"',JSON.stringify(url("packages/runtime/src/pairing-security/trust-capsule.ts")))
      .replace('"./pairing-quiescent-reclamation-worker.ts"',JSON.stringify(pathToFileURL(worker).href))
      .replaceAll('"./pairing-slot-reclamation-worker.ts"',JSON.stringify(url("scripts/pairing-slot-reclamation-worker.ts")))
      .replace('"./pairing-cutover-worker.ts"',JSON.stringify(url("scripts/pairing-cutover-worker.ts")));
    writeFileSync(test,unit);
    const child=Bun.spawn([process.execPath,"test",test,"--test-name-pattern",c.test],{stdout:"pipe",stderr:"pipe"});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const log=out+err;writeFileSync(join(output,`${c.id}-${kind}.log`),log);
    if(kind==="healthy"?exit!==0:!(exit!==0&&log.includes("(fail)")&&log.includes(c.test)&&!(/Cannot find module|ParseError|SyntaxError|timed out|fixture coordination/.test(log))))throw Error(`${c.id}/${kind}: invalid evidence in ${output}`);
   }
   results.push({id:c.id,caught:true,hashes});
  }finally{rmSync(scratch,{recursive:true,force:true});}
 }
 const result={bun:Bun.version,controls:results};writeFileSync(join(output,"results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(!explicit)rmSync(output,{recursive:true,force:true});}
