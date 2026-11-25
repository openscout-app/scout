---
name: scout-browser
description: Drive and introspect Chrome through Scout Browser Use. Use as the default browser automation skill instead of Lattices action-browser: prioritizes Scout's Chrome Companion plugin and managed Chrome profiles, and falls back to external adapters such as browser-use when configured.
---

# Scout Browser

Use Scout directly for browser observation, introspection, and automation.
Scout puts one lease, origin-scope, and receipt boundary over every browser
engine:

1. **`scout-companion`** (default when connected): Scout's Chrome Companion
   MV3 extension over the local bridge (`ws://127.0.0.1:4321/chrome-companion`),
   for live DOM/page introspection and targeted actions in a companion-enabled
   Chrome profile.
2. **`scout-native`**: Scout-owned non-headless Chrome identities under
   `~/Library/Application Support/Scout/ChromeProfiles/<name>` (with
   compatibility for existing `Action/ChromeProfiles/<name>` identities), full
   CDP control, and domain-allowlisted cookie seeding.
3. **`browser-use`** (first external adapter): Wraps the `browser-use` CLI
   behind the same Scout lease, origin allow-list, and receipt contract.

## Rules

- **Observe before acting**: Take a snapshot or screenshot before clicking or
  filling unfamiliar controls.
- **Respect the regular-Chrome boundary**: Regular Chrome is open-only unless
  using native computer-use observation; use a companion-paired or seeded
  managed profile for DOM automation.
- **Scope origins and protect secrets**: Pass an explicit origin allow-list
  when driving authenticated flows, and stop observation before any
  secret-revealing action.
- **Single driver**: Acquire and release the Scout browser lease cleanly so
  parallel agents never fight over tabs or focus.
