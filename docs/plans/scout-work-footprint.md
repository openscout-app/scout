# Host memory used by Scout's work

Status: design for review. Nothing in this note is built yet, except the parts
under "Current behavior".

## Outcome

When the host runs short of memory, the operator can see how much of it Scout's
work holds, item by item, with the agent or copy that started each item. Scout
tells the operator once when pressure becomes critical, and offers to stop the
items that Scout's work started. Scout never acts on a process it cannot tie to
its own work.

Scout's work is more than Scout's own processes. Agents start dev servers,
studio servers, type checks, bundlers, and browser tabs. Those items use the
host's memory because Scout ran the work, so Scout should account for them.

## Why now

On 2026-11-16 the host panicked at 12:03:42 with `watchdog timeout: no checkins
from watchdogd in 92 seconds`. scoutd's memory guard saw the pressure build:

| Time | Guard record |
| --- | --- |
| 11:42 to 11:55 | `pressure-warn` about once a minute |
| 11:56:17 | `pressure-critical`: swap 13,259 of 13,312 MB, 26% of memory available |
| 11:57 to 11:59 | `pressure-warn` |

The critical record lists the ten largest processes on the host:

| Footprint | Process |
| --- | --- |
| 7,317 MB | Chrome renderer |
| 5,758 MB | Chrome renderer |
| 3,217 MB | Chrome renderer |
| 999 MB | `next-server` (a design studio) |
| 957 MB | Codex renderer |
| 721, 666, 544 MB | `claude bg-spare` |
| 637 MB | ChatGPT |
| 561 MB | `kimi-code` |

All of Scout's own processes held 1,109 MB together. Other records from
11:42 to 11:59 show `node tsc` at up to 2,427 MB and `esbuild` at up to
1,175 MB. At 11:59 they still held 2,061 MB and 1,123 MB.

The guard recorded all of this and did nothing else, which is its design: it
stops only Scout's own processes, and none of them was large. The records do
not show which agent or page owned the three Chrome renderers, so the cause of
the 16.3 GB is not known. Some of the other items were agent work: type checks,
bundles, and a studio server.

The guard was built after the 2026-11-14 crash, when the runtime itself grew to
about 9 GB. It is correct for that failure. This note covers the other half:
what Scout's work starts outside Scout's process tree.

## Current behavior

This section describes code on `main` at 41abdebe.

- `crates/scoutd/src/memory_watch.rs` watches the process tree under scoutd.
  It reads host pressure from `kern.memorystatus_vm_pressure_level` through a
  dispatch memory-pressure source, and samples every 5 seconds at normal
  pressure and every second otherwise.
- A process over its tripwire is recorded, then stopped with `SIGTERM`; its
  parent restarts it. The defaults are 2,048 MB for `scout-broker` and
  `scout-web`, 512 MB for other `scout*` roles, and 1,024 MB for any other role
  in the tree. `memory-tripwires.json` and
  `OPENSCOUT_MEMORY_TRIPWIRE_<ROLE>_MB` override them.
- Under pressure, the guard records the largest Scout process without stopping
  it, and adds the ten largest processes on the host (`host_top`). It scans the
  host only when it writes such a record.
- `host_top` records `pid`, `role` (from `argv`), footprint, resident size, and
  CPU time. It sets `ppid` to `0`, and records no working folder, no listening
  port, and no URL. For that reason no record can name the owner of a process
  outside Scout's tree.
- Records go to `logs/broker/memory/scoutd-<ms>-<reason>.json`, and the latest
  reading goes to `runtime/memory-watch.json`. No code outside scoutd reads
  `memory-watch.json`.
- The guard sends no operator signal and no push.
- Agent harnesses that Scout starts in tmux run under the tmux server, not
  under scoutd (`claude-session-records.ts`). The guard's tree therefore does
  not include agents or anything they start.
- Scoutbot's read tools (`packages/pairing/src/scoutbot/role.ts`) include no
  host or memory reading. Its grants set `shell: false`.

## Terms

- **Item**: one process, or one browser tab, that uses memory.
- **Owner**: the Scout agent, flight, or registered copy that started an item.
- **Evidence**: the observation that ties an item to its owner. Every owner
  must come with its evidence.
- **Scout's work**: the items that have an owner.
- **Not Scout**: the items without an owner. Scout can name them in a report
  and must not act on them.

## Design

### 1. scoutd records the facts

When the guard writes a pressure record, it records, for each process above a
size floor (proposed: 256 MB), and for each ancestor of such a process:

- `pid`, `ppid`, `role`, footprint, and resident size, as today;
- the working folder, from `proc_pidinfo`;
- the TCP ports it listens on.

scoutd records facts only. It must not decide owners, because the records
that define owners (endpoints, flights, copies) belong to the runtime.

The host scan must stay off the normal sampling path. It runs when the guard
writes a pressure record, and when the runtime asks for a reading.

### 2. The runtime assigns owners

The runtime joins scoutd's facts with its own records and assigns each item an
owner and one kind of evidence. It tries these in order and stops at the first
match:

1. `scout-tree`: the item is in scoutd's tree. The owner is Scout itself.
2. `harness-descendant`: an ancestor of the item is a harness process that
   Scout knows. The runtime finds harness pids from
   `~/.claude/sessions/<pid>.json` (`claude-session-records.ts`) and from live
   terminal sessions (`live-terminal-session.ts`). The owner is that agent,
   and its flight when one is active.
