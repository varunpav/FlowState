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
