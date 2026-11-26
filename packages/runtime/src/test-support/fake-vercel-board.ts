/**
 * An in-memory Board that answers the documented HTTP routes Scout uses
 * (Board 0.52 reference). No network: tests pass `fetch` to the transport.
 * Faults are injected per route: drop the answer after applying the write,
 * fail before applying, or answer a status.
 */
type Task = {
  state: "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed" | "canceled";
  owner: string; by: string; for: string | null; needs: string[]; epoch: number;
  claim: { actor: string; until: number; token: string } | null;
  blocked: { kind: string | null; reason: string } | null; result: string | null; reason: string | null;
};
type Message = {
  id: string; channel: string; text: string; re: string | null; labels: Record<string, string>; deleted: boolean; from?: string;
  createdAt: string; editedAt?: string; version: number; revision: number; by: { actor: string; principal: string; profile: string | null }; task?: Task;
};
type Event = { seq: number; type: string; channel: string; payload: Record<string, unknown>; messageId?: string; snapshot?: unknown };
export type FakeVercelBoardFault = { route: string; mode: "drop_answer" | "fail_before"; status?: number; times?: number } | { route: string; mode: "status"; status: number; code: string; times?: number; retryAfter?: string };

export class FakeVercelBoard {
  readonly principal: string;
  readonly token: string;
  readonly requests: { method: string; path: string; headers: Record<string, string>; body?: unknown }[] = [];
  private seq = 0;
  private floor = 0;
  private readonly messages = new Map<string, Message>();
  private readonly events: Event[] = [];
  private readonly posts = new Map<string, string>();
  private readonly batches = new Map<string, string[]>();
  private readonly channels = new Set<string>();
  private faults: FakeVercelBoardFault[] = [];
  /** The profile the request being served writes as; null is the principal itself. */
  private profile: string | null = "scout";
  /** The profiles a request may name, as the connection's role list does. */
  readonly profiles = new Set(["scout", "builder", "reviewer"]);
  now: () => number;

  constructor(options: { principal?: string; token?: string; now?: () => number } = {}) {
    this.principal = options.principal ?? "local:user:operator";
    this.token = options.token ?? "test-token-123456";
    this.now = options.now ?? Date.now;
  }

  fault(fault: FakeVercelBoardFault): void { this.faults.push(fault); }

  /**
   * Write as someone else, outside Scout. `from` marks a sync import (the
   * provider's key, as Board sets it), and `by` names the author outright.
   */
  createTask(input: { channel: string; text: string; owner?: string; needs?: string[]; for?: string; as?: string | null; labels?: Record<string, string>; from?: string; by?: string }): string {
    const previous = this.profile;
    this.profile = input.as === undefined ? "scout" : input.as;
    try {
      const message = this.makeTask(input.channel, input.text, { ...input.labels }, input.needs ?? [], input.owner ?? this.principal, null, input.for ?? null, { from: input.from, by: input.by });
      return message.id;
    } finally { this.profile = previous; }
  }
  /** Another worker claims a task. */
  claimAs(id: string, actor: string, leaseSeconds = 300): { epoch: number; token: string } {
    const message = this.messages.get(id)!;
    this.expire(message);
    const task = message.task!;
    if (task.state !== "ready") throw new Error(`fake: ${id} is ${task.state}`);
    task.epoch += 1;
    const token = `tok-${id}-${task.epoch}-${Math.random().toString(36).slice(2)}`;
    task.claim = { actor, until: this.now() + leaseSeconds * 1000, token };
    task.state = "claimed";
    this.bump(message, "task.claimed", { id, epoch: task.epoch, until: new Date(task.claim.until).toISOString(), by: this.author(actor) });
    return { epoch: task.epoch, token };
  }
  /** Edit a root as someone other than its owner: Board blocks the task, kind `edited`, and the claim ends. */
  editAsOther(id: string, text: string): void {
    const message = this.messages.get(id)!;
    message.text = text;
    message.task!.state = "blocked";
    message.task!.blocked = { kind: "edited", reason: "edited by someone else" };
    message.task!.claim = null;
    this.bump(message, "message.edited", { id, text });
    this.bump(message, "task.blocked", { id, kind: "edited", reason: "edited by someone else", by: this.author("local:user:teammate") });
  }
  deleteRoot(id: string): void {
    const message = this.messages.get(id)!;
    message.deleted = true;
    message.text = "";
    message.task!.state = "canceled";
    message.task!.reason = "deleted";
    message.task!.claim = null;
    this.bump(message, "message.deleted", { id });
    this.bump(message, "task.canceled", { id, reason: "deleted" });
  }
  /** A reply in a thread, as someone outside Scout. */
  replyAs(re: string, text: string, actor = "local:user:teammate"): string {
    const parent = this.messages.get(re)!;
    const id = this.nextId();
    const message: Message = { id, channel: parent.channel, text, re: parent.re ?? parent.id, labels: {}, deleted: false, createdAt: new Date(this.now()).toISOString(), version: Number(id), revision: 1, by: this.author(actor) };
    this.messages.set(id, message);
    this.events.push({ seq: Number(id), type: "message.posted", channel: message.channel, payload: { id, channel: message.channel, by: message.by, noSync: false }, messageId: id, snapshot: this.view(message) });
    return id;
  }
  /** Edit a reply in place, as its author. */
  editReply(id: string, text: string): void {
    const message = this.messages.get(id)!;
    message.text = text;
    message.editedAt = new Date(this.now()).toISOString();
    this.bump(message, "message.edited", { id, text });
  }
  /** Drop the oldest events: a cursor before the floor is rejected. */
  truncateFeed(): void { this.floor = this.seq; }
  task(id: string): (Task & { id: string; text: string }) | undefined {
    const message = this.messages.get(id);
    if (!message?.task) return undefined;
    this.expire(message);
    return { ...message.task, id, text: message.text };
  }
  message(id: string): Message | undefined { return this.messages.get(id); }
  taskIds(): string[] { return [...this.messages.values()].filter(message => message.task).map(message => message.id); }
  count(method: string, pathPrefix: string): number { return this.requests.filter(request => request.method === method && request.path.startsWith(pathPrefix)).length; }

