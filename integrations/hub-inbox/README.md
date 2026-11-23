# Scout Hub inbox

Scout Hub brings agent sessions that run in a vendor's cloud, such as Claude Code on the web, into your Scout runtime. A reporter in the sandbox seals new transcript bytes to your runtime's public key and posts them here. Your runtime collects them, opens them, and appends them to local copies that Scout reads like any other session.

This inbox is a Cloudflare Worker over one R2 bucket. It holds sealed bytes and cannot read them. It deletes each chunk when your runtime collects it, and deletes anything left after seven days. One deployment serves one runtime.

## API

| Request | Token | Does |
| --- | --- | --- |
| `POST /v1/inbox/chunks` | write | Adds one sealed chunk (the body). |
| `GET /v1/inbox/pending?after=&limit=` | read | Lists chunks, oldest first. |
| `GET /v1/inbox/chunks/:key` | read | Returns one chunk. |
| `DELETE /v1/inbox/chunks/:key` | read | Deletes one chunk after it is collected. |
| `GET /v1/inbox/health` | read | Returns `{ ok, pending }`. |

The write token can only add chunks. It goes into repos, inside `.claude/scout/hub.json`. The read token stays on your machine.

## Set up

1. Make the runtime's key and tokens:

   ```sh
   scout hub init --inbox https://scout-hub-inbox.<your-subdomain>.workers.dev
   ```

2. Deploy the inbox from this folder, using the tokens that `init` printed:

   ```sh
   bunx wrangler@4 r2 bucket create scout-hub-inbox
   bunx wrangler@4 deploy
   printf %s '<read token>'  | bunx wrangler@4 secret put READ_TOKEN
   printf %s '<write token>' | bunx wrangler@4 secret put WRITE_TOKEN
   ```

3. Connect a repo, then review, commit and push what it writes:

   ```sh
   scout hub connect claude-code ~/dev/my-repo
   ```

4. Start a Claude Code cloud session on that repo. `scout hub status` shows what is waiting and what has been mirrored.

## Run it locally

```sh
READ_TOKEN=r WRITE_TOKEN=w bun src/serve-local.ts 8787
bun test src
```

`src/end-to-end.test.ts` runs the reporter under Node the way a hook does, sends to this Worker, and checks that the collector rebuilds the transcript byte for byte.

## What it does not do yet

- A chunk is sealed, not signed. The runtime's public key and the write token are in the repo, so anyone who can read the repo can add chunks. The runtime accepts a chunk only if its path matches Claude's own layout, and it only appends.
- There is one inbox per runtime and no per-repo tokens.
