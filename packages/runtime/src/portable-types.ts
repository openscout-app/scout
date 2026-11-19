// Public, dependency-free type aliases used by @openscout/runtime's published
// declarations. The implementation still runs on Node/Bun and may use Node
// built-ins internally, but exported .d.ts files must not require consumers to
// install @types/node just to type-check imports.

export type RuntimeEnv = Record<string, string | undefined>;

export type RuntimePlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd"
  | (string & {});

export type RuntimeSignal = string;
export type RuntimeTimer = ReturnType<typeof setTimeout>;

export type RuntimeTypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

export type RuntimeBinaryInput =
  | RuntimeTypedArray
  | ArrayBuffer
  | DataView;

export type RuntimeReadableLike = {
  on(event: "data", listener: (chunk: any) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  setEncoding(encoding: string): unknown;
};

export type RuntimeWritableLike = {
  end(input?: unknown): unknown;
  write?(chunk: unknown, callback?: (error?: Error | null) => void): unknown;
  write?(chunk: unknown, encoding?: string, callback?: (error?: Error | null) => void): unknown;
};

export type RuntimeChildProcessLike = {
  pid?: number;
  killed?: boolean;
  exitCode: number | null;
  signalCode?: RuntimeSignal | null;
  stdin?: RuntimeWritableLike;
  stdout?: RuntimeReadableLike;
  stderr?: RuntimeReadableLike;
  kill(signal?: RuntimeSignal | number): boolean;
  on(event: "close" | "exit", listener: (code: number | null, signal: RuntimeSignal | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: "close" | "exit", listener: (code: number | null, signal: RuntimeSignal | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  unref(): void;
};

export type RuntimeSpawnFunction<TChild extends RuntimeChildProcessLike = RuntimeChildProcessLike> = (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
) => TChild;

export type RuntimeErrnoError = Error & {
  code?: string | number;
  errno?: number;
  syscall?: string;
  path?: string;
};

export type RuntimeHttpHeaderValue = string | string[] | undefined;
export type RuntimeHttpHeaders = Record<string, RuntimeHttpHeaderValue>;

/**
 * Mesh trust cone ingress classification (docs/proposals/mesh-trust-cone.md):
 * every broker connection arrives over the unix socket, a genuine loopback TCP
 * peer, or a remote transport that requires peer authentication. Derived from
 * the socket address at the server edge — never from Host/forwarding headers.
 */
export type RuntimeTransportKind = "unix-socket" | "loopback" | "remote";

/** An enrolled mesh peer authenticated by the ingress gate. */
export type RuntimePeerAuthPrincipal = {
  /** full SHA-256 key ID of the enrolled peer */
  keyId: string;
  tier: "observe" | "control";
};

/** Server-edge transport/auth context attached to a request by the ingress gate. */
export type RuntimeRequestTransportContext = {
  transport: RuntimeTransportKind;
  /** socket remote address when one exists (TCP), for rate limiting/auditing */
  remoteAddress?: string;
  /** present only after the ingress gate verified the peer signature */
  peer?: RuntimePeerAuthPrincipal;
  /** present only after a local operator proof is verified */
  operator?: true;
  /** present only after the ingress gate verified a guest grant signature */
  guest?: RuntimeGuestAuthPrincipal;
  /** Verified principal proof; never accepted from forwarded body identity fields. */
  scoped?: import("./mesh-access.js").AccessProof;
};

/** A verified guest key and its active grant (never a mesh peer). */
export type RuntimeGuestAuthPrincipal = {
  keyId: string;
  grantId: string;
};

export type RuntimeHttpRequestLike = {
  method?: string;
  url?: string;
  headers: RuntimeHttpHeaders;
  /** attached at server ingress; absent for requests that bypass the gate */
  transportContext?: RuntimeRequestTransportContext;
  on(event: string, listener: (...args: any[]) => void): unknown;
  resume(): unknown;
  destroy(error?: Error): unknown;
};

export type RuntimeHttpResponseLike = {
  writableEnded?: boolean;
  destroyed?: boolean;
  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): unknown;
  write(chunk: unknown): unknown;
  end(chunk?: unknown): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  destroy?(): unknown;
  setHeader?(name: string, value: string | number | readonly string[]): unknown;
  getHeader?(name: string): string | number | string[] | undefined;
};

export type RuntimeHttpServerLike = {
  listening?: boolean;
  listen(port: number, host: string): unknown;
  listen(path: string): unknown;
  close(callback?: (error?: Error) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
};