  private nextId(): string { return String(++this.seq); }
  private actor(): { actor: string; principal: string; profile: string | null } {
    return this.profile === null ? { actor: this.principal, principal: this.principal, profile: null } : { actor: `${this.principal}+${this.profile}`, principal: this.principal, profile: this.profile };
  }
  /** Another worker claims and completes a task with its own result. */
  completeAs(id: string, actor: string, result: string): void {
    const grant = this.claimAs(id, actor);
    const message = this.messages.get(id)!;
    const task = message.task!;
    if (task.epoch !== grant.epoch) throw new Error("fake: claim moved");
    task.claim = null; task.state = "completed"; task.result = result;
    this.bump(message, "task.completed", { id, epoch: task.epoch, result, by: this.author(actor) });
    this.readyDependents(id);
  }
  /** Cancel a task outside Scout, ending any claim. */
  cancel(id: string, reason?: string): void {
    const message = this.messages.get(id)!;
    const task = message.task!;
    task.state = "canceled"; task.claim = null; task.reason = reason ?? null;
    this.bump(message, "task.canceled", { id, epoch: task.epoch, ...(reason ? { reason } : {}) });
  }
  /** The operator lifts a hold on the board, as the principal: the task is ready again, or waiting on its needs. */
  liftHold(id: string): void {
    const message = this.messages.get(id)!;
    const task = message.task!;
    if (task.state !== "blocked") throw new Error("fake: not blocked");
    const open = task.needs.filter(need => this.messages.get(need)?.task?.state !== "completed");
    task.state = open.length ? "waiting" : "ready"; task.blocked = null;
    this.profile = null;
    this.bump(message, "task.unblocked", { id, epoch: task.epoch, by: this.actor() });
  }
  /** Reserve a task for one of its owner's actors, as `assign` does. */
  assign(id: string, actor: string | null): void { this.messages.get(id)!.task!.for = actor; }
  private author(actor: string): { actor: string; principal: string; profile: string | null } {
    const [principal, profile] = actor.split("+");
    return { actor, principal: principal!, profile: profile ?? null };
  }

  private bump(message: Message, type: string, payload: Record<string, unknown>): void {
    message.version = ++this.seq;
    message.revision += 1;
    this.events.push({ seq: message.version, type, channel: message.channel, payload, messageId: message.id, snapshot: this.view(message) });
  }

