---
name: scout-computer
description: Default Scout Computer skill for real non-headless browser control (Chrome, Safari, Scout Browser Companion) and native macOS desktop automation. Load this BEFORE any web browsing, UI verification, DOM inspection, screenshot, or desktop app task. Never default to headless Playwright, Puppeteer, or headless Chromium when Scout Computer is available.
---

# Scout Computer (Browser + Desktop)

**Rule #1 — Real browsers first, never headless by default:**
Whenever a task involves opening a web page, inspecting DOM/UI state, clicking,
filling forms, testing responsive layouts, or taking screenshots, use **Scout's
MCP tools** (`browser_*` and `computer_*`) or **`scout browser` / `scout computer`
CLI** instead of headless Playwright, Puppeteer, or curl-scraping.

## 1. Browser tools (default for web tasks)

All `browser_*` tools live inside the `scout` MCP server under one lease,
origin allow-list, secret-cutoff, and receipt boundary:

1. **`scout-companion`** (preferred when connected): Scout's Chrome/Safari MV3
   Browser Companion extension over `http://127.0.0.1:4321` for live DOM
   introspection and action inside your open browser.
2. **`scout-native`** (real non-headless Chrome over CDP): Auto-launches a
   persistent visible Chrome profile under `Scout/ChromeProfiles/<name>` (and
   reuses existing `Action/ChromeProfiles/<name>` identities), discovering its
   active DevTools port automatically via `DevToolsActivePort`.
3. **`scout-safari`**: Direct macOS Safari tab control and DOM inspection.
4. **`browser-use`**: External goal-driven adapter when explicitly requested.

### MCP tools (part of `scout` default toolset)

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

### CLI equivalents

```bash
scout browser status
scout browser open https://example.com
scout browser snapshot
scout browser click --label "Sign in"
scout browser screenshot --output /tmp/page.png
```

## 2. Native desktop tools (`computer_*`)

Use `computer_*` (or `scout computer ...`) when working with:
- Any **native macOS app**, or
- The operator's **regular Chrome window** (e.g., capturing a window screenshot,
  focusing a tab/window, or interacting where passkeys/SSO prevent using a
  managed profile).

### MCP tools (part of `scout` default toolset)

```text
computer_status                                          # helper binary, agent, TCC permissions
computer_windows    { bundleId? | app? | pid? }          # list on-screen windows
computer_screenshot { bundleId?, windowId?, outputPath? }# capture window, region, or screen PNG
computer_focus      { bundleId?, title?, launch? }       # launch/activate app or raise window
computer_inspect    { bundleId? | app? | pid? }          # read Accessibility UI tree
computer_act        { kind: click|type|key|scroll|drag|ax_press|ax_set|ocr, ... }
```

### CLI equivalents

```bash
scout computer status
scout computer windows --app "Google Chrome"
scout computer screenshot --app "Google Chrome" --output /tmp/chrome.png
scout computer focus --app "Google Chrome" --title "Scout"
```

## Trust rules

- **Observe before acting**: Run `browser_snapshot` / `computer_inspect` /
  `computer_screenshot` before clicking unfamiliar controls.
- **Origin allow-lists & secret cutoff**: Pass `allowOrigins` on authenticated
  flows and stop observation before any secret-revealing action.
- **Never launch `ScoutComputerAgent` directly**: `computer_*` talks to the
  running helper automatically; invoking `agent` directly collides on port 4319.
