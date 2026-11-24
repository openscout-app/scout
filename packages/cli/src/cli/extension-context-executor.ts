/** Internal dormant executor. The public entry owns product authorization.
 * Dependencies are explicit internal capabilities, not CLI/env-selected loaders.
 * No endpoint number acquires a second owner. The source is borrowed for spawn
 * and closed synchronously; the parent adapter closes to produce actual EOF.
 */
import {spawn, type ChildProcess} from "node:child_process";
import {constants as osConstants} from "node:os";
import {INHERITED_DESCRIPTOR_LAYOUTS, MAX_INHERITED_DESCRIPTOR_SLOT} from "@openscout/runtime/daemon";
import type {allocateExtensionChannel} from "@openscout/runtime/extensions";
type Channel = ReturnType<typeof allocateExtensionChannel>;
type Status = {code:number|null; signal:NodeJS.Signals|null};
export const EXTENSION_CONTEXT_DELIVERY_TIMEOUT_MS = 5000;
export function scoutExtensionContextStdio(source: number): Array<"inherit"|"ignore"|number> {
  if (!Number.isSafeInteger(source) || source <= MAX_INHERITED_DESCRIPTOR_SLOT) throw Error("context_delivery_failed");
  const stdio: Array<"inherit"|"ignore"|number> = Array(MAX_INHERITED_DESCRIPTOR_SLOT+1).fill("ignore");
  for (const slot of Object.values(INHERITED_DESCRIPTOR_LAYOUTS.stdio)) stdio[slot]="inherit";
  stdio[INHERITED_DESCRIPTOR_LAYOUTS.extensionApi2.context]=source;
  return stdio;
}
export async function stopScoutExtensionContextChild(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { await closed; return; }
  child.kill("SIGTERM");
  const timer=setTimeout(()=>child.kill("SIGKILL"),250);
  try {await closed;} finally {clearTimeout(timer);}
}
/** Internal capability seam, inert in public dispatch while the gate is false.
 * Not exported by the CLI bundle; no argument/environment path supplies these
 * capabilities. Tests can observe driver closes without adding FD wrappers.
 */
export async function executeScoutExtensionContext(input: {
  command:string; args:readonly string[]; env:NodeJS.ProcessEnv; cwd:string; wire:Uint8Array; signal?:AbortSignal;
}, allocate:()=>Channel, spawnChild: typeof spawn=spawn): Promise<number> {
  if (!(input.wire instanceof Uint8Array) || input.wire.length>65536 || input.wire.at(-1)!==10) throw Error("context_delivery_failed");
  let channel:Channel|undefined, child:ChildProcess|undefined, closed:Promise<Status>|undefined;
  let delivered=false, completed=false, spawnError=false;
  const abort=new AbortController();
  const cancel=()=>abort.abort();
  const onError=()=>{spawnError=true;cancel();};
  const onClose=()=>{
    // A final cooperative yield can outlive a child that read the whole frame.
    // Preserve completed kernel delivery; cancel only genuinely pending bytes.
    if(!delivered&&channel!.parent.stats.writeBytes<input.wire.byteLength)cancel();
  };
  const forward=(signal:NodeJS.Signals)=>{child?.kill(signal);if(!delivered)cancel();};
  const interrupt=()=>{if(!delivered)cancel();}; // Ctrl-C already reaches the foreground process group.
  try {
    // Allocation itself is covered. No statement after allocation escapes finally.
    channel=allocate();
    if (channel.target!==INHERITED_DESCRIPTOR_LAYOUTS.extensionApi2.context) throw Error("context_delivery_failed");
    if (input.signal?.aborted) throw Error("context_delivery_failed");
    input.signal?.addEventListener("abort",cancel,{once:true});
    try {child=spawnChild(input.command,[...input.args],{env:input.env,cwd:input.cwd,stdio:scoutExtensionContextStdio(channel.source.fd)});}
    finally {channel.source.close();} // Before ANY await, on success and throw alike.
    closed=new Promise<Status>(resolveExit=>child!.once("close",(code,signal)=>resolveExit({code,signal})));
    child.on("error",onError); child.on("close",onClose);
    process.on("SIGTERM",forward);process.on("SIGHUP",forward);process.on("SIGINT",interrupt);
    await channel.parent.write(input.wire,{timeoutMs:EXTENSION_CONTEXT_DELIVERY_TIMEOUT_MS,signal:abort.signal});
    if (abort.signal.aborted || spawnError) throw Error("context_delivery_failed");
    channel.parent.close(); // EOF precedes command wait; no command-wide deadline.
    delivered=true;
    const status=await closed;
    if (spawnError) throw Error("context_delivery_failed");
    completed=true;
    return status.signal ? 128+(osConstants.signals[status.signal]??1) : status.code??1;
  } finally {
    cancel();
    try {channel?.source.close();}
    finally {
      try {channel?.parent.close();}
      finally {
        try {if(child&&!completed) {
          // Also covers a listener-setup failure after successful spawn.
          const reaped=closed??new Promise<Status>(done=>child!.once("close",(code,signal)=>done({code,signal})));
          await stopScoutExtensionContextChild(child,reaped);
        }} finally {
          child?.off("error",onError);child?.off("close",onClose);
          process.off("SIGTERM",forward);process.off("SIGHUP",forward);process.off("SIGINT",interrupt);
          input.signal?.removeEventListener("abort",cancel);
        }
      }
    }
  }
}
