/** Source controls for inode reuse. Tests run separately to isolate fs mocks. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statfsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const root=fileURLToPath(new URL("..",import.meta.url));
const output=process.argv[2]??mkdtempSync(join(tmpdir(),"pairing-slot-controls-"));mkdirSync(output,{recursive:true});
const original=readFileSync(join(root,"packages/runtime/src/pairing-security/trust-owner.ts"),"utf8");
const tests=readFileSync(join(root,"scripts/pairing-slot-identity.test.ts"),"utf8");
const controls=[
  {id:"head-inode-only",test:"reused inode is not the previous head's token",needle:'const ownSlotExists=!!(h.slot && same(slots.claims.get(h.slot.token),h.slot));',replacement:'const ownSlotExists=!!(h.slot && names.includes(slotName(h.slot.index)) && id(lstatSync(join(root.path,slotName(h.slot.index))))===h.slot.identity);'},
  {id:"release-inode-only",test:"stale release never removes an empty or initialized newer claim",needle:'if(!bytes)return false; // Includes a newer mkdir before its token write.',replacement:'if(!bytes)return true; // Planted inode-only ownership bypass.'},
  {id:"release-without-pin",test:"release pins the directory until after token unlink and rmdir",needle:'if(!this.slotMatches(root,slot,fd))return;',replacement:'if(!this.slotMatches(root,slot,fd))return; closeSync(fd); fd=openSync(root.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);'},
];
const results=[];
try{
  for(const control of controls){
    const disk=statfsSync(process.platform==="darwin"?"/System/Volumes/Data":"/");if(disk.bavail*disk.bsize<3*1024**3)throw Error("3 GiB disk floor");
    if(original.split(control.needle).length!==2)throw Error(`nonunique anchor: ${control.id}`);
    const scratch=mkdtempSync(join(tmpdir(),"pairing-slot-control-"));
    try{
      for(const [kind,source] of [["healthy",original],["bypass",original.replace(control.needle,control.replacement)]]){
        const module=join(scratch,`${kind}.ts`),file=join(scratch,`${kind}.test.ts`);
        writeFileSync(module,source!.replaceAll('"../node-identity.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/node-identity.ts")).href))
      .replaceAll('"../instance.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/instance.ts")).href))
      .replaceAll('"./host-binding.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/host-binding.ts")).href))
      .replace('"../support-paths.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/support-paths.ts")).href))
          .replace('"./trust-capsule.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-capsule.ts")).href))
          .replace('"./trust-cutover.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-cutover.ts")).href))
          .replaceAll('"./trust-reclamation.js"',JSON.stringify(pathToFileURL(join(root,"packages/runtime/src/pairing-security/trust-reclamation.ts")).href)));
        writeFileSync(file,tests.replace('"../packages/runtime/src/pairing-security/trust-owner.ts"',JSON.stringify(module))
          .replace('"./fixtures/pairing-capsule.ts"',JSON.stringify(pathToFileURL(join(root,"scripts/fixtures/pairing-capsule.ts")).href)));
        const child=Bun.spawn([process.execPath,"test",file,"--test-name-pattern",control.test],{stdout:"pipe",stderr:"pipe"});
        const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        const log=stdout+stderr;writeFileSync(join(output,`${control.id}-${kind}.log`),log);
        if(kind==="healthy"?exit!==0:!(exit!==0 && log.includes("(fail)") && log.includes(control.test) && !log.includes("Cannot find module")))throw Error(`${control.id}:${kind}: unexpected result in ${output}`);
      }
      results.push({id:control.id,caught:true});
    }finally{rmSync(scratch,{recursive:true,force:true});}
  }
  const result={bun:Bun.version,ownerSha256:createHash("sha256").update(original).digest("hex"),controls:results};
  writeFileSync(join(output,"results.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(!process.argv[2])rmSync(output,{recursive:true,force:true});}
