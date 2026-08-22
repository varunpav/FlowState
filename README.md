# Project Overview

Flow State is a hydration-tracking app I built after realizing that hitting my daily water goal (I aim for a gallon a day) requires actual reminders (sheer will alone doesn't cut it while I'm working). I also wanted a real project to get better at TypeScript, so I combined the two.

The app runs a configurable interval timer in the background, pausing automatically during inactivity so it doesn't nag you when you're not at your desk. When the timer completes, it hijacks the screen (full screen interrupt) and plays an alert to make sure you actually notice

Since the core of the app is already an interval timer with screen-lock behavior, I extended it to double as three other tools people commonly use for focused work: a Pomodoro timer, a 20-20-20 eye-break timer, and an hourly stand-up/movement reminder. All just different presets on the same underlying timer engine.

## Tech Stack

- **TypeScript** — app logic and UI
- **Rust** — backend/system-level work (screen takeover, activity detection)
- **Python** - CV water drink verification bonus functionality
- **Tauri** — desktop app framework. Chose Tauri over Electron for a lighter footprint: it ships a native webview instead of bundling Chromium, which keeps the binary small and memory usage low for a background app that's meant to run all day. It also let me offload the system-level pieces (activity detection, screen takeover) to Rust instead of routing everything through Node.

## Roadmap

**v3.0 — CV-based drink verification (shipped, off by default):** Instead of dismissing the alert with a click, the hydration takeover can use OpenCV to confirm you actually raised something to your face before letting you log water — closing the loop between "reminded" and "actually hydrated." See the camera section below and [`cv/README.md`](./cv/README.md) for setup; it's a separate Python process the app spawns and kills around each takeover, not something running in the background.

# Try it out!

### Prerequisites

