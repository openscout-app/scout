/** Paired source controls in isolated copies. No production selector or hook. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statfsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const root=fileURLToPath(new URL("..",import.meta.url)),explicit=process.argv[2];
const out=explicit??mkdtempSync(join(tmpdir(),"pairing-view-evidence-"));mkdirSync(out,{recursive:true});
const original=readFileSync(join(root,"packages/runtime/src/pairing-security/trust-owner.ts"),"utf8");
const unit=readFileSync(join(root,"packages/runtime/src/pairing-security/trust-authority-view.test.ts"),"utf8");
const row='!rowValid(value,rowCount+1,root.id)';
const method=original.slice(original.indexOf('  readAuthority(context?:'),original.indexOf('  /** Membership is authoritative;'));
const controls=[
 {id:"view-skips-row-validation",test:"authority refusal equivalence: row validation",edits:[[row,'(materialize && !rowValid(value,rowCount+1,root.id))']]},
 {id:"view-before-completion",test:"authority view completes a real committed publication",edits:[['const state = this.readyState(root!, false);','const state = this.state(root!, true, false);']]},
 {id:"view-cached-positive",test:"authority refusal equivalence: changed early chunk",edits:[
  ['const completing = new Set<string>();','const completing = new Set<string>(); const viewCache=new WeakMap<PairingTrustOwner,PairingAuthorityView>();'],
  [method,method.replace('    this.root(true);','    if(viewCache.has(this))return viewCache.get(this)!;\n    this.root(true);').replace('    return this.operation(context, root => {','    const view = this.operation(context, root => {').replace('    });\n  }','    });\n    viewCache.set(this,view);return view;\n  }')]]},
 {id:"shared-row-full",test:"shared row validator full flavor",edits:[[row,'false']]},
 {id:"shared-row-view",test:"shared row validator view flavor",edits:[[row,'false']]},
];
const url=(p:string)=>pathToFileURL(join(root,p)).href,results=[];
for(const c of controls){
 const disk=statfsSync(process.platform==="darwin"?"/System/Volumes/Data":"/");if(disk.bavail*disk.bsize<3*1024**3)throw Error("3 GiB disk floor");
 let altered=original;for(const [needle,replacement]of c.edits){if(altered.split(needle!).length!==2)throw Error("nonunique anchor "+c.id);altered=altered.replace(needle!,replacement!);}
 const scratch=mkdtempSync(join(tmpdir(),"pairing-view-control-")),hashes:Record<string,string>={};
 try{
  for(const [kind,raw]of [["healthy",original],["bypass",altered]] as const){
   const subject=join(scratch,kind+"-owner.ts"),tests=join(scratch,kind+".test.ts");let source=raw;
   hashes[kind]=createHash("sha256").update(raw).digest("hex");
   for(const [from,to]of [["../node-identity.js","packages/runtime/src/node-identity.ts"],["../instance.js","packages/runtime/src/instance.ts"],["./host-binding.js","packages/runtime/src/pairing-security/host-binding.ts"],["../support-paths.js","packages/runtime/src/support-paths.ts"],["./trust-capsule.js","packages/runtime/src/pairing-security/trust-capsule.ts"],["./trust-cutover.js","packages/runtime/src/pairing-security/trust-cutover.ts"],["./trust-reclamation.js","packages/runtime/src/pairing-security/trust-reclamation.ts"]])source=source.replaceAll(JSON.stringify(from),JSON.stringify(url(to!)));
   writeFileSync(subject,source);
   writeFileSync(tests,unit.replace('"./trust-owner.ts"',JSON.stringify(subject)).replace('"./trust-capsule.ts"',JSON.stringify(url("packages/runtime/src/pairing-security/trust-capsule.ts"))).replace('"../../../../scripts/fixtures/pairing-capsule.ts"',JSON.stringify(url("scripts/fixtures/pairing-capsule.ts"))))
   const child=Bun.spawn([process.execPath,"test",tests,"--test-name-pattern",c.test],{stdout:"pipe",stderr:"pipe"});
   const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);const log=stdout+stderr;
   writeFileSync(join(out,`${c.id}-${kind}.log`),log);
   if(kind==="healthy"?exit!==0:!(exit!==0&&log.includes("(fail)")&&log.includes(c.test)&&!(/Cannot find module|ParseError|SyntaxError|timed out|fixture coordination/.test(log))))throw Error(`${c.id}/${kind}: invalid evidence in ${out}`);
  }
  results.push({id:c.id,caught:true,hashes});
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
writeFileSync(join(out,"results.json"),JSON.stringify({bun:Bun.version,controls:results},null,2));console.log(JSON.stringify(results));
if(!explicit)rmSync(out,{recursive:true,force:true});
