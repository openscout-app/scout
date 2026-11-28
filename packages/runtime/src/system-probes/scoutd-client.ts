import type { RuntimeEnv } from "../portable-types.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";

import {
  ProbeBackendError,
  probeRunOutput,
  type ProbeBackendMetadata,
  type ProbeCtx,
  type ProbeRunOutput,
} from "./registry.js";
import {
  expectedScoutHostExecVerbSchemaVersion,
  expectedScoutHostProbeSchemaVersion,
} from "./scout-host-catalog.js";
import { resolveOpenScoutSocketDirectory } from "../instance.js";
import { resolveOpenScoutHomeForEnv } from "../support-paths.js";

const CAPABILITIES_SCHEMA = "openscout.probe.capabilities/v1";
const REQUEST_SCHEMA = "openscout.probe.request/v1";
const SNAPSHOT_SCHEMA = "openscout.probe.snapshot/v1";
const ERROR_SCHEMA = "openscout.probe.error/v1";
const EXEC_REQUEST_SCHEMA = "openscout.exec.request/v1";
const EXEC_RESPONSE_SCHEMA = "openscout.exec.response/v1";
const CAPABILITY_RECHECK_MS = 10_000;
const SOCKET_TIMEOUT_MS = 900;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type ScoutdProbeFamilyCapability = {
  probeId: string;
  schemaVersion: number;
  ttlMs: number;
};

export type ScoutdExecVerbCapability = {
  verb: string;
  schemaVersion: number;
};

export type ScoutdProbeClientDiagnostics = {
  socketPath: string;
  socketExists: boolean;
  daemonObserved: boolean;
  daemonVersion: string | null;
  supportedProbeIds: string[];
  supportedExecVerbs: string[];
  lastCapabilityCheckAt: number | null;
  lastError: string | null;
};

type Capabilities = {
  daemonVersion: string;
  families: Map<string, ScoutdProbeFamilyCapability>;
  verbs: Map<string, ScoutdExecVerbCapability>;
};

type ScoutdSnapshotResponse<T> = {
  schema: typeof SNAPSHOT_SCHEMA;
  probeId: string;
  key?: string | null;
  generatedAt: number;
  ttlMs: number;
  value: T;
  error: { code?: string; message?: string; timedOut?: boolean; timed_out?: boolean } | null;
  daemonVersion: string;
};

type ScoutdProbeOutcome<T> =
  | {
      state: "scoutd";
      value: T;
      generatedAt: number;
      daemonVersion: string;
    }
  | {
      state: "local";
      fallbackSince?: number;
      fallbackReason?: string;
    };

type ScoutdExecResponse<T> = {
  schema: typeof EXEC_RESPONSE_SCHEMA;
  verb: string;
  ok: boolean;
  value?: T;
  error?: { code?: string; message?: string; timedOut?: boolean; timed_out?: boolean } | null;
  daemonVersion: string;
};

type ScoutdExecOutcome<T> =
  | {
      state: "scoutd";
      value: T;
      daemonVersion: string;
    }
  | {
      state: "local";
      fallbackSince?: number;
      fallbackReason?: string;
    };

