# Project Overview

Flow State is a hydration-tracking app I built after realizing that hitting my daily water goal (I aim for a gallon a day) requires actual reminders (sheer will alone doesn't cut it while I'm working). I also wanted a real project to get better at TypeScript, so I combined the two.

The app runs a configurable interval timer in the background, pausing automatically during inactivity so it doesn't nag you when you're not at your desk. When the timer completes, it hijacks the screen (full screen interrupt) and plays an alert to make sure you actually notice

Since the core of the app is already an interval timer with screen-lock behavior, I extended it to double as three other tools people commonly use for focused work: a Pomodoro timer, a 20-20-20 eye-break timer, and an hourly stand-up/movement reminder. All just different presets on the same underlying timer engine.

## Tech Stack

- **TypeScript** — app logic and UI
- **Rust** — backend/system-level work (screen takeover, activity detection)
- **Tauri** — desktop app framework. Chose Tauri over Electron for a lighter footprint: it ships a native webview instead of bundling Chromium, which keeps the binary small and memory usage low for a background app that's meant to run all day. It also let me offload the system-level pieces (activity detection, screen takeover) to Rust instead of routing everything through Node.

## Roadmap

**v2.0 — CV-based drink verification (in progress):** Instead of dismissing the alert with a click, the app will use computer vision to confirm you actually drank water before letting you get back to work thus closing the loop between "reminded" and "actually hydrated."

## Try it out!

### Prerequisites

- **Node.js 18+** (developed on v20.11.1) with npm
- **Rust** via [rustup](https://rustup.rs) — Tauri v2 needs 1.77.2+
- **Windows only:**
  - Microsoft C++ Build Tools (the "Desktop development with C++" workload from the [VS Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/))
  - WebView2 Runtime — already installed on Windows 11 by default; on Windows 10 grab it from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
- **macOS/Linux:** see [Tauri's prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the platform-specific webview/toolchain deps — this app was built and tested on Windows, so those paths are unverified here.

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

- The home page's hero is always the **hydration countdown** — drag the slider and hit **Start timer** to arm/restart it at that many minutes (the slider alone just sets the length for the *next* cycle, without disturbing a countdown already running). Any other enabled reminder (Pomodoro, eye break, stand-up) shows in a small row underneath.
- **Pause** freezes every reminder at its exact remaining time; **Resume** picks up from there. Same toggle is reachable from the tray as "Pause / Resume all."
- **Test alert in 10s** / **Test notification** are fast-forward buttons — the first arms a real hydration takeover, the second fires an OS toast directly without waiting for a reminder to actually fire.
- The home page also shows a **hydration ring and 7-day bar chart** tracking progress toward the daily water goal (default a gallon/128oz), with quick-add buttons to log how much you drank — either from a takeover or anytime from the home page.
- **Settings** tab has one card per reminder (hydration, Pomodoro, eye break, stand-up) — each with its own enable toggle, interval (or Pomodoro's 25/55 focus + 5/15 break choice), and an "attention grabber" style: full-screen takeover or a quiet system notification. Also covers water bottle size/goal (plus a day picker to add/remove/clear logged ounces for the last week), snooze length, max snoozes, alert volume, whether inactivity pauses timers at all (and after how long — handy for "I'm watching a movie, don't pause my breaks"), and start-with-Windows. Everything persists across restarts.
- Step away from the keyboard past the configured inactivity threshold (default 30s) and every reminder's countdown pauses (shown with a grayed-out "Paused" overlay) until you're back — except a Pomodoro break in progress, which keeps running, since walking away from the desk *is* the break. Turn inactivity-pausing off entirely in Settings if you don't want that behavior at all.

### Tests

```bash
npm test                                              # TypeScript core logic (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml       # Rust scheduler/idle-detection logic
```

### Production build

```bash
npm run tauri build
```

Produces an MSI and NSIS installer under `src-tauri/target/release/bundle/` (Windows) — install and run that rather than the dev build to test OS-level behavior that differs between `tauri dev` and an installed app (system tray persistence, autostart, Windows toast notifications).
