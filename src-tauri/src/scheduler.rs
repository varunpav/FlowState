//! Owns the hydration countdown, the 1-second tick loop, and the pause
//! decision. This all runs as a native tokio task, not a webview timer,
//! specifically because a hidden/minimized WebView2 window is Chromium and
//! gets throttled (and can be fully frozen) after being hidden for a while. A
//! tokio interval on the app process's own async runtime is unaffected by
//! that and keeps ticking regardless of whether the window is visible —
//! which is also why the pause decision happens HERE rather than being
//! decided by TypeScript in response to an IPC event: an event dispatched to
//! a frozen renderer has the same reliability problem the Rust-owned clock
//! exists to avoid.
//!
//! The countdown is a remaining-ms BUDGET, not an absolute deadline: it only
//! decrements while the user is active (idle_seconds < pause_threshold), so
//! stepping away pauses it exactly rather than letting it run out unseen.
//! Because of that, the reminder can only ever reach zero while the user is
//! present — there is no "fired while nobody's there" case left to defer,
//! which is why there's no AwaitingResume phase here (an earlier version of
//! this file had one; true pausing made it unreachable, so it was removed
//! rather than left as dead code). TypeScript still owns the *threshold
//! value* (pushed in once via `set_pause_threshold_seconds`) and *what
//! happens next* (the next budget, via `set_remaining_ms`) — it just doesn't
//! gate whether the seizure itself happens.
//!
//! Each tick decrements by the real wall-clock delta since the previous
//! tick (not a fixed "-1000ms"), so an occasional delayed tick (e.g. tokio's
//! default catch-up behavior after a brief stall) can't cause the budget to
//! run down faster than real active time actually elapsed.

use crate::idle::idle_seconds;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, UserAttentionType};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    TakeoverActive,
}

pub struct SchedulerInner {
    pub remaining_ms: Option<i64>,
    pub pause_threshold_seconds: u64,
    pub phase: Phase,
    pub last_tick_ms: i64,
}

impl Default for SchedulerInner {
    fn default() -> Self {
        Self {
            remaining_ms: None,
            // Mirrors src/core/idlePolicy.ts's INACTIVITY_THRESHOLD_SECONDS
            // until set_pause_threshold_seconds is called (main.ts does this
            // once at startup).
            pause_threshold_seconds: 30,
            phase: Phase::default(),
            last_tick_ms: 0,
        }
    }
}

#[derive(Default)]
pub struct SchedulerState {
    pub inner: Mutex<SchedulerInner>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickPayload {
    pub now_ms: i64,
    pub idle_seconds: u64,
    pub remaining_ms: Option<i64>,
    pub phase: Phase,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrationDuePayload {
    pub due_at_ms: i64,
}

/// Wall-clock epoch millis, deliberately not `Instant`/`performance.now()` —
/// both are QPC-based on Windows and advance through system suspend. Also
/// used to compute the real elapsed delta between ticks (see module docs).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is set before the unix epoch")
        .as_millis() as i64
}

/// Pure so it's unit-testable without a tokio runtime or app handle. Mirrors
/// idlePolicy.ts's `isIdle`: idle at or beyond the threshold pauses.
pub fn is_paused(idle_seconds: u64, pause_threshold_seconds: u64) -> bool {
    idle_seconds >= pause_threshold_seconds
}

pub fn decrement(remaining_ms: i64, elapsed_ms: i64) -> i64 {
    remaining_ms - elapsed_ms
}

/// Shared by the `set_remaining_ms` command and the tray's Snooze/Pause menu
/// items, so there's one place that touches `remaining_ms`. Deliberately
/// doesn't touch `phase`: tick()'s Idle arm is the only one that reads
/// remaining_ms, so setting it during TakeoverActive is harmless — it sits
/// inert until release_takeover() returns to Idle.
pub fn set_remaining(state: &SchedulerState, ms: Option<i64>) {
    let mut guard = state.inner.lock().unwrap();
    guard.remaining_ms = ms;
    guard.last_tick_ms = now_ms();
}

pub fn spawn_ticker<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            tick(&app);
        }
    });
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<SchedulerState>();
    let now = now_ms();
    let idle = idle_seconds();

    let (remaining, phase, fired) = {
        let mut guard = state.inner.lock().unwrap();
        let elapsed = (now - guard.last_tick_ms).max(0);
        guard.last_tick_ms = now;

        let mut fired = false;
        if guard.phase == Phase::Idle {
            if let Some(r) = guard.remaining_ms {
                if !is_paused(idle, guard.pause_threshold_seconds) {
                    let updated = decrement(r, elapsed);
                    if updated <= 0 {
                        guard.phase = Phase::TakeoverActive;
                        guard.remaining_ms = None;
                        fired = true;
                    } else {
                        guard.remaining_ms = Some(updated);
                    }
                }
                // Paused: remaining_ms is left untouched this tick.
            }
        }

        (guard.remaining_ms, guard.phase, fired)
    }; // guard dropped here — window calls below must never happen while holding the lock

    let _ = app.emit(
        "tick",
        TickPayload {
            now_ms: now,
            idle_seconds: idle,
            remaining_ms: remaining,
            phase,
        },
    );

    if fired {
        // Runs to completion before hydration-due is emitted below, so a
        // confirm/snooze click — only possible after the frontend receives
        // that event — can never race the window not being
        // fullscreen/on-top yet.
        perform_takeover(app);
        let _ = app.emit("hydration-due", HydrationDuePayload { due_at_ms: now });
    }
}

fn perform_takeover<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_fullscreen(true);
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    }
}

/// Shared by both confirm and snooze — the window-restore mechanics are
/// identical either way; they only differ in what budget TS sets afterward.
/// Idempotent: a no-op unless a takeover is actually active.
pub fn release_takeover<R: Runtime>(app: &AppHandle<R>, state: &SchedulerState) {
    {
        let mut guard = state.inner.lock().unwrap();
        if guard.phase != Phase::TakeoverActive {
            return;
        }
        guard.phase = Phase::Idle;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(None);
        let _ = window.set_fullscreen(false);
        let _ = window.set_always_on_top(false);
        // Deliberately no hide() — confirm/snooze should leave the window
        // exactly where it was (a normal window), not banish it to the
        // tray. hide() is reserved for the close-to-tray behavior in
        // lib.rs's window CloseRequested handler.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_pause_below_the_threshold() {
        assert!(!is_paused(4, 5));
    }

    #[test]
    fn pauses_at_exactly_the_threshold() {
        assert!(is_paused(5, 5));
    }

    #[test]
    fn decrement_subtracts_elapsed_time() {
        assert_eq!(decrement(10_000, 1_000), 9_000);
    }

    #[test]
    fn decrement_can_cross_zero() {
        assert!(decrement(500, 1_000) <= 0);
    }

    #[test]
    fn decrement_exactly_at_zero_counts_as_crossed() {
        assert_eq!(decrement(1_000, 1_000), 0);
    }

    #[test]
    fn set_remaining_writes_through_to_state() {
        let state = SchedulerState::default();
        set_remaining(&state, Some(5_000));
        assert_eq!(state.inner.lock().unwrap().remaining_ms, Some(5_000));
        set_remaining(&state, None);
        assert_eq!(state.inner.lock().unwrap().remaining_ms, None);
    }
}
