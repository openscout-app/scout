/** Healthy/broken source pairs; no git history or production injection needed. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statfsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const root=fileURLToPath(new URL("..",import.meta.url)),explicit=process.argv[2];
const output=explicit??mkdtempSync(join(tmpdir(),"pairing-reclamation-controls-"));mkdirSync(output,{recursive:true});
const original=readFileSync(join(root,"packages/runtime/src/pairing-security/trust-owner.ts"),"utf8");
const rename='try {renameSync(source,join(root.path,slotName(index)));}';
const controls=[
 {id:"linux-rename-errno",test:"both platform nonempty-rename errnos",needle:'["ENOTEMPTY","EEXIST"].includes((e as NodeJS.ErrnoException).code??"")',replacement:'["ENOTEMPTY"].includes((e as NodeJS.ErrnoException).code??"")'},
 {id:"no-empty-reclamation",test:"abandoned empty slots are reclaimed",needle:rename,replacement:'try {if(existsSync(join(root.path,slotName(index))))continue;renameSync(source,join(root.path,slotName(index)));}'},
 {id:"unsafe-live-replacement",test:"eight live token-bearing claims refuse",needle:rename,replacement:'try {const target=join(root.path,slotName(index));if(existsSync(target)){for(const child of readdirSync(target))unlinkSync(join(target,child));rmdirSync(target);}renameSync(source,target);}'},
 {id:"candidate-dir-sync-omitted",test:"candidate claim durability",needle:'fsyncSync(fd);this.syncDirectory(root);',replacement:'this.syncDirectory(root);'},
 {id:"direct-slot-mkdir",test:"candidate claim durability",needle:'const candidate=`.pairing-claim-${randomUUID()}`,source=join(root.path,candidate);',replacement:'try{mkdirSync(join(root.path,slotName(index)),{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;} const candidate=`.pairing-claim-${randomUUID()}`,source=join(root.path,candidate);'},
];
const url=(path:string)=>pathToFileURL(join(root,path)).href,results=[];
try{
 for(const control of controls){
  const disk=statfsSync(process.platform==="darwin"?"/System/Volumes/Data":"/");if(disk.bavail*disk.bsize<3*1024**3)throw Error("3 GiB disk floor");
  if(original.split(control.needle).length!==2)throw Error(`nonunique anchor ${control.id}`);
  const scratch=mkdtempSync(join(tmpdir(),"pairing-reclamation-control-")),hashes:Record<string,string>={};
  try{
   for(const [kind,raw] of [["healthy",original],["bypass",original.replace(control.needle,control.replacement)]]){
    const subject=join(scratch,`${kind}.ts`),worker=join(scratch,`${kind}-worker.ts`),test=join(scratch,`${kind}.test.ts`);
    let source=raw!;
    for(const [from,to] of [["../node-identity.js","packages/runtime/src/node-identity.ts"],["../instance.js","packages/runtime/src/instance.ts"],["./host-binding.js","packages/runtime/src/pairing-security/host-binding.ts"],["../support-paths.js","packages/runtime/src/support-paths.ts"],["./trust-capsule.js","packages/runtime/src/pairing-security/trust-capsule.ts"],["./trust-cutover.js","packages/runtime/src/pairing-security/trust-cutover.ts"],["./trust-reclamation.js","packages/runtime/src/pairing-security/trust-reclamation.ts"]])source=source.replaceAll(JSON.stringify(from),JSON.stringify(url(to!)));
    writeFileSync(subject,source);hashes[kind!]=createHash("sha256").update(raw!).digest("hex");
    writeFileSync(worker,readFileSync(join(root,"scripts/pairing-slot-reclamation-worker.ts"),"utf8").replace('"../packages/runtime/src/pairing-security/trust-owner.ts"',JSON.stringify(subject)));
    writeFileSync(test,readFileSync(join(root,"scripts/pairing-slot-reclamation-process.test.ts"),"utf8")
     .replace('"../packages/runtime/src/pairing-security/trust-owner.ts"',JSON.stringify(subject))
     .replace('"./fixtures/pairing-capsule.ts"',JSON.stringify(url("scripts/fixtures/pairing-capsule.ts")))
     .replace('"./pairing-slot-reclamation-worker.ts"',JSON.stringify(pathToFileURL(worker).href)));
    const child=Bun.spawn([process.execPath,"test",test,"--test-name-pattern",control.test],{stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const log=stdout+stderr;writeFileSync(join(output,`${control.id}-${kind}.log`),log);
    if(kind==="healthy"?exit!==0:!(exit!==0 && log.includes("(fail)") && log.includes(control.test) && !/Cannot find module|fixture pause not reached|timed out/.test(log)))throw Error(`${control.id}:${kind}: invalid control evidence in ${output}`);
   }
   results.push({id:control.id,caught:true,hashes});
  }finally{rmSync(scratch,{recursive:true,force:true});}
 }
 const result={bun:Bun.version,controls:results};writeFileSync(join(output,"results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(!explicit)rmSync(output,{recursive:true,force:true});}
