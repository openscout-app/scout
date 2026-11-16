# Harness locations and setup

Map reviewed against Scout core's adapter exports, harness catalog, auth models,
setup targets and model-preference readers on 2026-11-10. These are candidates,
not proof that a particular installed version uses them. On other platforms,
read the native tool's help/config discovery rather than guessing translated
paths. Expand `~` for the target OS user, not the agent process by assumption.

## Start with installed Scout facts

Use `scout runtimes --json` for configured harnesses, readiness, models and
efforts. Version and native auth/status checks should not submit prompts. The
catalog can include a harness without its binary or login being present.

| Harness / adapter | Binary and config/auth candidates | What to inspect / setup owner |
| --- | --- | --- |
| Claude Code / `claude-code` | `claude`; `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`; user/project settings and profile overrides; default `~/.claude/.credentials.json`; native OS credential storage | Read model, statusline and connection metadata only. Auth remains Claude-owned. Scout's auth model lists native login as `claude login`; confirm the installed command's help. Credential helpers are settings, not permission to execute them during discovery. |
| Codex | `codex`; explicit operator source `OPENSCOUT_CODEX_HOME_SOURCE`, then interactive `CODEX_HOME`, normally `~/.codex`; `config.toml`, `auth.json`, `models_cache.json` | Read model, model_reasoning_effort, named profiles and MCP server metadata. Auth owner: `codex login` after inspecting help. Scout background Codex homes are not the operator's home; do not overwrite or merge them. Do not scan session logs for setup. |
| Grok / Grok ACP | `grok`; default `~/.grok/auth.json`; `grok --help`, `grok models` | Both transports share xAI/native login. `grok login` owns auth. A model list is not a quota reading. Scout can already have normalized observations from native billing telemetry; do not dump `~/.grok/logs/unified.jsonl` or sessions. |
| Kimi Code / Kimi ACP | `kimi`; `${KIMI_CODE_HOME:-~/.kimi-code}/config.toml`; `credentials/`; legacy `~/.kimi/credentials/kimi-code.json` only when no KIMI_CODE_HOME override | Inspect managed provider base_url, default_model, models and the OAuth key reference, never token values. Prefer `[providers."managed:kimi-code"]`, else the first provider of type kimi. Strip `oauth/` from its key and allow only safe filename characters to locate `credentials/<key>.json`; then `credentials/kimi-code.json`. Region determines the account endpoint. Native login: `kimi login`. |
| OpenCode / ACP | `opencode`; default `~/.config/opencode/opencode.json` and project `opencode.json`; `~/.local/share/opencode/auth.json`; `${XDG_STATE_HOME:-~/.local/state}/opencode/model.json` | Project/global configuration and provider-qualified favorites/recent models are distinct. `opencode auth list` shows auth sources; `opencode models` shows IDs. `opencode auth login` owns setup. The native auth file can outrank injected environment keys. Check active native XDG overrides; Scout's account collector currently reads the default auth path. |
| OpenCode V2 | A separately registered V2 service with explicit URL/configuration | Source has an `opencode-v2` adapter, but `opencode2` is not an alias for the routable `opencode` harness. Inspect the registered service and its protocol/API. Do not silently point the V1 ACP adapter at it or claim execution readiness from source support. |
| Cursor ACP | `cursor-agent`; `cursor-agent status --format json`; CURSOR_API_KEY / SCOUT_CURSOR_API_KEY presence; default desktop membership DB candidates below | Prefer native status. Native login: `cursor-agent login`. ACP uses the CLI's auth. Cursor membership and personal credit access are different. Do not extract cookies or auth tokens from the desktop/browser databases. |
| Devin ACP | `devin`; `~/.local/share/devin/credentials.toml`; WINDSURF_API_KEY presence | Native login: `devin auth login`. Scout's adapter has native auth constraints; verify them in runtime readiness. Do not copy machine-local OAuth credentials to another host. |
| Pi / Pi RPC | `pi`; PI_CODING_AGENT_DIR if set, normally `~/.pi/agent`; `auth.json`; provider settings/extensions | Native Pi owns `/login`, provider extensions and model setup. Record the provider as well as the model. Scout supports provider-specific environment mappings, including MiniMax and xAI. Do not run `pi -p` as an inventory check: it submits an inference request. |
| Flue | `flue`; explicit registered runtime configuration; provider env names in accounts reference | The catalog's Flue entry is not evidence of a standard auth file or installer. No default auth directory is established by Scout's collector. Inspect the installed tool/configuration; do not invent one or install an unrelated similarly named package. |
| OpenClaw ACP | `openclaw` or explicit OPENSCOUT_OPENCLAW_BIN; registered Gateway/agent configuration and credential-file references | OpenClaw owns authentication, models and tool policy. This adapter rejects Scout per-session model/effort/MCP overrides. Inspect native config discovery; do not invent a default Gateway path. Use token/password files or native credential storage, never inline credential arguments. |
| Generic ACP | Explicit command, arguments and transport configuration | No universal auth file. Inspect the registered adapter and underlying tool. Avoid dumping command arguments: they may contain existing secrets. |
| OpenAI-compatible API | Explicit baseUrl, model and local credential source in adapter configuration | An API adapter, not a logged-in coding agent or universal ChatGPT subscription. Endpoint/model existence does not prove tool support or funded access. Inventory without calling `/chat/completions`. |
| Echo | Test adapter | No user account or billing setup. Do not count it as a connected model provider. |

