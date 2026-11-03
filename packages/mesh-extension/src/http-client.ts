import { TaskClosedError, taskClosedRefusal } from '@openscout/protocol';

/** A bounded HTTP client. No stores, runtime paths, sockets or key discovery. */
export class RuntimeHttpClient {
  readonly origin: string;
  constructor(readonly options: { brokerUrl: string; fetch?: typeof fetch; proof?: (input: { method: string; path: string; body: string }) => Promise<Record<string, string>> }) {
    const u = new URL(options.brokerUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('broker URL must be an HTTP(S) origin without credentials');
    this.origin = u.origin;
  }
  async eventStream(signal: AbortSignal): Promise<Response> {
    const path = '/v1/events/stream';
    const proof = await this.options.proof?.({ method: 'GET', path, body: '' });
    const connect = new AbortController();const timer = setTimeout(() => connect.abort(), 20_000);
    try {
      const response = await (this.options.fetch ?? fetch)(new URL(path, this.origin), { headers: { accept: 'text/event-stream', ...proof }, signal: AbortSignal.any([signal, connect.signal]), redirect: 'error' });
      if (!response.ok) throw new Error('runtime event stream refused');
      return response;
    } finally { clearTimeout(timer); }
  }
  async request(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const url = new URL(path, this.origin);
    if (path.length > 16 * 1024 || url.origin !== this.origin || !path.startsWith('/v1/') && path !== '/health') throw new Error('invalid runtime API path');
    const text = body === undefined ? '' : JSON.stringify(body), method = body === undefined ? 'GET' : 'POST';
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('runtime request exceeds size bound');
    const headers = { 'content-type': 'application/json', ...await this.options.proof?.({ method, path: url.pathname + url.search, body: text }) };
    const timeout = AbortSignal.timeout(20_000);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await (this.options.fetch ?? fetch)(url, { method, headers, ...(body === undefined ? {} : { body: text }), signal: abort, redirect: 'error' });
    const reader = response.body?.getReader(); if (!reader) throw new Error('runtime returned no response');
    const chunks: Uint8Array[] = []; let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };abort.addEventListener('abort', cancel, { once: true });
    try {
      while (true) { abort.throwIfAborted();const part = await reader.read();abort.throwIfAborted();if (part.done) break;
        bytes += part.value.byteLength;if (bytes > 8 * 1024 * 1024) throw new Error('runtime response exceeds size bound');chunks.push(part.value); }
    } finally { abort.removeEventListener('abort', cancel);void reader.cancel().catch(() => {}); }
    if (!response.ok) {
      if (response.status === 409) {
        let refusal;
        try { refusal = taskClosedRefusal(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* Other failures stay redacted. */ }
        if (refusal) throw new TaskClosedError(refusal, refusal.reason === 'already_answered'
          ? 'task already has a final reply' : `task is already ${refusal.reason}`);
      }
      throw new Error(`runtime request refused (${response.status})`);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}
