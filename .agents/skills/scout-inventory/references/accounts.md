# Provider and account locations

Map reviewed 2026-11-10 against Scout's core credential domain definitions and
account-status collectors. Read only the relevant section. Default file paths
can differ from an explicitly selected profile or native XDG override. Record
that mismatch; do not make a duplicate login just to satisfy a default-path probe.

## Subscriptions and account status

Use the existing Scout account/status reading when available. Core readiness
and private app account collection are separate capabilities. Do not claim a
provider's billing adapter exists merely because a harness accepts its API key.
The installed app may predate these collectors; verify its version/capabilities.

| Account | Discovery / reading | Limits and correct setup action |
| --- | --- | --- |
| Claude subscription | Native Claude auth and settings; Scout's normalized statusline quota observations | Statusline capture only receives fresh quota when native Claude reports it. Preserve an existing statusline delegate. A configured capture is not a new usage reading; do not run a paid prompt to freshen it. |
| Codex subscription | Operator's Codex auth/config scope; existing normalized rate-limit windows | A shared vendor API key is not proof of ChatGPT subscription quota. Keep pool/window scope and capture time. Use Scout observations rather than scanning transcripts. |
| Kimi Code | Config/region/OAuth-key references in harness map; account adapter reads `<configured coding base>/usages` | Match usage and reset from the same window. Seven-day reset is the headline. OAuth refresh/login belongs to Kimi, not an inventory repair. |
| Grok subscription | Native Grok sign-in; normalized native billing observations or an explicitly imported dashboard snapshot | SuperGrok allowance is distinct from xAI API billing. Retain capture time and stale/unknown status. |
| Cursor | Native CLI status or local membership metadata; explicit usage CSV/table import if the app supports it | Personal remaining credits are not established by CLI sign-in, exported spending totals or a team-admin key. Dashboard sign-in may be necessary. Ask for the minimum missing account interaction; do not request a whole browser profile or cookie export. |
| MiniMax Token Plan | MINIMAX_API_KEY or MINIMAX_TOKEN; Scout's supported Pi/secret-store mapping; account adapter's `/v1/token_plan/remains` | Token Plan five-hour and weekly windows are distinct from API wallet credit. Existing adapter uses `https://www.minimax.io/v1/token_plan/remains`; never probe inference to check the key. |
| OpenRouter | OPENROUTER_API_KEY / SCOUT_OPENROUTER_API_KEY, or native OpenCode auth entry `openrouter` | Existing adapter uses `GET https://openrouter.ai/api/v1/credits`. Account credits minus usage is distinct from `/api/v1/key` spending caps. A null key limit is not unlimited account credit; preserve negative balances. |
| Hugging Face | HF_TOKEN / HUGGINGFACE_HUB_TOKEN / HF_INFERENCE_TOKEN; default `~/.cache/huggingface/token` | Existing adapter verifies membership with `GET https://huggingface.co/api/whoami-v2`. PRO status does not establish remaining compute credit. Native HF_HOME/token-path overrides may be active even though this collector reads the default file; report them without token values. |
| OpenCode Console | `~/.local/share/opencode/auth.json` entry `opencode`; OPENCODE_API_KEY / SCOUT_OPENCODE_API_KEY | Credential/configuration presence only when no balance reading exists. Console access and billing stay with OpenCode. Model catalogs do not prove free external API access. |
| OpenCode Go | Same auth file, separate `opencode-go` entry; OPENCODE_GO / OPENCODE_GO_KEY | Separate plan/account from Console. Keep exact gateway model IDs, such as `opencode-go/<model>`. Do not infer quota or reset from Console credit. |
| OpenAI API | OPENAI_API_KEY | Separate from Codex subscription. Account collector currently proves configuration, not API wallet balance. |
| xAI API | XAI_API_KEY / SCOUT_XAI_API_KEY; OpenCode auth entry `xai` can have native OAuth state | Separate from SuperGrok. Presence of OAuth metadata is not a verified API balance. Do not refresh or migrate its tokens during discovery. |

When supported, credentials may be in the user's native secret manager rather
than this shell. Query names first. A synced index entry does not prove the
current host can retrieve the value. Check without printing it. Do not assume
a particular personal secret-manager command exists on all users' hosts.

## Other model credential domains

