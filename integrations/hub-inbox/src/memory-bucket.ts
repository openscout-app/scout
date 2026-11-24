import type { InboxBucket, InboxObject } from "./worker.ts";

/** An in-memory stand-in for the R2 bucket, for tests and local runs. */
export class MemoryInboxBucket implements InboxBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    this.objects.set(key, { bytes: new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)), uploaded: new Date() });
  }

  async get(key: string) {
    const found = this.objects.get(key);
    return found ? { arrayBuffer: async () => found.bytes.slice().buffer as ArrayBuffer } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(options: { prefix?: string; startAfter?: string; limit?: number; cursor?: string }) {
    const start = options.cursor ?? options.startAfter;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? "") && (!start || key > start))
      .sort();
    const limit = options.limit ?? 1000;
    const page = keys.slice(0, limit);
    const objects: InboxObject[] = page.map((key) => ({ key, size: this.objects.get(key)!.bytes.length, uploaded: this.objects.get(key)!.uploaded }));
    const truncated = keys.length > limit;
    return { objects, truncated, ...(truncated ? { cursor: page[page.length - 1] } : {}) };
  }
}
