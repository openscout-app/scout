import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationRequest } from "@openscout/protocol";
import type { PermissionSupervisorVerdict } from "./permission-supervisor.js";

export type PermissionDecision = "once" | "project" | "deny";
export type ManagedPermissionPrompt = {
  sessionId: string;
  projectRoot: string;
  cwd?: string;
  text: string;
  version: string;
  decisions: PermissionDecision[];
  decisionLabels?: Partial<Record<PermissionDecision, string>>;
  /** Structured policy result. Null requires an operator; undefined uses the dialog supervisor. */
  supervisorVerdict?: PermissionSupervisorVerdict | null;
  /** Must revalidate the prompt immediately before writing to its live process. */
  answer: (decision: PermissionDecision) => Promise<void>;
  isCurrent: () => Promise<boolean>;
};
const context = new AsyncLocalStorage<InvocationRequest>();
let handler: ((invocation: InvocationRequest, prompt: ManagedPermissionPrompt) => Promise<void>) | undefined;
export function configureManagedPermissionHandler(value: typeof handler): void { handler = value; }
export function withManagedPermissionContext<T>(invocation: InvocationRequest, run: () => T): T {
  return context.run(invocation, run);
}
/** Returns false outside a broker-driven invocation. Never gates foreign sessions. */
export async function requestManagedPermission(prompt: ManagedPermissionPrompt): Promise<boolean> {
  const invocation = context.getStore();
  if (!invocation || !handler) return false;
  await handler(invocation, prompt);
  return true;
}

/** Bind to the current invocation, not the context in which a reused process booted. */
export function bindManagedPermissionRequester(): (prompt: ManagedPermissionPrompt) => Promise<boolean> {
  const invocation = context.getStore();
  return async prompt => {
    if (!invocation || !handler) return false;
    await handler(invocation, prompt);
    return true;
  };
}

export function hasManagedPermissionContext(): boolean { return Boolean(context.getStore() && handler); }
