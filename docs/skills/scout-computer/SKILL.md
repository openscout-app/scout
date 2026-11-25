---
name: scout-computer
description: Default Scout Computer skill covering both browser automation/introspection and native desktop control. Use Scout directly instead of Lattices action-browser: prioritizes Scout's Chrome Companion plugin and managed Chrome profiles, falls back to external browser adapters (browser-use), and uses native desktop control for macOS apps or regular Chrome.
---

# Scout Computer (Browser + Desktop)

Use Scout directly for browser and desktop work under one lease, origin-scope,
secret-cutoff, and receipt boundary.

## Browser surface (default for web tasks)

Use Scout's `browser_*` MCP tools or `scout browser ...` CLI first whenever
the task is on a web page:

1. **`scout-companion`** (preferred when connected): Scout's MV3 Browser
   Companion extension (Chrome and Safari) over the local bridge
   (`ws://127.0.0.1:4321/browser-companion`) for live DOM/page introspection
   and targeted actions.
2. **`scout-native`**: Scout-owned non-headless Chrome identities under
   `~/Library/Application Support/Scout/ChromeProfiles/<name>` (with
   compatibility for existing `Action/ChromeProfiles/<name>` identities), full
   CDP control, and domain-allowlisted cookie seeding.
3. **`scout-safari`**: Direct macOS Safari tab control and DOM inspection
   (AppleScript / `do JavaScript` or paired Safari Web Extension).
4. **`browser-use`** (first external adapter): Wraps the `browser-use` CLI
   behind Scout's lease, origin allow-list, and receipt contract.

```text
browser_status                          # check companion, profiles, external adapters
browser_profiles                        # list managed Chrome identities
browser_open       { url, profile? }    # open URL (scout-companion -> scout-native -> browser-use)
browser_snapshot                        # inspect DOM/accessibility before acting
browser_click      { selector }
browser_fill       { selector, text }
browser_screenshot                      # capture visual confirmation
browser_close      { scope }
```

CLI equivalent:

```bash
scout browser status
scout browser profiles
scout browser open https://example.com --allow-origin https://example.com
scout browser snapshot
scout browser run "verify the header renders cleanly" --adapter browser-use
```

## Native desktop surface

Drop to Scout Computer's native screen/accessibility surface when:

- The task is in a native macOS app, or
- The user wants an action inside their regular Chrome profile where passkeys,
  SSO device trust, or extension state prevent using a seeded managed identity
  (`browser_open { mode: "regular" }` is open-only).

## Trust rules

- **Observe before acting**: Always take a snapshot or screenshot before
  clicking or filling unfamiliar controls.
- **Single driver**: One lease at a time across browser and desktop.
- **Origin allow-lists & secret cutoff**: Pass `allowOrigins` when driving
  authenticated flows and stop automated observation before any
  secret-revealing action.