  private makeTask(channel: string, text: string, labels: Record<string, string>, needs: string[], owner: string, clientId: string | null, forActor: string | null = null, extra: { from?: string; by?: string } = {}): Message {
    this.channels.add(channel);
    const id = this.nextId();
    const open = needs.filter(need => this.messages.get(need)?.task?.state !== "completed");
    const message: Message = {
      id, channel, text, re: null, labels, deleted: false, createdAt: new Date(this.now()).toISOString(), version: Number(id), revision: 1,
      ...(extra.from ? { from: extra.from } : {}),
      by: extra.by ? this.author(extra.by) : owner === this.principal ? this.actor() : { actor: owner, principal: owner, profile: null },
      task: { state: open.length ? "waiting" : "ready", owner, by: owner, for: forActor, needs, epoch: 0, claim: null, blocked: null, result: null, reason: null },
    };
    this.messages.set(id, message);
    this.events.push({ seq: Number(id), type: "task.created", channel, payload: { id, needs, for: forActor, by: message.by }, messageId: id, snapshot: this.view(message) });
    if (clientId) this.posts.set(clientId, id);
    return message;
  }

  private expire(message: Message): void {
    const task = message.task;
    if (task?.state === "claimed" && task.claim && task.claim.until <= this.now()) {
      const epoch = task.epoch;
      task.state = "ready";
      task.claim = null;
      this.bump(message, "task.expired", { id: message.id, epoch });
    }
  }

  private readyDependents(id: string): void {
    for (const message of this.messages.values()) {
      const task = message.task;
      if (task?.state === "waiting" && task.needs.includes(id) && task.needs.every(need => this.messages.get(need)?.task?.state === "completed")) {
        task.state = "ready";
        this.bump(message, "task.ready", { id: message.id });
      }
    }
  }

  private view(message: Message): unknown {
    const { task, ...rest } = message;
    if (!task) return { ...rest };
    const { claim, ...taskRest } = task;
    // A view never carries a token.
    return { ...rest, task: { ...taskRest, claim: claim ? { actor: claim.actor, until: new Date(claim.until).toISOString() } : null } };
  }