Cursor membership candidates used by Scout's account collector:

- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`.
- Linux candidate: `~/.config/Cursor/User/globalStorage/state.vscdb`.

Treat these as native databases, not text files. If investigation requires a
read, use read-only database access and select only membership/status fields.
Do not copy or repair a live DB to obtain billing access. No Windows DB path is
claimed by this map.

## Scout connections and skills

Inspect existing native MCP server declarations and their scopes before adding
Scout. Project-local `.mcp.json`, agent configuration and MCP env sections can
contain credentials; report connection names and transport type only. Prefer
`scout mcp`'s supported installation/dry-run flow to hand-editing these files.
For attached app-server/native sessions, the existing server owns its auth and
configuration; an environment change in this shell does not reconfigure it.

Scout's current setup installs its communication skill to these locations:

| Tool | Scout communication skill target |
| --- | --- |
| Claude | `~/.claude/skills/scout/SKILL.md` |
| Codex / shared agents | `~/.agents/skills/scout/SKILL.md` |
| Grok | `~/.grok/skills/scout/SKILL.md` |
| Pi | `~/.pi/agent/skills/scout/SKILL.md` |
| OpenCode | `~/.config/opencode/skills/scout/SKILL.md` |

Those are installer targets, not proof every profile loads them. Codex's older
`~/.codex/skills` may contain existing installations; distinguish legacy copies
from the active shared root. This separate `scout-inventory` skill is not
currently installed by `scout setup`. Install its complete directory into the
main agent's supported skill root when requested; copying SKILL.md alone loses
these references. Do not mass-install it into every worker just to run inventory.

Runtime records and native config are different authorities. Prefer supported
Scout APIs/commands for Scout records; never rewrite another tool's topology,
team state, transcript or auth caches from an adapter. Registered external
participants such as hosted services or terminal hosts may be observable without
being executable harnesses. Verify their actual capabilities rather than giving
them a guessed harness alias.

Source landmarks: `packages/runtime/src/harness-catalog.ts`,
`packages/runtime/src/setup.ts`, `packages/runtime/src/harness-model-preferences.ts`,
`packages/agent-sessions/src/auth/domains.ts`, and adapter factories under
`packages/agent-sessions/src/adapters/`. Where source and installed behavior
conflict, report the version/scope mismatch instead of calling setup complete.
