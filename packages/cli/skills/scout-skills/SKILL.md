---
name: scout-skills
description: >
  Use this first for "what skills do I have?" or any request to list my skills:
  the harness menu is not my live Scout catalog. Also use for "skill",
  "run my X skill", "make a skill", or work that sounds like a saved procedure
  (for example "share this grab"), even without the word skill.
---

Run `scout skills --json` each time. For a named machine, add `--on <host>`.
Use this live catalog, not memory. Report a lookup error rather than guessing.

- **List:** Show the names and descriptions. Open no files.
- **Choose:** Use the requested name; otherwise match by description. If
  several fit, ask which one. If none fits, say so and offer `scout skills new <name>`.
- **Here:** For work in this session, read only the chosen `path` and follow
  that SKILL.md for the user's brief. Resolve scripts and assets from its `directory`.
- **Handoff:** If another agent or machine should own the work, or the user
  wants a tracked run, use `scout run <name> "brief"`. Pass the requested
  harness or project; a remote run needs `--on <host> --project <path>`.
  Return the receipt and follow link. Do not also run it here.
- **Manage:** Use `scout skills new <name>`, `edit <name>`, `fork <name>`,
  `add <path|git-url>` or `path <name>` (all under `scout skills`). Fork a
  linked skill before editing. Refresh the catalog after a change.