  private takeFault(route: string): FakeVercelBoardFault | undefined {
    const index = this.faults.findIndex(fault => fault.route === route);
    if (index < 0) return undefined;
    const fault = this.faults[index]!;
    if ((fault.times ?? 1) <= 1) this.faults.splice(index, 1);
    else fault.times = (fault.times ?? 1) - 1;
    return fault;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/board/, "");
    this.requests.push({ method, path, headers, ...(body !== undefined ? { body } : {}) });
    const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...extra } });
    const error = (status: number, code: string, message = code, extra: Record<string, string> = {}) => json(status, { error: { code, message } }, extra);
    if (headers.authorization !== `Bearer ${this.token}`) return error(401, "unauthorized");
    const profile = headers["x-board-profile"] ?? null;
    if (profile !== null && !this.profiles.has(profile)) return error(400, "invalid_profile");
    this.profile = profile;
    if (!headers["x-board-can"]) return error(400, "invalid_scope", "Scout always narrows");
    const route = `${method} ${path.replace(/\/[^/]+\/(claim|renew|complete|fail|release|block|unblock|labels)$/, "/:id/$1").replace(/^\/(messages|posts|tasks\/batch)\/[^/]+$/, "/$1/:id")}`;
    const fault = this.takeFault(route);
    if (fault?.mode === "status") return error(fault.status, fault.code, fault.code, fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
    if (fault?.mode === "fail_before") throw new TypeError("fetch failed");
    const answer = this.route(method, path, url.searchParams, body, json, error);
    if (fault?.mode === "drop_answer") throw new TypeError("fetch failed");
    return answer;
  };

  private route(method: string, path: string, query: URLSearchParams, body: any, json: (s: number, v: unknown) => Response, error: (s: number, c: string, m?: string) => Response): Response {
    for (const message of this.messages.values()) this.expire(message);
    if (method === "GET" && path === "/me") return json(200, { ...this.actor(), expiresAt: null });
    if (method === "POST" && path === "/channels") { this.channels.add(body.path); return json(201, { channel: body.path }); }
    if (method === "GET" && path === "/channels") {
      const counts = new Map<string, number>();
      for (const message of this.messages.values()) counts.set(message.channel, (counts.get(message.channel) ?? 0) + 1);
      return json(200, { channels: [...this.channels].sort().map(channel => ({ path: channel, messages: counts.get(channel) ?? 0 })), cursor: "", next: null });
    }
    if (method === "GET" && path === "/events") {
      const channel = query.get("channel");
      const afterRaw = query.get("after");
      if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || Number(afterRaw) < this.floor)) return error(400, "invalid_cursor");
      if (afterRaw === null) return json(200, { events: [], cursor: String(this.seq) });
      const after = Number(afterRaw);
      const matched = this.events.filter(event => event.seq > after && (!channel || event.channel === channel)).slice(0, 200);
      return json(200, {
        events: matched.map(event => ({ cursor: String(event.seq), type: event.type, createdAt: new Date(this.now()).toISOString(), payload: event.payload, ...(event.snapshot ? { message: event.snapshot } : {}) })),
        cursor: String(matched.length === 200 ? matched[matched.length - 1]!.seq : this.seq),
      });
    }
    if (method === "GET" && path === "/tasks") {
      const channel = query.get("channel");
      const after = Number(query.get("after") ?? 0);
      const list = [...this.messages.values()].filter(message => message.task && (!channel || message.channel === channel) && Number(message.id) > after).sort((a, b) => Number(a.id) - Number(b.id));
      const page = list.slice(0, 2);
      return json(200, { tasks: page.map(message => ({ message: this.view(message), replies: 0, last: null })), cursor: page.length ? page[page.length - 1]!.id : null });
    }
    if (method === "GET" && path === "/messages") {
      const channel = query.get("channel");
      if (!channel) return error(400, "invalid_request");
      const limit = Math.min(Number(query.get("limit") ?? 50), 500);
      const after = query.get("after");
      const all = [...this.messages.values()].filter(message => message.channel === channel).sort((a, b) => Number(a.id) - Number(b.id));
      const page = after === null ? all.slice(-limit) : all.filter(message => Number(message.id) > Number(after)).slice(0, limit);
      return json(200, { messages: page.map(message => this.view(message)), cursor: page.length ? page[page.length - 1]!.id : (after ?? "0") });
    }
    let match = path.match(/^\/messages\/([^/]+)$/);
    if (method === "GET" && match) {
      const message = this.messages.get(decodeURIComponent(match[1]!));
      return message ? json(200, { message: this.view(message), replies: [] }) : error(404, "message_not_found");
    }
    match = path.match(/^\/posts\/([^/]+)$/);
    if (method === "GET" && match) {
      const id = this.posts.get(decodeURIComponent(match[1]!));
      return id ? json(200, { message: this.view(this.messages.get(id)!) }) : error(404, "post_not_found");
    }
    if (method === "POST" && path === "/messages") {
      const existing = body.id ? this.posts.get(body.id) : undefined;
      if (existing) return json(200, { message: this.view(this.messages.get(existing)!) });
      const parent = body.re ? this.messages.get(body.re) : undefined;
      const channel = parent?.channel ?? body.channel;
      this.channels.add(channel);
      const id = this.nextId();
      const message: Message = { id, channel, text: body.text, re: parent?.id ?? null, labels: body.labels ?? {}, deleted: false, createdAt: new Date(this.now()).toISOString(), version: Number(id), revision: 1, by: this.actor() };
      this.messages.set(id, message);
      this.events.push({ seq: Number(id), type: "message.posted", channel, payload: { id, channel }, messageId: id, snapshot: this.view(message) });
      if (body.id) this.posts.set(body.id, id);
      return json(201, { message: this.view(message) });
    }
    match = path.match(/^\/messages\/([^/]+)\/labels$/);
    if (method === "POST" && match) {
      const message = this.messages.get(decodeURIComponent(match[1]!));
      if (!message) return error(404, "message_not_found");
      for (const [key, expected] of Object.entries((body.if ?? {}) as Record<string, string | null>)) {
        if ((message.labels[key] ?? null) !== expected) return error(409, "label_conflict");
      }
      Object.assign(message.labels, body.set ?? {});
      for (const key of body.unset ?? []) delete message.labels[key];
      this.bump(message, "labels.changed", { id: message.id, set: body.set ?? {}, unset: body.unset ?? [] });
      return json(200, { message: this.view(message) });
    }
    if (method === "POST" && path === "/tasks") {
      const existing = body.id ? this.posts.get(body.id) : undefined;
      if (existing) return json(200, { task: this.view(this.messages.get(existing)!) });
      const message = this.makeTask(body.channel, body.text, body.labels ?? {}, body.needs ?? [], this.principal, body.id ?? null);
      return json(201, { task: this.view(message) });
    }
    if (method === "POST" && path === "/tasks/batch") {
      const existing = this.batches.get(body.id);
      if (existing) return json(200, { tasks: existing.map(id => this.view(this.messages.get(id)!)) });
      const byKey = new Map<string, string>();
      const ids: string[] = [];
      for (const task of body.tasks as { key?: string; text: string; labels?: Record<string, string>; needs?: (string | { key: string })[]; for?: string }[]) {
        if (task.for !== undefined && !task.for.startsWith(`${this.principal}+`)) return error(400, "invalid_request", `for: a task is assigned to one of its owner's profiles, ${this.principal}+<profile>, got ${task.for}`);
        const needs = (task.needs ?? []).map(need => typeof need === "string" ? need : byKey.get(need.key)!);
        const message = this.makeTask(body.channel, task.text, task.labels ?? {}, needs, this.principal, null, task.for ?? null);
        if (task.key) byKey.set(task.key, message.id);
        ids.push(message.id);
      }
      this.batches.set(body.id, ids);
      return json(201, { tasks: ids.map(id => this.view(this.messages.get(id)!)) });
    }
    match = path.match(/^\/tasks\/batch\/([^/]+)$/);
    if (method === "GET" && match) {
      const ids = this.batches.get(decodeURIComponent(match[1]!));
      return ids ? json(200, { tasks: ids.map(id => this.view(this.messages.get(id)!)) }) : error(404, "batch_not_found");
    }
    match = path.match(/^\/tasks\/([^/]+)\/unblock$/);
    if (method === "POST" && match) {
      const message = this.messages.get(decodeURIComponent(match[1]!));
      const task = message?.task;
      if (!message || !task) return error(404, "not_found");
      // The owner is the principal; a profile owns only what it made itself.
      if (this.profile !== null) return error(403, "forbidden", "Only the task's owner, or manage, lifts a hold.");
      if (task.state !== "blocked") return error(409, "task_not_blocked");
      const open = task.needs.filter(need => this.messages.get(need)?.task?.state !== "completed");
      task.state = open.length ? "waiting" : "ready"; task.blocked = null;
      this.bump(message, "task.unblocked", { id: message.id, epoch: task.epoch, by: this.actor() });
      return json(200, { task: this.view(message) });
    }
    match = path.match(/^\/tasks\/([^/]+)\/(claim|renew|complete|fail|release|block)$/);
    if (method === "POST" && match) {
      const message = this.messages.get(decodeURIComponent(match[1]!));
      const task = message?.task;
      if (!message || !task) return error(404, "not_a_task");
      const verb = match[2]!;
      if (verb === "claim") {
        if (task.state === "claimed") return error(409, "task_claimed");
        if (task.for && task.for !== this.actor().actor) return error(409, "task_assigned", `#${message.id} is assigned to ${task.for}`);
        if (task.state !== "ready") return error(409, task.state === "completed" || task.state === "failed" || task.state === "canceled" ? "task_finished" : "task_not_ready");
        const lease = Math.min(Number(body?.lease ?? 900), 3600);
        task.epoch += 1;
        const token = `tok-${message.id}-${task.epoch}-${Math.random().toString(36).slice(2)}`;
        task.claim = { actor: this.actor().actor, until: this.now() + lease * 1000, token };
        task.state = "claimed";
        this.bump(message, "task.claimed", { id: message.id, epoch: task.epoch, by: this.actor() });
        return json(200, { task: this.view(message), claim: { epoch: task.epoch, token, until: new Date(task.claim.until).toISOString() } });
      }
      if (task.state !== "claimed" || !task.claim || task.epoch !== body.epoch || task.claim.token !== body.token) return error(409, "claim_lost");
      if (verb === "renew") {
        task.claim.until = this.now() + Math.min(Number(body.lease ?? 900), 3600) * 1000;
        this.bump(message, "task.renewed", { id: message.id, epoch: task.epoch });
        return json(200, { task: this.view(message), until: new Date(task.claim.until).toISOString() });
      }
      task.claim = null;
      if (verb === "complete") { task.state = "completed"; task.result = body.result ?? null; this.bump(message, "task.completed", { id: message.id, epoch: task.epoch, result: task.result, by: this.actor() }); this.readyDependents(message.id); }
      else if (verb === "fail") { task.state = "failed"; task.reason = body.reason; this.bump(message, "task.failed", { id: message.id, epoch: task.epoch, reason: body.reason, by: this.actor() }); }
      else if (verb === "block") {
        task.state = "blocked"; task.blocked = { kind: body.kind ?? "needs_input", reason: body.reason };
        this.bump(message, "task.blocked", { id: message.id, epoch: task.epoch, kind: body.kind, reason: body.reason, by: this.actor() });
      }
      else { task.state = "ready"; this.bump(message, "task.released", { id: message.id, epoch: task.epoch, by: this.actor() }); }
      return json(200, { task: this.view(message) });
    }
    return error(404, "not_found", `${method} ${path}`);
  }
}
