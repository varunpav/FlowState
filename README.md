# Flow State

Flow State is a hydration-tracking app I built after realizing that hitting my daily water goal (I aim for a gallon a day) requires actual reminders — sheer will alone doesn't cut it while I'm working. I also wanted a real project to get better at TypeScript, so I combined the two.

It runs quietly in the system tray, counts down in the background, and interrupts you — either with a full-screen takeover or a quiet notification, your choice — when it's time to drink.

## What it does

- **Hydration reminders** are the core: set an interval, hit Start, and get interrupted until you log some water. A ring and a 7-day bar chart on the home page track progress toward your daily goal.
- **Three more reminders** ride on the same timer engine as optional presets: a **Pomodoro** focus/break cycle, a **20-20-20 eye-break** reminder, and an hourly **stand-up** nudge. Enable whichever ones actually help you.
- **Historical Stats** has a GitHub-style contribution grid — one cell per day for the whole year, shaded by how close you got to your goal — plus a short, collapsible explainer on why hydration actually matters.
- **Optional camera verification** (off by default) can confirm you actually raised something to your face before letting a hydration alert count as done, using your webcam. Nothing is ever recorded — the camera only runs for the few seconds a takeover is on screen. See [`cv/README.md`](./cv/README.md) if you want to turn it on.

## Using it

- The window starts hidden — look for it in the system tray (or the "^" overflow area, if Windows tucked it away). Click the icon to open it.
- Nothing counts down until you press **Start timer**. Turning a reminder on in Settings just makes it available next time you hit Start — it doesn't arm anything by itself.
- Settings has no Save button — every change applies immediately.
- **Pause** (also available from the tray) freezes every running reminder at once; **Resume** picks up exactly where it left off. Closing the laptop or restarting the app does the same automatically, rather than firing off every reminder that "expired" while you were away.

## Tech stack

- **TypeScript** — app logic and UI
- **Rust** — system-level work: the background timer, screen takeover, activity detection
- **Python** — the optional camera-verification feature, run as a separate process only while a takeover is on screen
- **Tauri** — desktop app framework. Chosen over Electron for a lighter footprint: a native webview instead of a bundled Chromium keeps the binary small and memory usage low for something meant to run all day.

## Try it yourself

### Prerequisites

- **Node.js 18+** (developed on v20.11.1) with npm
- **Rust** via [rustup](https://rustup.rs) — Tauri v2 needs 1.77.2+
- **Windows only:**
  - Microsoft C++ Build Tools (the "Desktop development with C++" workload from the [VS Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/))
  - WebView2 Runtime — already installed on Windows 11 by default; on Windows 10 grab it from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
- **macOS/Linux:** see [Tauri's prerequisites guide](https://v2.tauri.app/start/prerequisites/) for the platform-specific webview/toolchain deps — this app was built and tested on Windows, so those paths are unverified here.
- **Optional — Python 3 + `pip install -r cv/requirements.txt`**, only if you want camera drink verification. No model file to download — that's the only setup step. Everything else works with no Python installed at all.

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
