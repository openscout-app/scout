import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { POST_LIMITS, type ScoutPost, type ScoutPostAuthor, type ScoutPostLink, type ScoutShow } from "@openscout/protocol";
import { resolveShowWorkspace, ShowError } from "./broker-show-store.js";

export class PostError extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: string) { super(message); }
}

export type PostInput = {
  text: string;
  links?: ScoutPostLink[];
  milestone?: boolean;
  currentDirectory: string;
  author: Omit<ScoutPostAuthor, "nodeId">;
  /**
   * The file this post carries. `key` names the file for the repeat rule and
   * `keyOf` names the file an earlier post's show holds. `attach` stores it as
   * a show, and runs only once the post is accepted, so a refused post leaves
   * no show behind.
   */
  file?: { key: string; keyOf: (showId: string) => Promise<string | undefined>; attach: () => Promise<ScoutShow> };
};

export type PostLimits = { records: number; repeatMax?: number; repeatWindowMs?: number };

/** Trimmed text and checked links; throws the same refusal the store would. */
export function preparePost(input: { text: string; links?: ScoutPostLink[] }): { text: string; links?: ScoutPostLink[] } {
  const text = input.text.trim();
  if (!text) throw new PostError("post_text_required");
  if (text.length > POST_LIMITS.textCharacters) throw new PostError("post_text_too_long");
  const links = cleanLinks(input.links);
  return { text, ...(links ? { links } : {}) };
}

/** Same message: same text up to case and whitespace, same links in any order. */
function messageKey(text: string, links: ScoutPostLink[] | undefined): string {
  return JSON.stringify([text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(), (links ?? []).map(link => link.url).sort()]);
}

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
  constructor(readonly directory: string, readonly nodeId: string, readonly limits: PostLimits = POST_LIMITS) {}

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
    const { text, links } = preparePost(input);
    const posts = await this.load();
    await this.refuseRepeat(posts, input, text, links);
    const show = input.file ? await input.file.attach() : undefined;
    let workspace: Awaited<ReturnType<typeof resolveShowWorkspace>> | undefined;
    try { workspace = await resolveShowWorkspace(input.currentDirectory); }
    catch (error) { if (!(error instanceof ShowError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const author: ScoutPostAuthor = { ...input.author, nodeId: this.nodeId };
    for (const key of ["sessionId", "harness", "name"] as const) if (!author[key]) delete author[key];
    const post: ScoutPost = {
      id: randomUUID(), source: "post", author,
      ...(workspace ? { projectRoot: workspace.projectRoot, project: basename(workspace.projectRoot), worktree: workspace.worktree, ...(workspace.branch ? { branch: workspace.branch } : {}) } : {}),
      text, ...(links ? { links } : {}), ...(show ? { file: postFileFromShow(show) } : {}),
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

  /**
   * Spam guard, not a quota: refuse a message the same agent already posted
   * `repeatMax` times within `repeatWindowMs`. Distinct posts and milestones
   * follow the same rule, so distinct posts are never capped.
   */
  private async refuseRepeat(posts: ScoutPost[], input: PostInput, text: string, links: ScoutPostLink[] | undefined): Promise<void> {
    const max = this.limits.repeatMax ?? POST_LIMITS.repeatMax;
    const windowMs = this.limits.repeatWindowMs ?? POST_LIMITS.repeatWindowMs;
    const key = messageKey(text, links);
    const after = Date.now() - windowMs;
    let repeats = 0;
    for (let i = posts.length - 1; i >= 0 && posts[i]!.createdAt > after; i--) {
      const earlier = posts[i]!;
      if (earlier.author.agentId !== input.author.agentId || messageKey(earlier.text, earlier.links) !== key) continue;
      if (Boolean(earlier.file) !== Boolean(input.file)) continue;
      if (earlier.file && input.file && await input.file.keyOf(earlier.file.showId) !== input.file.key) continue;
      repeats += 1;
    }
    if (repeats >= max) {
      const minutes = Math.round(windowMs / 60_000);
      throw new PostError("post_repeated", 429, `${input.author.agentId} already posted this message ${repeats} times in the last ${minutes} minutes; post something new instead of repeating it`);
    }
  }
}
