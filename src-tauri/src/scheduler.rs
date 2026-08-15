//! Owns four independent countdown budgets, the 1-second tick loop, and the
//! takeover-queueing/promotion decision. This all runs as a native tokio
//! task, not a webview timer, specifically because a hidden/minimized
//! WebView2 window is Chromium and gets throttled (and can be fully frozen)
//! after being hidden for a while. A tokio interval on the app process's own
//! async runtime is unaffected by that and keeps ticking regardless of
//! whether the window is visible — which is also why the pause decision
//! happens HERE rather than being decided by TypeScript in response to an
//! IPC event: an event dispatched to a frozen renderer has the same
//! reliability problem the Rust-owned clock exists to avoid.
//!
//! Each reminder's countdown is a remaining-ms BUDGET, not an absolute
//! deadline: it only decrements while the user is active (idle_seconds <
//! pause_threshold), so stepping away pauses it exactly rather than letting
//! it run out unseen. A reminder can therefore only ever reach zero while
//! the user is present. The one exception is the Pomodoro break's budget
//! (`pause_when_idle: false`, set by TypeScript's `set_reminder_configs`
//! call whenever it flips the Pomodoro phase) — walking away from the desk
//! IS the break, so pausing it would mean it never ends until you sit back
//! down and then wait out the remainder.
//!
//! Each tick decrements by the real wall-clock delta since the previous
//! tick (not a fixed "-1000ms"), so an occasional delayed tick (e.g. tokio's
//! default catch-up behavior after a brief stall) can't cause a budget to
//! run down faster than real active time actually elapsed.
//!
//! Four reminders sharing one screen means takeovers can collide: every
//! reminder crossing zero is routed by its `alert_style` — `Notify` emits a
//! toast the same tick with no phase change, `Takeover` is pushed onto
//! `due_queue`. At most one promotion (`due_queue` -> `active`) happens per
//! tick, gated on `active.is_none()` — a takeover freezes ALL budgets
//! (including the Pomodoro break) while it's up, which is intentional: an
//! unacknowledged takeover halting the app for 40 minutes must not produce
//! four queued alerts. `hold_until_ms` is a short post-release cooldown so
//! dismissing one takeover doesn't instantly flash the next queued one in
//! the same frame — that reads as a bug even though it would be correct.

use crate::idle::idle_seconds;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, UserAttentionType};
use tauri_plugin_notification::NotificationExt;

const HOLD_MS: i64 = 3000;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReminderKind {
    Hydration,
    Pomodoro,
    EyeBreak,
    StandUp,
}

impl ReminderKind {
    /// Also doubles as Rust's takeover promotion priority (array iteration
    /// order below) — mirror `src/core/reminders.ts`'s REMINDER_KINDS order
    /// exactly.
    pub const ALL: [ReminderKind; 4] = [
        ReminderKind::Hydration,
        ReminderKind::Pomodoro,
        ReminderKind::EyeBreak,
        ReminderKind::StandUp,
    ];

    fn default_alert_style(self) -> AlertStyle {
        match self {
            ReminderKind::Hydration | ReminderKind::Pomodoro => AlertStyle::Takeover,
            ReminderKind::EyeBreak | ReminderKind::StandUp => AlertStyle::Notify,
        }
    }

