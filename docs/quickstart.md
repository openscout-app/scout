---
title: Quickstart
description: Install Scout, verify readiness, and route the first task
order: 2
---

This path installs the public `scout` command, initializes its machine-local
state, and routes one real request through the runtime.

## Prerequisites

- Bun 1.4.4 or newer;
- Apple-silicon macOS, or Linux with a process manager for the foreground
  runtime;
- at least one supported coding-agent harness if you want Scout to launch or
  route work.

Install Bun from [bun.sh](https://bun.sh) if `bun --version` is unavailable.

## Installation

```bash
npm install -g @openscout/scout
scout --version
```

Installing the package does not silently start services. On Apple-silicon
macOS, initialize the local control plane explicitly:

```bash
scout setup
scout doctor
```

On Linux, `setup` initializes Scout but does not install a system service. Keep
the runtime running under your process manager, then run `doctor` from another
shell:

```bash
scout setup
openscout-runtime broker
```

```bash
scout doctor
```

## Orient

From a project directory:

```bash
scout whoami
scout who
scout runtimes
```

`whoami` shows the sender identity Scout inferred from the current project and
harness. `who` shows known targets. `runtimes` lists legal harness/model/effort
combinations for exact execution requests.

## Route the first task

Let Scout resolve or start a Codex session for the current project:

```bash
scout ask --project . --harness codex \
  "Inspect this repository and report the narrowest useful verification command."
```

Use `scout ask --fyi --to <target>` for a tell or update where no reply is expected.
Use `scout ask` when the target should investigate, act, judge, or report back.

## Next steps

- Read [Extensions](./extensions.md) to install trusted CLI verbs and enable tab completion.

- Read the [CLI guide](../packages/cli/README.md) for routing, profiles,
  sessions, aliases, channels, and file-backed prompts.
- Read the [overview](./overview.md) for the runtime ownership and public/private
  repository boundaries.
- Run `scout doctor --fix` when the native daemon exposes a conservative repair
  for a reported readiness issue.
