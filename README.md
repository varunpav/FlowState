# Flow State

I built Flow State because hitting my daily water goal (a gallon a day) takes actual reminders, not willpower. It's also the project I used to get better at TypeScript.

It sits in the system tray, counts down in the background, and interrupts you when it's time to drink: either a full-screen takeover or a quiet notification, your choice.

## What it does

- **Hydration reminders**: set an interval, hit Start, get interrupted until you log water. A ring and a 7-day bar chart on the home page track your daily goal.
- **Three more reminder presets** on the same timer engine: a Pomodoro focus/break cycle, a 20-20-20 eye-break reminder, and an hourly stand-up nudge.
- **Historical Stats**: a GitHub-style contribution grid, one cell per day for the whole year, shaded by how close you got to your goal. A collapsible section underneath explains why hydration matters.
- **Optional camera verification** (off by default): confirms you actually raised something to your face before a hydration alert counts as done. Nothing is recorded; the camera only runs while a takeover is showing. See [`cv/README.md`](./cv/README.md) to turn it on.

## Using it

- The window starts hidden in the system tray (or the "^" overflow area). Click the icon to open it.
- Nothing counts down until you press **Start timer**. Enabling a reminder in Settings just makes it available for the next Start; it doesn't arm anything on its own.
- Settings has no Save button. Changes apply immediately.
- **Pause** (also in the tray menu) freezes every running reminder at once; **Resume** picks up where it left off. Closing the laptop or restarting the app does the same automatically, so nothing fires off a backlog of missed reminders.

## Tech stack

- **TypeScript**: app logic and UI
- **Rust**: the background timer, screen takeover, activity detection
- **Python**: the optional camera-verification feature, run as its own process only while a takeover is showing
- **Tauri**: chosen over Electron for a lighter footprint. A native webview instead of bundled Chromium keeps the binary small and memory use low for something meant to run all day.

## Try it yourself

### Prerequisites

- **Node.js 18+** (developed on v20.11.1) with npm
- **Rust** via [rustup](https://rustup.rs); Tauri v2 needs 1.77.2+
- **Windows only:**
  - Microsoft C++ Build Tools (the "Desktop development with C++" workload from the [VS Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/))
  - WebView2 Runtime, already installed on Windows 11 by default. On Windows 10, grab it from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/).
- **macOS/Linux:** see [Tauri's prerequisites guide](https://v2.tauri.app/start/prerequisites/) for platform-specific deps. This app was built and tested on Windows only, so those paths are unverified.
- **Optional: Python 3 + `pip install -r cv/requirements.txt`**, only for camera drink verification. No model file to download. Everything else works with no Python installed at all.

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

First launch compiles the Rust side, which takes a minute or two. After that, cargo's incremental build is much faster, and Rust file changes trigger an automatic rebuild while `tauri dev` is running.

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

Produces an MSI and NSIS installer under `src-tauri/target/release/bundle/` (Windows). Install and run that instead of the dev build to test OS-level behavior that differs from `tauri dev`, like system tray persistence, autostart, and Windows toast notifications.
