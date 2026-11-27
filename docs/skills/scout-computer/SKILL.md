---
name: scout-computer
description: Default Scout Computer skill for real non-headless browser control (Scout Browser Companion, Chrome, Safari) and native macOS desktop automation. Load this BEFORE any web browsing, UI verification, DOM inspection, screenshot, or desktop app task. Never default to headless Playwright, Puppeteer, or headless Chromium when Scout Computer is available.
---

# Scout Computer

Scout Computer owns native macOS desktop control and real-browser automation.
`ScoutComputer.app` owns AppKit, TCC permissions, the supervision HUD, drive
leases, and capture. Agents drive it through Scout's MCP tools (`browser_*` and
`computer_*`) or the `scout browser` / `scout computer` CLI. Do not reimplement
capture or accessibility, and never default to headless browsers.

When this skill is invoked, observe first, then act. Show the user what you
saw. Never inject foreground keyboard or pointer input onto the user's live
desktop without an approved Scout Computer drive lease and a verified target
window.

## Prerequisite

```text
browser_status    # check Scout Browser Companion, managed Chrome, Safari
computer_status   # check ScoutComputer.app, drive lease state, TCC permissions
```

- **Never launch `ScoutComputerAgent` directly**: `computer_*` talks to the
  running helper on `ws://127.0.0.1:4319` automatically; invoking `agent`
  directly collides on port 4319.
- If `scout-companion` reports `"Chrome Companion bridge is not running"`,
  start the localhost bridge (`127.0.0.1:4321`) or use `scout-native` /
  `scout-safari` depending on whether the task needs the user's open browser.

## Drive loop & supervision (native desktop)

Live foreground input (`click`, `type`, `key`, `scroll`, `drag`) is gated by
Scout Computer's drive lease and target-window verification:

1. Call `computer_status` to check `agentConnected`, `driveState`, and
   `activeLeaseId`.
2. Call `computer_windows` and `computer_inspect` / `computer_screenshot` to
   observe before acting.
3. Obtain an **approved Scout Computer attention lease** (`mode: "attention"`,
   `showSupervisionLabel: true`) before sending foreground keyboard or pointer
   input. When the agent is connected without an active approved lease,
   `computer_act` refuses live input.
4. Always pass an explicit target (`app`, `bundleId`, or `pid`) on `type` and
   `key` (and on `click`/`scroll`/`drag` when targeting a window). Scout
   Computer verifies that the requested target is actually frontmost before
   injecting input so keystrokes never land in the user's terminal.
5. Prefer `ax_press` / `ax_set` (semantic Accessibility actions) over raw
   screen coordinates. Use coordinates only when Accessibility cannot resolve
   the control.
6. Release the drive lease when the work ends.

## Where to work (agent layer vs live screen)

| The user… | Work |
| --- | --- |
| keeps working in a terminal or says "don't touch my screen" | Use `scout-native` managed Chrome, `scout-companion`, or the off-screen **agent layer** — never steal desktop focus |
| wants DOM inspection, clicks, or screenshots on a web page | `browser_*` (`scout-companion` for signed-in regular browser, or `scout-native` managed Chrome) |
| points at a native macOS app or dialog in front of them | `computer_windows` → `computer_inspect` / `computer_screenshot` → approved drive lease → `computer_act` |
| has passkeys/SSO in regular Chrome | `scout-companion` (preferred, zero focus-stealing), or `scout-safari` if already signed in there |

## Which browser

| Surface | Control |
| --- | --- |
| **Scout Browser Companion** (`scout-companion`, `127.0.0.1:4321`) | Preferred for the user's open Chrome or Safari profile: live DOM snapshot, click, fill, screenshot with zero focus-stealing and zero password copying. |
| **Scout-owned Chrome** (`scout-native`, persistent CDP profiles) | Real non-headless Chrome under `Scout/ChromeProfiles/<name>` (and reuses `Action/ChromeProfiles/<name>`). Full DOM tools over CDP. |
| **macOS Safari** (`scout-safari`) | Direct Safari tab control and DOM inspection. |
| **Regular Chrome without Companion** | Chrome 136+ ignores remote debugging on the default profile. Do NOT blindly inject global desktop keystrokes while the user is typing; connect Scout Browser Companion or use a dedicated profile. |

Never export or copy passwords or cookies into chat or tool output. Any
credentialed flow must use the user's live Companion session, an explicit
domain-allowlisted flow with user confirmation, or `secret run` / LocalOTP
without printing secrets.

## Tool catalog

### Browser MCP tools (`browser_*`)

```text
browser_status                                  # adapter health + active lease
browser_profiles                                # list persistent Chrome profiles
browser_open       { url, profile?, newTab? }   # open URL in real non-headless Chrome/Safari
browser_tabs                                    # list open tabs
browser_snapshot   { tabId?, url? }             # DOM + interactive elements + selectors + text
browser_click      { selector?, label? }        # click by CSS selector or visible label
browser_fill       { selector?, label?, text }  # fill input/textarea/contenteditable
browser_resize     { width, height, mobile? }   # responsive viewport emulation (or reset: true)
browser_screenshot { outputPath?, tabId? }      # save PNG screenshot and return file path
browser_close      { scope?: "tab"|"browser" }  # close tab or managed browser
```

### Native desktop MCP tools (`computer_*`)

```text
computer_status                                                  # helper binary, drive lease state, TCC permissions
computer_windows    { bundleId? | app? | pid? }                  # list on-screen windows (read-only)
computer_screenshot { bundleId?, windowId?, outputPath? }        # capture window, region, or screen PNG (read-only)
computer_focus      { bundleId?, title?, launch? }               # launch/activate app or raise window
computer_inspect    { bundleId? | app? | pid? }                  # read Accessibility UI tree (read-only)
computer_act        { kind, leaseId?, app?|bundleId?|pid?, ... } # click|type|key|scroll|drag|ax_press|ax_set|ocr
```

### CLI equivalents

```bash
scout browser status
scout browser open https://example.com
scout browser snapshot
scout computer status
scout computer windows --app "Google Chrome"
scout computer screenshot --app "Google Chrome" --output /tmp/chrome.png
```

## Trust rules

- **Observe before acting**: Always inspect DOM (`browser_snapshot`) or UI tree
  (`computer_inspect` / `computer_screenshot`) before clicking unfamiliar controls.
- **No blind foreground input**: Never call `computer_act` `type` or `key`
  without a target (`app`, `bundleId`, or `pid`) and an approved Scout Computer
  drive lease.
- **Origin allow-lists & secret cutoff**: Pass `allowOrigins` on authenticated
  flows and stop observation before any secret-revealing action. Do not submit
  purchases, publish, or delete without the user's authority.