- **Node.js 18+** (developed on v20.11.1) with npm
- **Rust** via [rustup](https://rustup.rs) — Tauri v2 needs 1.77.2+
- **Windows only:**
  - Microsoft C++ Build Tools (the "Desktop development with C++" workload from the [VS Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/))
  - WebView2 Runtime — already installed on Windows 11 by default; on Windows 10 grab it from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
- **macOS/Linux:** see [Tauri's prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the platform-specific webview/toolchain deps — this app was built and tested on Windows, so those paths are unverified here.
- **Optional — Python 3 + `pip install -r cv/requirements.txt`**, only if you want camera drink verification (off by default). No model file to download — that's the only setup step — see [`cv/README.md`](./cv/README.md). Everything else works with no Python installed at all.

### Setup

```bash
git clone <repository-url>
cd flow-state
npm install
```

### Run it

```bash
npm run tauri dev
```

First launch compiles the Rust side, which takes a minute or two; after that, `cargo`'s incremental build makes it much faster, and Rust file changes trigger an automatic rebuild while `tauri dev` is running.

**The window starts hidden in the system tray** (or the overflow "^" area next to it, if Windows tucks new icons away by default) — that's intentional, it's meant to live in the background. Click the tray icon, or the "Flow State" entry in the taskbar, to open it. From there:

- The home page's hero is always **hydration**, and arming is always something you do on purpose — nothing starts counting down by itself, whether that's a fresh launch or just enabling a reminder in Settings. Before you've pressed Start (or if hydration itself is switched off in Settings) the hero shows the current time instead of a countdown, labeled "Not started" or "Hydration off" so it's clear why nothing's running. Drag the slider to set hydration's length, then hit **Start timer** to arm every *enabled* reminder at its own configured length. Once anything is running, the same button reads **Reset timer** and clears everything back to idle (including resetting a Pomodoro in progress back to a fresh Focus block).
- Any other enabled reminder (Pomodoro, eye break, stand-up) shows in a small row underneath the hero — dimmed while idle (a preview of its configured length, not a live countdown) and normal weight once it's actually running. Pomodoro's entry also says which phase it's in ("Pomodoro · Focus" / "Pomodoro · Break").
- **Pause** freezes every reminder at its exact remaining time; **Resume** picks up from there. Same toggle is reachable from the tray as "Pause / Resume all." The button only appears once something's actually armed — there's nothing to pause otherwise.
- Closing the laptop or restarting the app both leave everything **paused rather than silently resuming** — a restart resumes at the exact frozen value but waits for you to hit Resume, and a sleep of more than two minutes does the same rather than firing every reminder that "expired" while asleep. Either case shows as **System restart - Paused** in the hero so it reads differently from a pause you asked for yourself.
- Settings → **Alerts & sound** has **Test alert (10s)** / **Test notification**, fast-forward buttons alongside Test sound — the first arms a real hydration takeover, the second fires an OS toast directly without waiting for a reminder to actually fire.
- The home page also shows a **hydration ring and 7-day bar chart** tracking progress toward the daily water goal (default a gallon/128oz), with quick-add buttons to log how much you drank — either from a takeover or anytime from the home page.
- **Historical Stats** tab has a GitHub/LeetCode-style contribution grid — one cell per day, shaded by how close that day got to the daily goal — with a `‹ year ›` stepper to browse past calendar years (bounded to the last 5). A collapsed **Why water matters** dropdown underneath has a short explainer on hydration's role in temperature control, waste removal, joint protection, cell transport, focus, digestion, kidney health, and energy.
- **Settings** tab has one card per reminder (hydration, Pomodoro, eye break, stand-up) — each with its own enable toggle, interval (or Pomodoro's 25/55 focus + 5/15 break choice), and an "attention grabber" style: full-screen takeover or a quiet system notification. Also covers water bottle size/goal (plus a `‹ day ›` stepper to add/remove logged ounces for any of the last 7 days), whether inactivity pauses timers at all (and after how long — handy for "I'm watching a movie, don't pause my breaks"), snooze length, max snoozes, alert volume, and start-with-Windows. There's no Save button — every field applies the instant you change it, confirmed by a brief "Saved" note under the fields; if something fails to persist (an OS-level autostart change, a corrupted store file), a banner across the top of the window says so instead of failing silently.
- Step away from the keyboard past the configured inactivity threshold (default 30s) and every reminder's countdown pauses (shown with a grayed-out "Paused" overlay) until you're back — except a Pomodoro break in progress, which keeps running, since walking away from the desk *is* the break. Turn inactivity-pausing off entirely in Settings if you don't want that behavior at all.
- A full-screen takeover can be dismissed from the keyboard — its primary action is focused automatically, so Enter/Space confirms and Escape snoozes.
- **Camera drink verification** is off by default — turn it on under Settings → the **Hydration** card → **Camera verification (CV)**, which sits just under hydration's own Attention Grabber choice (it's an add-on to Full screen specifically, dimmed if you pick Notification instead, since there's no takeover to show a camera pane on). A **Check camera** button below it tells you specifically what's missing (Python, `opencv-python`, or the camera itself; see [`cv/README.md`](./cv/README.md) for setup — no model file to install). Once enabled, the hydration takeover shows a live camera pane with detection boxes, starting the camera a few seconds ahead of time so it's not blank when the takeover appears, and locks the water-quick-add buttons — hidden entirely, not just grayed out — until it sees something held up to your face for about a second. **Skip** is the only visible action until then, for anyone who'd rather dismiss without logging. The camera only ever runs for the seconds a takeover is on screen, nothing is recorded to disk, and a broken camera falls back to normal manual logging rather than blocking you.

### Tests

```bash
npm test                                              # TypeScript core logic + UI wiring (Vitest, happy-dom for the UI layer)
cargo test --manifest-path src-tauri/Cargo.toml       # Rust scheduler/idle-detection logic
python -m unittest discover cv                        # CV drink-detection geometry (stdlib only, no opencv needed)
```

### Production build

```bash
npm run tauri build
```

Produces an MSI and NSIS installer under `src-tauri/target/release/bundle/` (Windows) — install and run that rather than the dev build to test OS-level behavior that differs between `tauri dev` and an installed app (system tray persistence, autostart, Windows toast notifications).