    /// Secondary surface only (Windows toasts only work for installed apps,
    /// so this is a no-op under `tauri dev` — the in-app chime and the
    /// takeover overlay's per-kind copy, both TS-owned, are primary). Kept
    /// phase-agnostic for Pomodoro since Rust doesn't track which phase
    /// (focus/break) just ended — that's `core/pomodoro.ts`'s state.
    fn notification_body(self) -> &'static str {
        match self {
            ReminderKind::Hydration => "Time to hydrate",
            ReminderKind::Pomodoro => "Pomodoro phase complete",
            ReminderKind::EyeBreak => "Eye break — look 20 feet away for 20 seconds",
            ReminderKind::StandUp => "Time to stand up and stretch",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertStyle {
    Takeover,
    Notify,
}

#[derive(Clone, Copy, Debug)]
pub struct Reminder {
    pub kind: ReminderKind,
    /// None = not armed. Covers "disabled", "paused", and "just fired"
    /// alike — there is deliberately no separate `enabled` flag; enablement
    /// is TypeScript policy (an unarmed reminder and a disabled one look
    /// identical to Rust).
    pub remaining_ms: Option<i64>,
    pub alert_style: AlertStyle,
    pub pause_when_idle: bool,
}

impl Reminder {
    fn new(kind: ReminderKind) -> Self {
        Self {
            kind,
            remaining_ms: None,
            alert_style: kind.default_alert_style(),
            pause_when_idle: true,
        }
    }
}

pub struct SchedulerInner {
    pub reminders: [Reminder; 4],
    pub pause_threshold_seconds: u64,
    /// Replaces v1's `Phase` enum — `Option<ReminderKind>` makes "active but
    /// which one?" unrepresentable as an invalid state.
    pub active: Option<ReminderKind>,
    pub due_queue: VecDeque<ReminderKind>,
    pub hold_until_ms: i64,
    pub last_tick_ms: i64,
}

impl Default for SchedulerInner {
    fn default() -> Self {
        Self {
            reminders: ReminderKind::ALL.map(Reminder::new),
            // Mirrors src/core/idlePolicy.ts's INACTIVITY_THRESHOLD_SECONDS
            // until set_pause_threshold_seconds is called (main.ts does this
            // once at startup).
            pause_threshold_seconds: 30,
            active: None,
            due_queue: VecDeque::new(),
            hold_until_ms: 0,
            last_tick_ms: 0,
        }
    }
}

#[derive(Default)]
pub struct SchedulerState {
    pub inner: Mutex<SchedulerInner>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSnapshot {
    pub kind: ReminderKind,
    pub remaining_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickPayload {
    pub now_ms: i64,
    pub idle_seconds: u64,
    pub reminders: Vec<ReminderSnapshot>,
    pub active_kind: Option<ReminderKind>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderDuePayload {
    pub kind: ReminderKind,
    pub alert_style: AlertStyle,
    pub due_at_ms: i64,
}

/// Mirrors `core/settings.ts`'s per-reminder `alertStyle` + the derived
/// `pauseWhenIdle` (true for everything except an in-progress Pomodoro
/// break). Pushed via `set_reminder_configs` — always all four at once, no
/// partial-update state — whenever settings are saved or the Pomodoro phase
/// flips.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderConfigInput {
    pub kind: ReminderKind,
    pub alert_style: AlertStyle,
    pub pause_when_idle: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRemainingEntry {
    pub kind: ReminderKind,
    pub remaining_ms: Option<i64>,
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

pub enum StepOutcome {
    Unchanged,
    Ticked(i64),
    Fired,
}

pub fn step_reminder(remaining_ms: Option<i64>, elapsed_ms: i64, running: bool) -> StepOutcome {
    match remaining_ms {
        None => StepOutcome::Unchanged,
        Some(_) if !running => StepOutcome::Unchanged,
        Some(r) => {
            let updated = r - elapsed_ms;
            if updated <= 0 {
                StepOutcome::Fired
            } else {
                StepOutcome::Ticked(updated)
            }
        }
    }
}

/// At most one promotion per tick, and only once the post-release cooldown
/// has elapsed.
pub fn may_promote(active: Option<ReminderKind>, queue_len: usize, now_ms: i64, hold_until_ms: i64) -> bool {
    active.is_none() && queue_len > 0 && now_ms >= hold_until_ms
}

/// Shared by the `set_remaining_ms` command and the tray's Snooze/Pause menu
/// items. Deliberately doesn't touch `active`: the decrement loop below is
/// gated on `active.is_none()`, so writing a budget for a reminder while a
/// (possibly different) takeover is active is harmless — it sits inert
/// until release, which is exactly the pre-arm invariant requirement 10
/// depends on.
pub fn set_remaining(state: &SchedulerState, kind: ReminderKind, ms: Option<i64>) {
    let mut guard = state.inner.lock().unwrap();
    if let Some(r) = guard.reminders.iter_mut().find(|r| r.kind == kind) {
        r.remaining_ms = ms;
    }
    guard.last_tick_ms = now_ms();
}

pub fn set_reminder_configs(state: &SchedulerState, configs: &[ReminderConfigInput]) {
    let mut guard = state.inner.lock().unwrap();
    for cfg in configs {
        if let Some(r) = guard.reminders.iter_mut().find(|r| r.kind == cfg.kind) {
            r.alert_style = cfg.alert_style;
            r.pause_when_idle = cfg.pause_when_idle;
        }
    }
}

pub fn remaining_entries(state: &SchedulerState) -> Vec<ReminderRemainingEntry> {
    let guard = state.inner.lock().unwrap();
    guard
        .reminders
        .iter()
        .map(|r| ReminderRemainingEntry {
            kind: r.kind,
            remaining_ms: r.remaining_ms,
        })
        .collect()
}

pub struct TickResult {
    pub due_now: Vec<(ReminderKind, AlertStyle)>,
    pub promoted: Option<ReminderKind>,
}

/// The pure core of a tick: decrement every armed, running reminder, queue
/// anything that fired, and promote at most one queued takeover. Kept
/// independent of `AppHandle` so it's directly unit-testable — `tick()`
/// below is a thin wrapper that holds the lock only for this call, then
/// does all window/notification/emit work after dropping the guard.
pub fn advance_tick(inner: &mut SchedulerInner, now: i64, idle: u64) -> TickResult {
    let elapsed = (now - inner.last_tick_ms).max(0);
    inner.last_tick_ms = now;

    let mut due_now: Vec<(ReminderKind, AlertStyle)> = Vec::new();

    if inner.active.is_none() {
        for i in 0..inner.reminders.len() {
            let r = inner.reminders[i];
            let paused_for_idle = r.pause_when_idle && is_paused(idle, inner.pause_threshold_seconds);
            let running = !paused_for_idle;
            match step_reminder(r.remaining_ms, elapsed, running) {
                StepOutcome::Unchanged => {}
                StepOutcome::Ticked(v) => inner.reminders[i].remaining_ms = Some(v),
                StepOutcome::Fired => {
                    inner.reminders[i].remaining_ms = None;
                    due_now.push((r.kind, r.alert_style));
                }
            }
        }
    }

    for (kind, style) in &due_now {
        if *style == AlertStyle::Takeover {
            inner.due_queue.push_back(*kind);
        }
    }

    let mut promoted: Option<ReminderKind> = None;
    if may_promote(inner.active, inner.due_queue.len(), now, inner.hold_until_ms) {
        if let Some(k) = inner.due_queue.pop_front() {
            inner.active = Some(k);
            promoted = Some(k);
        }
    }

    TickResult { due_now, promoted }
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

    let (reminders_snapshot, active, result) = {
        let mut guard = state.inner.lock().unwrap();
        let result = advance_tick(&mut guard, now, idle);
        (guard.reminders, guard.active, result)
    }; // guard dropped here — window/notification calls below must never happen while holding the lock

    let _ = app.emit(
        "tick",
        TickPayload {
            now_ms: now,
            idle_seconds: idle,
            reminders: reminders_snapshot
                .iter()
                .map(|r| ReminderSnapshot {
                    kind: r.kind,
                    remaining_ms: r.remaining_ms,
                })
                .collect(),
            active_kind: active,
        },
    );

    for (kind, style) in &result.due_now {
        if *style == AlertStyle::Notify {
            let _ = app
                .notification()
                .builder()
                .title("Flow State")
                .body(kind.notification_body())
                .show();
            let _ = app.emit(
                "reminder-due",
                ReminderDuePayload {
                    kind: *kind,
                    alert_style: *style,
                    due_at_ms: now,
                },
            );
        }
    }

    if let Some(kind) = result.promoted {
        // Runs to completion before reminder-due is emitted below, so a
        // confirm/snooze click — only possible after the frontend receives
        // that event — can never race the window not being
        // fullscreen/on-top yet.
        perform_takeover(app);
        let _ = app
            .notification()
            .builder()
            .title("Flow State")
            .body(kind.notification_body())
            .show();
        let _ = app.emit(
            "reminder-due",
            ReminderDuePayload {
                kind,
                alert_style: AlertStyle::Takeover,
                due_at_ms: now,
            },
        );
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
        if guard.active.is_none() {
            return;
        }
        guard.active = None;
        guard.hold_until_ms = now_ms() + HOLD_MS;
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

    fn inner_with(mutate: impl FnOnce(&mut SchedulerInner)) -> SchedulerInner {
        let mut inner = SchedulerInner::default();
        mutate(&mut inner);
        inner
    }

    fn reminder_mut(inner: &mut SchedulerInner, kind: ReminderKind) -> &mut Reminder {
        inner.reminders.iter_mut().find(|r| r.kind == kind).unwrap()
    }

    #[test]
    fn does_not_pause_below_the_threshold() {
        assert!(!is_paused(4, 5));
    }

    #[test]
    fn pauses_at_exactly_the_threshold() {
        assert!(is_paused(5, 5));
    }

    #[test]
    fn set_remaining_writes_through_to_the_matching_kind_only() {
        let state = SchedulerState::default();
        set_remaining(&state, ReminderKind::Hydration, Some(5_000));
        let guard = state.inner.lock().unwrap();
        assert_eq!(
            guard.reminders.iter().find(|r| r.kind == ReminderKind::Hydration).unwrap().remaining_ms,
            Some(5_000)
        );
        assert_eq!(
            guard.reminders.iter().find(|r| r.kind == ReminderKind::Pomodoro).unwrap().remaining_ms,
            None
        );
    }

    #[test]
    fn set_reminder_configs_updates_alert_style_and_pause_when_idle() {
        let state = SchedulerState::default();
        set_reminder_configs(
            &state,
            &[ReminderConfigInput {
                kind: ReminderKind::Pomodoro,
                alert_style: AlertStyle::Notify,
                pause_when_idle: false,
            }],
        );
        let guard = state.inner.lock().unwrap();
        let pomodoro = guard.reminders.iter().find(|r| r.kind == ReminderKind::Pomodoro).unwrap();
        assert_eq!(pomodoro.alert_style, AlertStyle::Notify);
        assert!(!pomodoro.pause_when_idle);
    }

    #[test]
    fn advance_tick_decrements_an_armed_running_reminder_by_elapsed_time() {
        let mut inner = inner_with(|inner| {
            reminder_mut(inner, ReminderKind::Hydration).remaining_ms = Some(10_000);
            inner.last_tick_ms = 0;
        });
        advance_tick(&mut inner, 1_000, 0);
        assert_eq!(reminder_mut(&mut inner, ReminderKind::Hydration).remaining_ms, Some(9_000));
    }

    #[test]
    fn advance_tick_leaves_a_paused_idle_reminder_untouched() {
        let mut inner = inner_with(|inner| {
            reminder_mut(inner, ReminderKind::Hydration).remaining_ms = Some(10_000);
            inner.last_tick_ms = 0;
            inner.pause_threshold_seconds = 5;
        });
        advance_tick(&mut inner, 1_000, 10); // idle 10s >= threshold 5s
        assert_eq!(reminder_mut(&mut inner, ReminderKind::Hydration).remaining_ms, Some(10_000));
    }

    #[test]
    fn advance_tick_does_not_pause_a_reminder_with_pause_when_idle_false() {
        // The Pomodoro-break case: idle beyond threshold, but the budget
        // still counts down because pause_when_idle is false.
        let mut inner = inner_with(|inner| {
            let r = reminder_mut(inner, ReminderKind::Pomodoro);
            r.remaining_ms = Some(10_000);
            r.pause_when_idle = false;
            inner.last_tick_ms = 0;
            inner.pause_threshold_seconds = 5;
        });
        advance_tick(&mut inner, 1_000, 10);
        assert_eq!(reminder_mut(&mut inner, ReminderKind::Pomodoro).remaining_ms, Some(9_000));
    }

    #[test]
    fn advance_tick_fires_a_reminder_that_crosses_zero_and_clears_its_budget() {
        let mut inner = inner_with(|inner| {
            reminder_mut(inner, ReminderKind::EyeBreak).remaining_ms = Some(500);
            inner.last_tick_ms = 0;
        });
        let result = advance_tick(&mut inner, 1_000, 0);
        assert_eq!(reminder_mut(&mut inner, ReminderKind::EyeBreak).remaining_ms, None);
        assert!(result.due_now.iter().any(|(k, _)| *k == ReminderKind::EyeBreak));
    }

    #[test]
    fn two_takeovers_firing_in_one_tick_promotes_one_and_queues_the_other() {
        let mut inner = inner_with(|inner| {
            reminder_mut(inner, ReminderKind::Hydration).remaining_ms = Some(1);
            reminder_mut(inner, ReminderKind::Pomodoro).remaining_ms = Some(1);
            inner.last_tick_ms = 0;
        });
        let result = advance_tick(&mut inner, 1_000, 0);

        assert_eq!(result.promoted, Some(ReminderKind::Hydration)); // priority order: Hydration before Pomodoro
        assert_eq!(inner.active, Some(ReminderKind::Hydration));
        assert_eq!(inner.due_queue.len(), 1);
        assert_eq!(inner.due_queue.front(), Some(&ReminderKind::Pomodoro));
    }

    #[test]
    fn a_notify_style_fire_never_sets_active() {
        let mut inner = inner_with(|inner| {
            reminder_mut(inner, ReminderKind::EyeBreak).remaining_ms = Some(1);
            inner.last_tick_ms = 0;
        });
        let result = advance_tick(&mut inner, 1_000, 0);

        assert!(inner.active.is_none());
        assert!(result.promoted.is_none());
        assert!(result.due_now.iter().any(|(k, s)| *k == ReminderKind::EyeBreak && *s == AlertStyle::Notify));
    }

    #[test]
    fn a_budget_written_while_active_survives_untouched_and_counts_after_release() {
        // The pre-arm invariant (requirement 10): TS writes the next budget
        // BEFORE the takeover releases, so the IPC round-trip isn't on the
        // confirm-click's critical path.
        let mut inner = inner_with(|inner| {
            inner.active = Some(ReminderKind::Hydration);
            reminder_mut(inner, ReminderKind::Hydration).remaining_ms = Some(5_000); // pre-armed mid-takeover
            inner.last_tick_ms = 0;
        });

        advance_tick(&mut inner, 1_000, 0); // still active — decrement loop must be fully gated off
        assert_eq!(reminder_mut(&mut inner, ReminderKind::Hydration).remaining_ms, Some(5_000));

        inner.active = None; // simulates release_takeover
        advance_tick(&mut inner, 2_000, 0);
        assert_eq!(reminder_mut(&mut inner, ReminderKind::Hydration).remaining_ms, Some(4_000));
    }

    #[test]
    fn promotion_waits_for_the_hold_until_cooldown() {
        let mut inner = inner_with(|inner| {
            inner.due_queue.push_back(ReminderKind::StandUp);
            inner.hold_until_ms = 5_000;
            inner.last_tick_ms = 0;
        });
        let too_soon = advance_tick(&mut inner, 4_000, 0);
        assert!(too_soon.promoted.is_none());

        let after_cooldown = advance_tick(&mut inner, 5_000, 0);
        assert_eq!(after_cooldown.promoted, Some(ReminderKind::StandUp));
    }
}
