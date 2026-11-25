# Crew Roles

Scout separates **what kind of seat a task needs** from **which vendor model currently fills that seat**.

Model names rotate every few months. Economic and behavioral postures stay stable: a high-ceiling seat that conserves tokens for architecture and review, a balanced lane owner that drives one stream end-to-end, an abundant worker pool that runs parallel implementation and test loops, and targeted specialist seats for deep systems verification, visual polish, or independent critique.

Scout core ships with **zero hardcoded vendor model names or fallback chains**. Out of the box, your crew configuration is empty (`roles: {}`, `presets: {}`). You bind roles to concrete `RuntimeSpec` values on your own machine—by hand or co-authored with `scout-inventory` from your live harness and quota inventory—and save them as a repeatable record.

## Built-in Slot Profiles

Scout documents six timeless slot profiles and accepts any custom role name you want to add:

| Slot | Economic & capability profile | Behavioral posture |
| --- | --- | --- |
| `architect` | Highest reasoning ceiling · scarce, premium tokens · single seat | Holds the system map, settles boundaries and contracts with the operator, cuts independent lanes, and reviews outcomes. Conserves turns and context; delegates mechanical edits and build loops. |
| `lane` | Strong judgment + high efficiency · one per active lane | Owns a coherent lane end-to-end, makes tactical calls within settled boundaries, and delegates volume to workers or targeted checks to specialists when warranted. |
| `worker` | Capable execution · low token cost / abundant quota · pool of N | Executes bounded implementation, refactors, test suites, and build-fix loops across isolated worktrees. Cost-effective enough to run in parallel. |
| `systems` | High-depth systems & verification · targeted bursts | Called in for complex runtime mechanics, process lifecycles, concurrency, package boundaries, and adversarial review. |
| `stylist` | High visual & editorial taste · targeted passes | Elevates visual hierarchy, typography, layout rhythm, and copy within the existing frame rather than spending turns on plumbing. |
| `advisor` | Second-opinion reasoning · targeted consults | Provides independent design critique, risk checks, and trade-off analysis without taking ownership of implementation. |

Custom slots (for example `qa`, `docs`, or `migrations`) work identically; they simply have no built-in posture description unless you add a `note`.

## File Layout & Layering

Crew bindings live in two optional JSON files:

1. **Global user record:** `~/.openscout/crew.json` (under `$OPENSCOUT_HOME` when set).
2. **Project override:** `<projectRoot>/.openscout/crew.json`.

Project overrides deep-merge per role on top of the global record:

- A project role can replace `runtime`, `fallback`, `pool`, `host`, or `note`.
- A project role that overrides an existing global role can omit `runtime` to inherit the global runtime while adjusting `pool`, `fallback`, `host`, or `note`.
- Symlinked `.openscout` directories or symlinked `crew.json` files inside a project are skipped and reported as warnings rather than followed.
- Malformed individual role or preset entries are ignored and reported without breaking valid sibling entries.
- Prototype-pollution keys (`__proto__`, `prototype`, `constructor`) are stripped.

### Schema

```json
{
  "version": 1,
  "activePreset": "balanced",
  "roles": {
    "architect": {
      "runtime": "<harness>/<model>",
      "note": "Boundaries, design decisions, and final review"
    },
    "worker": {
      "runtime": "<harness>/<model>",
      "fallback": ["<fallback-harness>/<model>"],
      "pool": 4
    },
    "systems": {
      "runtime": "<harness>/<model>/<effort>",
      "host": "build-host",
      "fallback": ["<local-harness>/<model>"]
    }
  },
  "presets": {
    "balanced": {
      "note": "Everyday mix across local harnesses",
      "roles": {
        "architect": { "runtime": "<harness>/<model>" },
        "worker": { "runtime": "<harness>/<model>", "pool": 4 }
      }
    }
  }
}
```

Each `runtime` and `fallback` entry uses Scout's `RuntimeSpec` grammar (`<harness>[/<model>[/<effort>]]`).

## Co-Authoring `crew.json` with `scout-inventory`

Rather than guessing which harnesses are installed or where your active subscription quota sits, inspect your machine first:

```bash
scout runtimes
scout providers usage
```

If you use the `scout-inventory` skill, your coding agent inspects the installed harnesses, authentication status, and live quota windows on your host, then proposes concrete `scout crew set` bindings that match each slot's economic profile. Once you approve the bindings, `crew.json` keeps them repeatable across sessions and repositories.

## Managing Crew Bindings (`scout crew`)

```bash
# Inspect configured roles, presets, built-in slot profiles, and any config warnings
scout crew list
scout crew list --json

# Bind a role globally
scout crew set worker <harness>/<model> --pool 4 --fallback <fallback-harness>/<model> --note "Parallel build and test loops"

# Override a role for the current project only
scout crew set worker <harness>/<model> --pool 6 --project

# Remove a role binding
scout crew unset worker --project

# Save and switch named presets
scout crew preset save sprint --note "High-throughput implementation pass"
scout crew preset list
scout crew preset use sprint

# Check every configured role and fallback rung against live local harnesses and reachable mesh hosts
scout crew check
scout crew check --json
```

## Asking by Role (`scout ask --role` and MCP `ask`)

Once a role is configured, ask by posture instead of remembering exact model strings:

```bash
scout ask --role worker "Run the package test suite and fix failing assertions"
scout ask --role systems --project ./packages/runtime "Audit shutdown race conditions"
```

Through MCP:

```json
{
  "role": "systems",
  "projectPath": ".",
  "body": "Review the concurrency boundary and report findings."
}
```

Resolution rules:

1. **Explicit `runtime` or `to` always takes precedence.** Passing `--runtime <spec>`, `--harness <name>`, `--profile <name>`, or `--to <target>` overrides `--role` without error.
2. **Live reachability gating.** When resolving a role, Scout checks whether the primary harness is installed and configured locally (and whether `host` answers on the mesh when `host` is set). If unavailable, Scout walks `fallback` in order and picks the first reachable rung.
3. **Actionable unconfigured errors.** Asking for an unconfigured role fails immediately with an error pointing to `scout crew set <role> <runtime>`.

## `whoami` Integration

Both `scout whoami` and the MCP `whoami` tool surface a compact `crew` summary when crew roles or an active seat are present:

- Only roles that currently resolve to an available local harness or reachable mesh target are advertised.
- When a session was launched with a role (`OPENSCOUT_CREW_ROLE`), `whoami` includes its `activeSeat` posture so the agent understands the token economics and behavioral expectations of its seat.
