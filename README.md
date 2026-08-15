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

- **Set interval (min)** arms the countdown for that many minutes.
- **Debug: fire in 10s** is a fast-forward button so you can see the full-screen takeover without waiting for a real interval to elapse — useful for trying out the confirm/snooze flow immediately.
- **Settings** tab lets you adjust the interval, snooze length, max snoozes, and alert volume (with a test-sound button), and persists across restarts.
- Step away from the keyboard for 30+ seconds and the countdown pauses with a grayed-out "Inactive" overlay until you're back.

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
