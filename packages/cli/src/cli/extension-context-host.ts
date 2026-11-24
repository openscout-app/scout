/** API 1 is deliberately outside this new capability gate. */
export function scoutExtensionContextBackend(): boolean {
  // No qualified host. At exact 1.3.14 (0d9b296a) the native subprocess retains
  // ownership of a Node-wrapped extra pipe's number and closes it again at GC
  // after the wrapper's socket destroyed it — a measured double owner (macOS),
  // with the finalizer path in shared non-Windows source. A backend qualifies
  // only by passing the corrected reclaim witness with a single descriptor owner.
  return false;
}

/** Internal fixed resolver. No user flag or environment override can load code.
 * Source runs use the runtime sibling; installed CLI runs use a fixed sidecar.
 * Loading this module never opens the product gate or allocates a descriptor.
 */
export async function loadScoutExtensionChannelHost(): Promise<typeof import("@openscout/runtime/extensions")> {
  const location = import.meta.url.endsWith(".ts")
    ? new URL("../../../runtime/src/extension-channel-host.ts", import.meta.url)
    : new URL("./extension-channel-host.mjs", import.meta.url);
  return await import(location.href);
}
