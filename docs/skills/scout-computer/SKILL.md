---
name: scout-computer
description: Drive native macOS surfaces and real non-headless browsers with Scout Computer. Use when observing the screen, resolving targets, clicking or typing through ScoutComputer.app, working an app off the user's screen on the agent layer, recording a capture, or choosing between Scout-owned Chrome, Scout Browser Companion, and the user's regular browser.
compatibility: Requires macOS with ScoutComputer.app and the Scout MCP server (or standalone @scout-computer/mcp).
---

# Scout Computer

Scout Computer is native computer-use for Scout. `ScoutComputer.app` owns
AppKit, permissions, the supervision HUD, the off-screen agent layer, and
recording. Agents drive it through `scout_computer_*` MCP tools (or
`scout computer` / `scout browser` CLI). Do not reimplement capture or
accessibility, and never default to headless Playwright or Puppeteer when
Scout Computer is available.

When this skill is invoked, observe first, then act. Show the user what you
saw. Do not claim a recording finished until the finished marker or
`scout_computer_record_status` says it did.

## Prerequisite

```text
scout_computer_status
```

Check `available`, `agentConnected`, `driveState`, `layer`, and macOS
Accessibility / Screen Recording permissions.

- **Never launch `ScoutComputerAgent` directly**: `scout_computer_*` talks to
  the single running agent on `ws://127.0.0.1:4319`.
- **Never hijack the user's keyboard or focus** while they are working at the
  desktop. Use the off-screen agent layer or Scout Browser Companion instead.

## Drive loop

1. Call `scout_computer_driver_identify` once when using `@scout-computer/mcp`
   and the connection does not already name the agent.
2. Call `scout_computer_drive_begin` with an agent identity and a short task.
   `background` is the default drive mode.
3. Pass the returned `leaseId` to observe and act calls.
4. Call `scout_computer_drive_note` before each beat so the floating Scout
   Computer supervision HUD shows the current step.
5. When using `@scout-computer/mcp`, call `scout_computer_drive_aim` to move
   the synthetic cursor and highlight a region before acting, or
   `scout_computer_drive_play` to run a named sequence of beats (`note`, `aim`,
   `wait`, `act`).
6. Prefer observation and Accessibility inspection before sending input.
7. Call `scout_computer_drive_release` when the work ends.

`scout_computer_stage_set` declares a flat color drape plus the windows that
sit on it. Never write the desktop picture.

## Agent layer

The agent layer is a private virtual display off in a corner of the
arrangement. `scout_computer_layer_open` moves an app's windows (or a single
window) onto it, and the user watches through a small PiP. Acts on the layer
run as blinks: the pointer and the frontmost app come straight back.

| The user… | Work |
| --- | --- |
| keeps working while you act, or says "don't touch my screen" | On the layer (`scout_computer_layer_open`) |
| is using the app you need (one Safari window, one Chrome window) | On the layer, borrowing that window with `windowId` or `windowTitle` |
| wants a page read or driven through the DOM in an isolated browser | Managed Chrome (`browser_open { mode: "managed" }`), then `browser_snapshot` / `browser_click` / `browser_fill` |
| wants DOM inspection on a tab in their own signed-in Chrome | Scout Browser Companion (`browser_status` → `browser_tabs` / `browser_snapshot`) |
| points at something in front of them ("this dialog") | On their screen: observe, verify target + approved attention lease, act |
| wants to watch it happen, or asks for a staged take | On their screen, with `scout_computer_stage_set` and `scout_computer_record_start` |

```text
scout_computer_layer_open      { bundleId | pid, windowId?, windowTitle?, width?, height?, pip? }
scout_computer_layer_snapshot  look first (milliseconds from the running feed)
scout_computer_act             click / type / key route as blink acts on the layer
scout_computer_layer_close     restore moved windows and remove the virtual display
```

Use `scout_computer_layer_snapshot` to inspect what is on the layer. One layer
at a time; opening another closes the first.

The operator owns the PiP. A paused layer refuses acts: wait. A layer taken
over is gone and its windows are back: stop, tell the user, call
`scout_computer_layer_close` to acknowledge, and open another only if they ask.
If the user hid the viewer, `scout_computer_layer_pip` brings it back.

Close the layer when the work ends. Windows return to their original frames.

## Observe, resolve, act

Inspection (read-only):

```text
scout_computer_status
scout_computer_windows         { bundleId? | app? | pid? }
scout_computer_screenshot      { bundleId?, windowId?, region?, outputPath? }
scout_computer_inspect         { bundleId? | app? | pid? }
```

In `@scout-computer/mcp`, target-first input follows the full Action loop:

```text
scout_computer_observe_snapshot
scout_computer_resolve_target
scout_computer_act_execute
scout_computer_observe_snapshot
```

In the built-in Scout MCP server, `scout_computer_act` accepts `click`, `type`,
`key`, `scroll`, `drag`, `ax_press`, `ax_set`, and `ocr`:

- Prefer Accessibility (`ax_press`, `ax_set`) or blink acts on an open agent
  layer over raw foreground coordinates.
- **No blind foreground input**: `type` and `key` on the live desktop require
  an explicit target (`app`, `bundleId`, or `pid`), verify that target is
  frontmost in `window-order`, and require an approved Scout Computer attention
  lease when `ScoutComputerAgent` is connected.

## Recording

When connected to `@scout-computer/mcp`:

```text
scout_computer_session_create
scout_computer_record_start
scout_computer_record_status
scout_computer_record_stop
scout_computer_artifacts_list
```

`scout_computer_record_start` is an acknowledgement only. Completion is the
`.mov` file, the `.finished` marker, and `scout_computer_record_status`. Keep
`recordingId`, `outputPath`, `stopFile`, and `finishedFile` until the run is
complete. Use `scout_computer_layer_record` to record the agent layer itself.

## Which browser

| Surface | Control |
| --- | --- |
| The user's regular Chrome (URL open) | Open-only with `browser_open { mode: "regular" }`. |
| The user's regular Chrome (signed-in tabs, DOM) | Scout Browser Companion extension when connected, or borrow one Chrome window onto the agent layer (`scout_computer_layer_open { bundleId: "com.google.Chrome", windowTitle }`). |
| A Scout-owned Chrome identity | Real non-headless Chrome over CDP (`browser_open { mode: "managed" }`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_resize`, `browser_screenshot`). |
| A Scout-owned identity seeded from a real profile | Only with explicit user confirmation (`confirm: true`) and a domain allowlist. |

Regular Chrome is not a CDP DOM target: Chrome 136 and later ignore remote
debugging on the default profile. Never copy passwords, cookies, or Keychain
secrets manually, and never submit purchases, publish, or delete without the
user's authority.
