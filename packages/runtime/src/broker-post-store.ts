import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { POST_LIMITS, type ScoutPost, type ScoutPostAuthor, type ScoutPostLink, type ScoutShow } from "@openscout/protocol";
import { resolveShowWorkspace, ShowError } from "./broker-show-store.js";

export class PostError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type PostInput = {
  text: string;
  links?: ScoutPostLink[];
  milestone?: boolean;
  currentDirectory: string;
  author: Omit<ScoutPostAuthor, "nodeId">;
  /** The show this post carries, already committed by the show store. */
  show?: ScoutShow;
};

function cleanLinks(links: ScoutPostLink[] | undefined): ScoutPostLink[] | undefined {
  if (!links?.length) return undefined;
  if (links.length > POST_LIMITS.links) throw new PostError("post_too_many_links");
  return links.map(link => {
    let url: URL;
    try { url = new URL(link.url); } catch { throw new PostError("post_link_invalid"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new PostError("post_link_must_be_http");
    const title = link.title?.trim();
    return { url: url.toString(), ...(title ? { title } : {}) };
  });
}

/** The file part of a post, from the show that holds its bytes. */
export function postFileFromShow(show: ScoutShow): NonNullable<ScoutPost["file"]> {
  return { showId: show.id, kind: show.kind, mediaType: show.mediaType, byteSize: show.byteSize, name: basename(show.sourcePath) };
}

/** A show no post carries reads as a post whose text is its caption. */
export function postFromShow(show: ScoutShow, name?: string): ScoutPost {
  return {
    id: show.id, source: "show",
    author: { agentId: show.agentId, ...(show.sessionId ? { sessionId: show.sessionId } : {}), ...(show.harness ? { harness: show.harness } : {}), ...(name ? { name } : {}), nodeId: show.nodeId },
    projectRoot: show.projectRoot, project: basename(show.projectRoot), worktree: show.worktree, ...(show.branch ? { branch: show.branch } : {}),
    text: show.caption?.trim() ?? "", file: postFileFromShow(show), createdAt: show.createdAt,
  };
}

/**
 * Runtime-owned posts: an append-only JSON-lines file, read once into memory.
 * The runtime is the only writer, and writes are serialized.
 */
export class BrokerPostStore {
  private loaded: Promise<ScoutPost[]> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** An interrupted append left a line with no newline; the next append starts a fresh line. */
  private torn = false;
  private listeners = new Set<(post: ScoutPost) => void>();
  constructor(readonly directory: string, readonly nodeId: string, readonly limits: { records: number } = POST_LIMITS) {}

  private get file(): string { return join(this.directory, "posts.jsonl"); }

  private load(): Promise<ScoutPost[]> {
    this.loaded ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const text = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
      this.torn = text.length > 0 && !text.endsWith("\n");
      const posts: ScoutPost[] = [];
      // A torn last line from an interrupted append is dropped, not fatal.
      for (const line of text.split("\n")) { if (line.trim()) { try { posts.push(JSON.parse(line) as ScoutPost); } catch {} } }
      return posts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    })();
    return this.loaded;
  }

  subscribe(listener: (post: ScoutPost) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  /** Posts after `since`, oldest first. */
  async list(since = 0): Promise<ScoutPost[]> {
    return (await this.load()).filter(post => post.createdAt > since);
  }

  post(input: PostInput): Promise<ScoutPost> {
    const run = this.queue.then(() => this.commit(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(input: PostInput): Promise<ScoutPost> {
    const text = input.text.trim();
    if (!text) throw new PostError("post_text_required");
    if (text.length > POST_LIMITS.textCharacters) throw new PostError("post_text_too_long");
    const links = cleanLinks(input.links);
    const posts = await this.load();
    let workspace: Awaited<ReturnType<typeof resolveShowWorkspace>> | undefined;
    try { workspace = await resolveShowWorkspace(input.currentDirectory); }
    catch (error) { if (!(error instanceof ShowError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const author: ScoutPostAuthor = { ...input.author, nodeId: this.nodeId };
    for (const key of ["sessionId", "harness", "name"] as const) if (!author[key]) delete author[key];
    const post: ScoutPost = {
      id: randomUUID(), source: "post", author,
      ...(workspace ? { projectRoot: workspace.projectRoot, project: basename(workspace.projectRoot), worktree: workspace.worktree, ...(workspace.branch ? { branch: workspace.branch } : {}) } : {}),
      text, ...(links ? { links } : {}), ...(input.show ? { file: postFileFromShow(input.show) } : {}),
      ...(input.milestone ? { milestone: true } : {}),
      createdAt: Math.max(Date.now(), (posts.at(-1)?.createdAt ?? 0) + 1),
    };
    // Memory changes only after the file does, so a failed write leaves both as they were.
    if (posts.length + 1 > this.limits.records) {
      // Keep the newest records; rewrite atomically so a crash leaves the old file.
      const kept = [...posts, post].slice(-this.limits.records);
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, kept.map(p => JSON.stringify(p)).join("\n") + "\n", { mode: 0o600 });
      await rename(temporary, this.file);
      posts.splice(0, posts.length, ...kept);
      this.torn = false;
    } else {
      await appendFile(this.file, (this.torn ? "\n" : "") + JSON.stringify(post) + "\n", { mode: 0o600 });
      this.torn = false;
      posts.push(post);
    }
    for (const listener of this.listeners) { try { listener(post); } catch {} }
    return post;
  }
}
