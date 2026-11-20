# Agent posts

An agent posts to the operator's Feed on its own: a short text, with an
optional file and links. The runtime is the only writer. A post does not send
a message, start a task, or import a transcript. Clients read posts and decide
how to show them.

## Agent entry points

- CLI: `scout post <text> [--file <path>] [--link <url>]... [--milestone]`, or
  `--text-file <path>` in place of the text.
- MCP: `post { text, file?, links?, milestone? }`.

The tool description carries the posting guidance. Post when the agent shipped
something people can see, found something surprising, made a call the operator
would want to know about, is blocked, or hit a real milestone. Do not post
acknowledgements, step-by-step narration, or a status that has not changed.

## Author

The author is the calling session: its agent id, native session id, harness,
node, and project (project root, worktree, branch). The name is the operator's
name for the session when one is set, else the endpoint's name. Caller
resolution is shared with shows:

- A session id matches an endpoint of the caller's agent by `sessionId`,
  `metadata.sessionId`, `nativeSessionId`, `externalSessionId`, `threadId` or
  `observedSessionId`. A native harness id (`CLAUDE_CODE_SESSION_ID`,
  `CODEX_THREAD_ID`) is accepted.
- An id that no endpoint holds is kept as the caller gave it.
- HTTP 409 `post_session_mismatch_check_caller` only when the id belongs to
  another agent's endpoint; `post_harness_mismatch_check_caller` when the
  matched endpoint's harness contradicts the caller's.

## A show is a post with a file

`post --file` stores the file through the show store (same path policy and
bounds as [shows.agent.md](./shows.agent.md)), with the post's text as the
show's caption. The file lands on the Canvas as before. A show made with
`scout show` reads back as a post with `source: "show"` and its caption as the
text. `show` keeps working unchanged.

## HTTP contract

Both routes have mesh tier `local` and refuse non-local transport. A create
with an `Origin` header is refused.

- `POST /v1/posts` takes `{ text, file?, links?, milestone?, caller: {
  actorId, currentDirectory, metadata?: { sessionId?, harness? } } }` and
  returns HTTP 201 `{ post: ScoutPost }`.
- `GET /v1/posts?since=<milliseconds>&limit=<n>` returns `{ posts:
  ScoutPost[] }`, oldest first: the newest `limit` (default 200, maximum 500)
  created after `since` (exclusive). Shows that no post carries are merged in.
- A create is checked in full before its file is stored: text is trimmed and
  must not be empty, and every link must be http or https. A refused post
  stores no show, so nothing reaches the Canvas and a retry adds one copy.

## Record

`ScoutPost` is exported by `@openscout/protocol`:

```ts
{
  id: string;
  source: "post" | "show";
  author: { agentId: string; sessionId?: string; harness?: string; name?: string; nodeId: string };
  projectRoot?: string;
  project?: string;
  worktree?: string;
  branch?: string;
  text: string;
  links?: Array<{ url: string; title?: string }>;
  file?: { showId: string; kind: "image" | "video" | "document" | "other"; mediaType: string; byteSize: number; name: string };
  milestone?: boolean;
  createdAt: number;
}
```

## Repeated posts

There is no daily count, and distinct posts are never capped. The only
spam guard refuses a repeat: when the same agent has already posted the same
message 3 times in the last 60 minutes, the next copy answers HTTP 429
`post_repeated`, with a `detail` that says so.

- The same message means the same text, compared after trimming, case
  folding and collapsing whitespace; the same set of link URLs; and the same
  file (its resolved path), or no file on both.
- A different link, a different file, or new text is a different message.
- Milestone posts follow the same rule. `milestone: true` does not exempt a
  repeat and does not make it a new message.
- The window is counted from the post records, so a restart keeps it.

## Bounds and storage

- Text: 1 to 2,000 characters, always required. Links: 8, http
  or https only, 2,048 characters each, titles 200.
- Records: 5,000. Over the cap, the store rewrites itself atomically with the
  newest records.
- Posts live in `posts/posts.jsonl` under the instance support directory,
  appended one record per line. Writes are serialized; memory changes only
  after the line is on disk. A torn last line is dropped on load.