3. `copy-folder`: the item's working folder is inside a registered copy. The
   registry is `~/.local/state/openscout/derived-state/worktrees/*.json`
   (`OPENSCOUT_DERIVED_STATE_ROOT` overrides the root). The owner is the copy
   and the agent registered with it.
4. `endpoint-folder`: the item's working folder is inside an endpoint's `cwd`
   or `projectRoot`. The owner is that agent.
5. `port`: the item is a browser tab whose URL is `localhost:<port>`, and a
   process with an owner listens on that port. The tab gets that owner.

If no rule matches, the item is Not Scout. A failed probe (for example, a
working folder that cannot be read) also leaves the item without an owner, with
the reason recorded.

The runtime exposes the result as one read, available to the CLI, MCP, and the
apps:

- totals: host pressure, swap, available memory, Scout's work, and Not Scout;
- Scout's work grouped by owner, largest first, with each item's pid, role,
  footprint, and evidence;
- the five largest Not Scout items, by name only.

Proposed names: `GET /v1/host/footprint`, `scout host footprint --json`, and
the MCP read tool `host_footprint`.

### 3. Browser tabs

Browser tabs held most of the memory on 2026-11-16, and they are the weakest
evidence. A Chrome renderer's arguments do not include a URL, so a renderer pid
alone cannot name its tab.

- **Tabs in Action's Chrome** (the `agent-browser` identity on port 9334):
  Action knows each tab's URL and the agent that opened it. Open question:
  whether Action can report memory per tab. The Chrome DevTools Protocol gives
  JavaScript heap size per tab (`Performance.getMetrics`), which is less than
  the renderer's footprint.
- **Tabs in the operator's regular Chrome**: agents open pages there, for
  example a studio page to show the operator. Scout can record that an agent
  opened a URL there and when. That is a lead, not evidence. The report must
  label it as unverified and must not assign an owner from it.

### 4. Scout tells the operator

When host pressure crosses into critical, the runtime sends one operator signal
of kind `consult` through `broker-operator-attention-service.ts`, with a push.
The signal states the pressure, swap use, the three largest items of Scout's
work with their owners, and the largest Not Scout item.

- The runtime sends the signal, not a Scoutbot turn. Under critical pressure a
  model turn can be slow or fail, and the signal must not depend on one.
- The runtime sends one signal for each crossing. It sends another only after
  pressure has been normal for 10 minutes and then becomes critical again.
- Warn does not send a signal. Warn lasted 14 minutes on 2026-11-16 before
  critical, and a signal for each warn would teach the operator to ignore it.

### 5. Scoutbot answers and proposes

Scoutbot gets `host_footprint` as a read tool. The operator can ask it at any
time what Scout's work is using, and it answers from the read in section 2.
When the operator opens the critical signal, Scoutbot can explain the items and
propose what to stop.

Scoutbot proposes. It does not stop anything. A stop is a write, and it runs
only after the operator approves it, through the runtime. This keeps the seam
that ScoutGuard expects: Scoutbot has no shell and no new write grant.

### 6. Stopping an item

After the operator approves, the runtime stops an item of Scout's work:

- a server: `SIGTERM` to its process group, then `SIGKILL` after 10 seconds;
- a tab in Action's Chrome: Action closes the tab.

The runtime must not stop an item of Scout's own tree this way. The guard's
tripwires already cover those processes. The runtime must not stop a Not Scout
item, and must not stop a harness process; the operator decides what happens to
a running agent.

## Exclusions

- No action on processes outside Scout's work.
- No disk alerting in this change. The runtime's storage monitor
  (`broker-storage-pressure.ts`) refuses runtime commands below 256 MB free
  and sends no operator signal. The same signal path could carry disk pressure later.
- No change to the guard's tripwires or to its stop policy for Scout's own
  processes.
- No app interface in this change. The web and native apps read the runtime
  API in a separate change in `scout-apps`.

## Open questions

1. Can Action report memory for each tab it owns, as footprint or close to it?
2. Are Claude Code's `bg-spare` processes Scout's work? Claude Code's daemon
   starts them, not Scout. Under the rules above they are Not Scout.
3. Is 256 MB the right floor for the host scan?
4. Should the signal also go out when swap passes a share of its total, since
   swap on this host filled before pressure reached critical?

## Delivery slices

1. scoutd records `ppid`, working folder, and listening ports for host
   processes above the floor and their ancestors. Tests use an injected process
   table.
2. The runtime assigns owners and serves the read, the CLI command, and the
   MCP tool. Scoutbot gets the read grant.
3. The runtime sends the operator signal on each crossing into critical.
4. The runtime stops an approved item: servers first, then Action tabs.
5. The apps show the read (in `scout-apps`).

## Acceptance checks

- A fixture built from the 2026-11-16 critical record produces a report in
  which `next-server`, `tsc`, and `esbuild` have owners when their harness or
  copy evidence is present, and the Chrome renderers are Not Scout when no tab
  evidence is present.
- A process whose ancestor is a known harness pid gets that agent as owner,
  with `harness-descendant` evidence.
- A process whose working folder is inside a registered copy gets that copy as
  owner, with `copy-folder` evidence.
- A process with no matching evidence has no owner, and the report names it
  only in the Not Scout list.
- One crossing into critical sends one signal. Pressure that stays critical, or
  that returns to warn, sends no second signal.
- No stop runs without an operator approval, and no stop targets a Not Scout
  item or a harness process.
- The host scan does not run on the normal 5-second sample.
