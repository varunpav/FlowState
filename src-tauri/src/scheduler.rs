//! Owns the hydration deadline and the 1-second tick loop. This runs as a native
//! tokio task, not a webview timer, specifically because a hidden/minimized
//! WebView2 window is Chromium and gets throttled to ~1 wake-up/minute after
//! being hidden for ~5 minutes. A tokio interval on the app process's own async
//! runtime is unaffected by that and keeps firing on schedule regardless of
//! whether the window is visible.

use crate::idle::idle_seconds;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Default)]
pub struct SchedulerState {
    pub deadline_ms: Mutex<Option<i64>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickPayload {
    pub now_ms: i64,
    pub idle_seconds: u64,
    pub deadline_ms: Option<i64>,
    pub remaining_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrationDuePayload {
    pub due_at_ms: i64,
}

/// Wall-clock epoch millis, deliberately not `Instant`/`performance.now()` —
/// both are QPC-based on Windows and advance through system suspend, so only
/// a persisted wall-clock deadline behaves correctly across sleep/hibernate.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is set before the unix epoch")
        .as_millis() as i64
}

/// Pure so it's unit-testable without a tokio runtime or app handle.
pub fn should_fire(now: i64, deadline: i64) -> bool {
    now >= deadline
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

    let (deadline, fired) = {
        let mut guard = state.deadline_ms.lock().unwrap();
        let deadline = *guard;
        let fired = matches!(deadline, Some(d) if should_fire(now, d));
        if fired {
            *guard = None;
        }
        (deadline, fired)
    };

    let remaining_ms = deadline.map(|d| (d - now).max(0));
    let _ = app.emit(
        "tick",
        TickPayload {
            now_ms: now,
            idle_seconds: idle,
            deadline_ms: deadline,
            remaining_ms,
        },
    );

    if fired {
        if let Some(due_at_ms) = deadline {
            let _ = app.emit("hydration-due", HydrationDuePayload { due_at_ms });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_exactly_at_the_deadline() {
        assert!(should_fire(1_000, 1_000));
    }

    #[test]
    fn fires_when_a_suspend_gap_jumps_past_the_deadline() {
        // the machine slept through the deadline by 4 hours
        assert!(should_fire(1_000 + 4 * 60 * 60 * 1000, 1_000));
    }

    #[test]
    fn does_not_fire_before_the_deadline() {
        assert!(!should_fire(999, 1_000));
    }
}