Scout core knows these credential names for inference/auth resolution. They do
**not** all have account-status or billing collectors. Inventory presence as
configuration only until a supported account read establishes more.

| Domain | Credential names / non-secret configuration |
| --- | --- |
| Anthropic | CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_REFRESH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN; inspect an explicit base-URL override without exposing headers/query secrets |
| Gemini | GEMINI_API_KEY |
| Kimi / Moonshot API | KIMI_API_KEY; separate from native Kimi Code OAuth |
| Groq | GROQ_API_KEY |
| Devin | WINDSURF_API_KEY; native Devin OAuth file is machine-local |
| Cerebras | CEREBRAS_API_KEY |
| Mistral | MISTRAL_API_KEY |
| Z.ai | ZAI_API_KEY |
| Vercel AI Gateway | AI_GATEWAY_API_KEY; separate from Vercel hosting auth |
| Amazon Bedrock | AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN; profile/region context matters |
| Azure OpenAI | AZURE_OPENAI_API_KEY; inspect configured endpoint/deployment separately, without treating an Azure key as a public OpenAI key |

The OpenAI-compatible adapter can use an explicitly configured endpoint and
model outside this list. Do not invent a named provider, billing collector or
standard credential directory for an arbitrary endpoint.

## Compute, hosting, code and service accounts

These are default presence/configuration probes used by the app. Their current
"Connected" label can be based on a file or config marker: it is not independent
proof of a valid token, current spend or live resource access. The main agent's
report must preserve that distinction. Do not dump these files to inspect them.

| Account | Default discovery candidates |
| --- | --- |
| EXE | `~/.scout/provider-accounts.json`, active `exe` declaration; native EXE/SSH configuration only when explicitly configured. This is declared configuration, not a live access check. Shelley model allocation at `https://exe.dev/user/shelley` is distinct from VM billing. |
| Cloudflare / Wrangler | `~/Library/Preferences/.wrangler/config/default.toml`, `~/.wrangler/config/default.toml`, `~/.config/.wrangler/config/default.toml`; oauth_token/api_token presence |
| Vercel hosting | `~/Library/Application Support/com.vercel.cli/config.json`, `~/.config/com.vercel.cli/config.json` currentTeam; `~/.local/share/com.vercel.cli/auth.json` presence |
| GitHub | `~/.config/gh/hosts.yml`; native `gh auth status` can verify sign-in. Existing rate-limit gauge reads `gh api rate_limit` core resource, not a coding-model allowance. |
| Fly.io | `~/.fly/config.yml`, access_token presence |
| Netlify | `~/Library/Preferences/netlify/config.json`, `~/.config/netlify/config.json`, `~/.netlify/config.json`, token presence |
| Railway | `~/.railway/config.json`, token presence |
| Render | `~/.render/cli.yaml` presence |
| AWS | `~/.aws/credentials`, `~/.aws/config`; profiles and region context remain distinct |
| Google Cloud | `~/.config/gcloud/credentials.db`, `~/.config/gcloud/application_default_credentials.json`; ADC and CLI identities can differ |
| DigitalOcean | `~/Library/Application Support/doctl/config.yaml`, `~/.config/doctl/config.yaml`, access-token presence |
| Hetzner | `~/.config/hcloud/cli.toml`, token presence |
| Slack and other integrations | Use Scout's connected integration/account metadata and workspace scope. Tokens belong to the connector; no universal local Slack credential path is assumed. |

Do not create these files to satisfy a presence probe. Prefer native CLI login
or an existing supported connector setup command within the user's request.
An existing EXE declaration is an observation; adding a claimed account to it
is not authentication or a substitute for an unsupported write API.

## Evidence receipt

For a balance/window, keep provider/account scope, amount or usage, unit,
source, captured-at time, reset-at time when applicable, and stale/unknown status.
Use null/unknown rather than zero for an unavailable reading. Dashboard imports
are snapshots, not live connections. Redact usernames and exact private paths
when sharing outside the user's workspace. No account evidence goes into the
public Scout model/taste JSON.

Source landmarks: core `packages/agent-sessions/src/auth/domains.ts`; app
account discovery, subscription collectors and provider-status adapters. These
references document existing behavior, not a requirement for the public core to
import app source. Refresh the map when an adapter or its credential precedence
changes; versioned source evidence wins over an old default-path table.