type FallbackState = {
  since: number;
  reason: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export class ScoutdExecResponseError extends Error {
  code: string;
  timedOut: boolean;

  constructor(message: string, options: { code?: string; timedOut?: boolean } = {}) {
    super(message);
    this.name = "ScoutdExecResponseError";
    this.code = options.code ?? "exec_error";
    this.timedOut = options.timedOut ?? false;
  }
}

export class ScoutdProbeResponseError extends Error {
  code: string;
  timedOut: boolean;

  constructor(message: string, options: { code?: string; timedOut?: boolean } = {}) {
    super(message);
    this.name = "ScoutdProbeResponseError";
    this.code = options.code ?? "probe_error";
    this.timedOut = options.timedOut ?? false;
  }
}

export function resolveScoutdProbesSocketPath(env: RuntimeEnv = process.env): string {
  const explicit = env.OPENSCOUT_PROBES_SOCKET?.trim();
  if (explicit) {
    return explicit;
  }
  const preferred = join(resolveOpenScoutSocketDirectory({ env }), "probes.sock");
  if (existsSync(preferred)) return preferred;
  const openScoutHome = resolveOpenScoutHomeForEnv(env);
  const legacy = join(openScoutHome, "run", "scoutd-probes.sock");
  if (existsSync(legacy)) return legacy;
  return preferred;
}

export class ScoutdProbeClient {
  private capabilities: Capabilities | null = null;
  private lastCapabilityCheckAt: number | null = null;
  private lastError: string | null = null;
  private daemonObserved = false;
  private readonly fallbackByProbe = new Map<string, FallbackState>();
  private readonly fallbackByExec = new Map<string, FallbackState>();

  constructor(private readonly env: RuntimeEnv = process.env) {}

  async requestProbe<T>(input: {
    probeId: string;
    key?: string;
    maxAgeMs?: number;
    timeoutMs?: number;
  }): Promise<ScoutdProbeOutcome<T>> {
    const socketPath = resolveScoutdProbesSocketPath(this.env);
    const socketTimeoutMs = probeSocketTimeoutMs(input.timeoutMs);
    const socketExists = existsSync(socketPath);
    if (!socketExists) {
      this.capabilities = null;
      this.lastError = null;
      return this.daemonObserved
        ? this.fallback(input.probeId, input.key, `probe socket is missing: ${socketPath}`)
        : { state: "local" };
    }
    this.daemonObserved = true;

    const capabilities = await this.ensureCapabilities(socketPath, socketTimeoutMs);
    if (!capabilities) {
      return this.fallback(input.probeId, input.key, this.lastError ?? "probe capabilities unavailable");
    }
    const capability = capabilities.families.get(input.probeId);
    if (!capability) {
      return this.fallback(input.probeId, input.key, `scoutd does not serve ${input.probeId}`);
    }
    const expectedSchemaVersion = expectedScoutHostProbeSchemaVersion(input.probeId);
    if (expectedSchemaVersion === null) {
      return this.fallback(input.probeId, input.key, `client has no compiled schema version for ${input.probeId}`);
    }
    if (capability.schemaVersion !== expectedSchemaVersion) {
      return this.fallback(
        input.probeId,
        input.key,
        `scoutd serves ${input.probeId} schema v${capability.schemaVersion}, expected v${expectedSchemaVersion}`,
      );
    }

    try {
      const response = await requestJson<ScoutdSnapshotResponse<T>>(socketPath, {
        schema: REQUEST_SCHEMA,
        schemaVersion: expectedSchemaVersion,
        probeId: input.probeId,
        key: input.key ?? null,
        maxAgeMs: input.maxAgeMs,
        opTimeoutMs: requestOpTimeoutMs(input.timeoutMs),
      }, { timeoutMs: socketTimeoutMs });
      if (!isRecord(response) || response.schema !== SNAPSHOT_SCHEMA) {
        throw new Error("scoutd returned an invalid probe snapshot envelope");
      }
      if (response.error) {
        const error = isRecord(response.error) ? response.error : {};
        const code = readString(error.code) ?? "probe_error";
        const message = readString(error.message) ?? code;
        const timedOut = error.timedOut === true || error.timed_out === true;
        throw new ScoutdProbeResponseError(message, { code, timedOut });
      }
      this.fallbackByProbe.delete(fallbackKey(input.probeId, input.key));
      this.lastError = null;
      return {
        state: "scoutd",
        value: response.value,
        generatedAt: readNumber(response.generatedAt) ?? Date.now(),
        daemonVersion: readString(response.daemonVersion) ?? capabilities.daemonVersion,
      };
    } catch (error) {
      if (!(error instanceof ScoutdProbeResponseError)) {
        this.capabilities = null;
        this.lastCapabilityCheckAt = null;
      }
      this.lastError = fallbackMessage(error);
      return this.fallback(input.probeId, input.key, this.lastError);
    }
  }

  async requestExecVerb<T>(input: {
    verb: string;
    args: Record<string, unknown>;
  }): Promise<ScoutdExecOutcome<T>> {
    const socketPath = resolveScoutdProbesSocketPath(this.env);
    const socketTimeoutMs = execSocketTimeoutMs(input.args);
    const socketExists = existsSync(socketPath);
    if (!socketExists) {
      this.capabilities = null;
      this.lastError = null;
      return this.daemonObserved
        ? this.execFallback(input.verb, `probe socket is missing: ${socketPath}`)
        : { state: "local" };
    }
    this.daemonObserved = true;

    const capabilities = await this.ensureCapabilities(socketPath, socketTimeoutMs);
    if (!capabilities) {
      return this.execFallback(input.verb, this.lastError ?? "probe capabilities unavailable");
    }
    const capability = capabilities.verbs.get(input.verb);
    if (!capability) {
      return this.execFallback(input.verb, `scoutd does not serve ${input.verb}`);
    }
    const expectedSchemaVersion = expectedScoutHostExecVerbSchemaVersion(input.verb);
    if (expectedSchemaVersion === null) {
      return this.execFallback(input.verb, `client has no compiled schema version for ${input.verb}`);
    }
    if (capability.schemaVersion !== expectedSchemaVersion) {
      return this.execFallback(
        input.verb,
        `scoutd serves ${input.verb} schema v${capability.schemaVersion}, expected v${expectedSchemaVersion}`,
      );
    }

    try {
      const response = await requestJson<ScoutdExecResponse<T>>(socketPath, {
        schema: EXEC_REQUEST_SCHEMA,
        schemaVersion: expectedSchemaVersion,
        verb: input.verb,
        args: input.args,
      }, { timeoutMs: socketTimeoutMs });
      if (!isRecord(response) || response.schema !== EXEC_RESPONSE_SCHEMA) {
        throw new Error("scoutd returned an invalid exec response envelope");
      }
      if (!response.ok) {
        const error = isRecord(response.error) ? response.error : {};
        const code = readString(error.code) ?? "exec_error";
        const message = readString(error.message) ?? code;
        const timedOut = error.timedOut === true || error.timed_out === true;
        throw new ScoutdExecResponseError(message, { code, timedOut });
      }
      this.fallbackByExec.delete(input.verb);
      this.lastError = null;
      return {
        state: "scoutd",
        value: response.value as T,
        daemonVersion: readString(response.daemonVersion) ?? capabilities.daemonVersion,
      };
    } catch (error) {
      if (error instanceof ScoutdExecResponseError) {
        throw error;
      }
      this.capabilities = null;
      this.lastCapabilityCheckAt = null;
      this.lastError = fallbackMessage(error);
      return this.execFallback(input.verb, this.lastError);
    }
  }

  diagnostics(): ScoutdProbeClientDiagnostics {
    const socketPath = resolveScoutdProbesSocketPath(this.env);
    return {
      socketPath,
      socketExists: existsSync(socketPath),
      daemonObserved: this.daemonObserved,
      daemonVersion: this.capabilities?.daemonVersion ?? null,
      supportedProbeIds: this.capabilities ? [...this.capabilities.families.keys()].sort() : [],
      supportedExecVerbs: this.capabilities ? [...this.capabilities.verbs.keys()].sort() : [],
      lastCapabilityCheckAt: this.lastCapabilityCheckAt,
      lastError: this.lastError,
    };
  }

  resetForTests(): void {
    this.capabilities = null;
    this.lastCapabilityCheckAt = null;
    this.lastError = null;
    this.daemonObserved = false;
    this.fallbackByProbe.clear();
    this.fallbackByExec.clear();
  }

  private async ensureCapabilities(socketPath: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<Capabilities | null> {
    const now = Date.now();
    if (this.capabilities && this.lastCapabilityCheckAt !== null && now - this.lastCapabilityCheckAt < CAPABILITY_RECHECK_MS) {
      return this.capabilities;
    }

    this.lastCapabilityCheckAt = now;
    try {
      const response = await requestJson<unknown>(socketPath, { schema: CAPABILITIES_SCHEMA }, { timeoutMs });
      if (!isRecord(response) || response.schema !== CAPABILITIES_SCHEMA) {
        throw new Error("scoutd returned an invalid capabilities envelope");
      }
      const daemonVersion = readString(response.daemonVersion) ?? "unknown";
      const families = new Map<string, ScoutdProbeFamilyCapability>();
      if (Array.isArray(response.families)) {
        for (const entry of response.families) {
          if (!isRecord(entry)) continue;
          const probeId = readString(entry.probeId);
          const schemaVersion = readNumber(entry.schemaVersion);
          const ttlMs = readNumber(entry.ttlMs);
          if (probeId && schemaVersion !== null && ttlMs !== null) {
            families.set(probeId, { probeId, schemaVersion, ttlMs });
          }
        }
      }
      const verbs = new Map<string, ScoutdExecVerbCapability>();
      if (Array.isArray(response.verbs)) {
        for (const entry of response.verbs) {
          if (!isRecord(entry)) continue;
          const verb = readString(entry.verb);
          const schemaVersion = readNumber(entry.schemaVersion);
          if (verb && schemaVersion !== null) {
            verbs.set(verb, { verb, schemaVersion });
          }
        }
      }
      this.capabilities = { daemonVersion, families, verbs };
      this.daemonObserved = true;
      this.lastError = null;
      return this.capabilities;
    } catch (error) {
      this.capabilities = null;
      this.lastError = fallbackMessage(error);
      return null;
    }
  }

  private fallback(probeId: string, key: string | undefined, reason: string): ScoutdProbeOutcome<never> {
    const id = fallbackKey(probeId, key);
    let state = this.fallbackByProbe.get(id);
    if (!state || state.reason !== reason) {
      state = { since: Date.now(), reason };
      this.fallbackByProbe.set(id, state);
    }
    return {
      state: "local",
      fallbackSince: state.since,
      fallbackReason: state.reason,
    };
  }

  private execFallback(verb: string, reason: string): ScoutdExecOutcome<never> {
    let state = this.fallbackByExec.get(verb);
    if (!state || state.reason !== reason) {
      state = { since: Date.now(), reason };
      this.fallbackByExec.set(verb, state);
    }
    return {
      state: "local",
      fallbackSince: state.since,
      fallbackReason: state.reason,
    };
  }
}

let singletonClient: ScoutdProbeClient | null = null;

export function getScoutdProbeClient(): ScoutdProbeClient {
  singletonClient ??= new ScoutdProbeClient();
  return singletonClient;
}

export function resetScoutdProbeClientForTests(): void {
  singletonClient?.resetForTests();
  singletonClient = null;
}

export async function runWithScoutdFallback<T>(input: {
  probeId: string;
  key?: string;
  ctx: ProbeCtx;
  local: () => Promise<T>;
}): Promise<ProbeRunOutput<T>> {
  const client = getScoutdProbeClient();
  const scoutd = await client.requestProbe<T>({
    probeId: input.probeId,
    key: input.key,
    maxAgeMs: input.ctx.maxAgeMs,
    timeoutMs: input.ctx.timeoutMs,
  });

  if (scoutd.state === "scoutd") {
    return probeRunOutput(scoutd.value, {
      backend: "scoutd",
      generatedAt: scoutd.generatedAt,
    });
  }

  const metadata: ProbeBackendMetadata = scoutd.fallbackSince
    ? {
        backend: "local-fallback",
        fallbackSince: scoutd.fallbackSince,
        fallbackReason: scoutd.fallbackReason ?? "scoutd unavailable",
      }
    : { backend: "local" };

  try {
    const local = await input.local();
    return probeRunOutput(local, metadata);
  } catch (error) {
    throw new ProbeBackendError(
      error instanceof Error ? error.message : String(error),
      metadata,
      error,
    );
  }
}

function probeSocketTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return SOCKET_TIMEOUT_MS;
  }
  return Math.max(SOCKET_TIMEOUT_MS, Math.min(Math.max(0, timeoutMs) + 1_000, 31_000));
}

function requestOpTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  return Math.max(0, Math.floor(timeoutMs));
}

function execSocketTimeoutMs(args: Record<string, unknown>): number {
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.max(0, args.timeoutMs)
    : 5_000;
  return Math.max(SOCKET_TIMEOUT_MS, Math.min(timeoutMs + 1_000, 31_000));
}

async function requestJson<T>(
  socketPath: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const bun = (globalThis as typeof globalThis & {
    Bun?: {
      connect?: (options: {
        unix: string;
        socket: {
          open?: (socket: { write: (data: string) => unknown; end?: () => unknown }) => void;
          data?: (socket: unknown, data: Uint8Array) => void;
          close?: () => void;
          error?: (socket: unknown, error: Error) => void;
        };
      }) => Promise<{ end?: () => unknown }>;
    };
  }).Bun;
  if (bun?.connect) {
    return await requestJsonWithBun<T>(bun.connect, socketPath, payload, options);
  }

  return await new Promise<T>((resolve, reject) => {
    const socket = new Socket();
    let response = "";
    let settled = false;

    const finish = (error: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };

    const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;
    const timer = setTimeout(() => {
      finish(new Error(`scoutd probe socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const finishFromResponse = (): void => {
      if (settled) return;
      try {
        const parsed = JSON.parse(response) as unknown;
        if (isRecord(parsed) && parsed.schema === ERROR_SCHEMA) {
          const error = isRecord(parsed.error) ? parsed.error : {};
          const message = readString(error.message) ?? readString(error.code) ?? "scoutd probe request failed";
          finish(new Error(message));
          return;
        }
        finish(null, parsed as T);
      } catch (error) {
        finish(new Error(`scoutd probe response was not JSON: ${fallbackMessage(error)}`));
      }
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("scoutd probe response exceeded output limit"));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", finishFromResponse);
    socket.on("close", () => {
      if (!settled) {
        if (response.length === 0) {
          finish(new Error("scoutd probe socket closed without a response"));
        } else {
          finishFromResponse();
        }
      }
    });
    socket.connect(socketPath);
  });
}

async function requestJsonWithBun<T>(
  connect: NonNullable<NonNullable<(typeof globalThis & {
    Bun?: { connect?: unknown };
  })["Bun"]>["connect"]> extends (...args: infer A) => infer R ? (...args: A) => R : never,
  socketPath: string,
  payload: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let response = "";
    let settled = false;
    let socketRef: { end?: () => unknown } | null = null;
    const decoder = new TextDecoder();

    const finish = (error: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socketRef?.end?.();
      } catch {
        // Best-effort close only.
      }
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };

    const finishFromResponse = (): void => {
      if (settled) return;
      try {
        const parsed = JSON.parse(response) as unknown;
        if (isRecord(parsed) && parsed.schema === ERROR_SCHEMA) {
          const error = isRecord(parsed.error) ? parsed.error : {};
          const message = readString(error.message) ?? readString(error.code) ?? "scoutd probe request failed";
          finish(new Error(message));
          return;
        }
        finish(null, parsed as T);
      } catch (error) {
        finish(new Error(`scoutd probe response was not JSON: ${fallbackMessage(error)}`));
      }
    };

    const timeoutMs = options.timeoutMs ?? SOCKET_TIMEOUT_MS;
    const timer = setTimeout(() => {
      finish(new Error(`scoutd probe socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    void connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(`${JSON.stringify(payload)}\n`);
        },
        data(_socket, data) {
          response += decoder.decode(data, { stream: true });
          if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
            finish(new Error("scoutd probe response exceeded output limit"));
          }
        },
        close() {
          if (response.length === 0) {
            finish(new Error("scoutd probe socket closed without a response"));
          } else {
            response += decoder.decode();
            finishFromResponse();
          }
        },
        error(_socket, error) {
          finish(error);
        },
      },
    }).then((socket) => {
      socketRef = socket;
    }, (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function fallbackKey(probeId: string, key: string | undefined): string {
  return `${probeId}\u0000${key ?? ""}`;
}
