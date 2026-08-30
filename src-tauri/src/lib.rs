mod cv;
mod idle;
mod scheduler;

use cv::CvState;
use scheduler::{
    lock_recover, PauseReason, ReminderConfigInput, ReminderKind, ReminderRemainingEntry, ReminderSnapshot,
    SchedulerState,
};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, WindowEvent};
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";
const REMAINING_MS_BY_KIND_KEY: &str = "remainingMsByKind";
const REMINDER_CONFIGS_KEY: &str = "reminderConfigs";
/// v1's single-reminder key — deleted on startup so it can't linger and be
/// mistaken for live state by anything still reading it.
const LEGACY_REMAINING_MS_KEY: &str = "remainingMs";
/// v2.5's persisted pause flag — deleted on startup for the same reason.
/// Pause is no longer persisted at all (see the restart-derivation comment
/// in `.setup()` below): it's derived fresh from whether any budget
/// restored non-null, so a stored value here would just be dead weight
/// startup never reads.
const LEGACY_GLOBAL_PAUSE_KEY: &str = "globalPause";
const TRAY_ID: &str = "main-tray";
const SNOOZE_MS_DEFAULT: i64 = 15 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateSnapshot {
    reminders: Vec<ReminderSnapshot>,
    active_kind: Option<ReminderKind>,
    idle_seconds: u64,
    now_ms: i64,
    pause: Option<PauseReason>,
}

#[tauri::command]
fn set_remaining_ms<R: Runtime>(
    app: AppHandle<R>,
    state: State<SchedulerState>,
    kind: ReminderKind,
    ms: Option<i64>,
) {
    scheduler::set_remaining(&state, kind, ms);
    persist_remaining(&app, &state);
}

#[tauri::command]
fn set_reminder_configs<R: Runtime>(
    app: AppHandle<R>,
    state: State<SchedulerState>,
    configs: Vec<ReminderConfigInput>,
) {
    scheduler::set_reminder_configs(&state, &configs);
    persist_reminder_configs(&app, &configs);
}

#[tauri::command]
fn get_state(state: State<SchedulerState>) -> AppStateSnapshot {
    let guard = lock_recover(&state.inner);
    AppStateSnapshot {
        reminders: guard
            .reminders
            .iter()
            .map(|r| ReminderSnapshot {
                kind: r.kind,
                remaining_ms: r.remaining_ms,
            })
            .collect(),
        active_kind: guard.active,
        idle_seconds: idle::idle_seconds(),
        now_ms: scheduler::now_ms(),
        pause: guard.pause,
    }
}

#[tauri::command]
fn set_pause_threshold_seconds(state: State<SchedulerState>, seconds: u64) {
    lock_recover(&state.inner).pause_threshold_seconds = scheduler::clamp_pause_threshold(seconds);
}

/// Not persisted — see `LEGACY_GLOBAL_PAUSE_KEY`'s docstring. A manual pause
/// that survives a quit reports as `System` on the next launch, derived
/// fresh from whatever budgets restored non-null; the only thing that
/// distinction ever changes is the hero's label.
#[tauri::command]
fn set_pause(state: State<SchedulerState>, reason: Option<PauseReason>) {
    scheduler::set_pause(&state, reason);
}

#[tauri::command]
fn release_takeover<R: Runtime>(app: AppHandle<R>, state: State<SchedulerState>) {
    scheduler::release_takeover(&app, &state);
}

/// Best-effort disk flush so every reminder's budget survives a restart. A
/// closed app never ticks, so no budget is ever decremented while closed —
/// reloading these values as-is on the next launch is exactly consistent
/// with the pause model (no elapsed-time gap math needed).
fn persist_remaining<R: Runtime>(app: &AppHandle<R>, state: &SchedulerState) {
    if let Ok(store) = app.store(SETTINGS_STORE) {
        let entries = scheduler::remaining_entries(state);
        if let Ok(value) = serde_json::to_value(entries) {
            store.set(REMAINING_MS_BY_KIND_KEY, value);
            let _ = store.save();
        }
    }
}

fn persist_reminder_configs<R: Runtime>(app: &AppHandle<R>, configs: &[ReminderConfigInput]) {
    if let Ok(store) = app.store(SETTINGS_STORE) {
        if let Ok(value) = serde_json::to_value(configs) {
            store.set(REMINDER_CONFIGS_KEY, value);
            let _ = store.save();
        }
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    // Ticks are gated off while hidden/minimized (scheduler.rs's
    // should_emit_tick), so the countdown the user left behind would
    // otherwise sit stale for up to 1s after reopening from the tray.
    scheduler::emit_state(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(SchedulerState::default())
        .manage(CvState::default())
        .invoke_handler(tauri::generate_handler![
            set_remaining_ms,
            set_reminder_configs,
            get_state,
            set_pause_threshold_seconds,
            set_pause,
            release_takeover,
            cv::cv_start,
            cv::cv_stop,
            cv::cv_selftest
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))?;

            let state = app.state::<SchedulerState>();
            if let Ok(store) = app.store(SETTINGS_STORE) {
                store.delete(LEGACY_REMAINING_MS_KEY);
                store.delete(LEGACY_GLOBAL_PAUSE_KEY);

                // Restore each kind's saved alertStyle/pauseWhenIdle BEFORE
                // any remaining_ms restoration below — otherwise a restored
                // budget could fire and seize the screen, styled as the
                // still-default alertStyle, in the brief window between
                // launch and TypeScript's first `set_reminder_configs` push.
                if let Some(configs_value) = store.get(REMINDER_CONFIGS_KEY) {
                    if let Ok(configs) = serde_json::from_value::<Vec<ReminderConfigInput>>(configs_value) {
                        scheduler::set_reminder_configs(&state, &configs);
                    }
                }

                let mut restored_any_budget = false;
                if let Some(entries_value) = store.get(REMAINING_MS_BY_KIND_KEY) {
                    if let Ok(entries) = serde_json::from_value::<Vec<ReminderRemainingEntry>>(entries_value) {
                        for entry in entries {
                            if entry.remaining_ms.is_some() {
                                restored_any_budget = true;
                            }
                            scheduler::set_remaining(&state, entry.kind, entry.remaining_ms);
                        }
                    }
                }

                // A restart resumes budgets at their exact frozen value (a
                // closed app never ticks, so no elapsed-time gap math is
                // needed — see persist_remaining's docstring) but must NOT
                // resume counting immediately: arming is always an explicit
                // act (core/reminders.ts's reconcileReminders docstring),
                // and a countdown that silently kept going across a restart
                // would violate that. Pausing here is the restart
                // equivalent of the sleep-gap pause in advance_tick.
                if restored_any_budget {
                    scheduler::set_pause(&state, Some(PauseReason::System));
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            // Snooze acts on the hydration reminder specifically — with four
            // independent reminders a per-kind snooze is otherwise
            // ambiguous, and hydration is the one every install has enabled
            // by default. A per-kind tray submenu is a reasonable future
            // improvement, not required here. Pause, unlike Snooze, is
            // global (mirrors the home page's Pause/Resume button) — a
            // label that doesn't dynamically flip between "Pause"/"Resume"
            // would need the MenuItem handle held past setup, which isn't
            // worth it for a toggle whose current state is always visible
            // on the home page anyway.
            let snooze_item = MenuItem::with_id(app, "snooze", "Snooze hydration 15 min", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause / Resume all", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &snooze_item, &pause_item, &separator, &quit_item],
            )?;

            let default_icon = app.default_window_icon().ok_or("missing default window icon")?.clone();
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(default_icon)
                .tooltip("Flow State")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "snooze" => {
                        let state = app.state::<SchedulerState>();
                        let snooze_ms = app
                            .store(SETTINGS_STORE)
                            .ok()
                            .and_then(|s| s.get("snoozeMs"))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(SNOOZE_MS_DEFAULT);
                        scheduler::set_remaining(&state, ReminderKind::Hydration, Some(snooze_ms));
                        persist_remaining(app, &state);
                    }
                    "pause" => {
                        let state = app.state::<SchedulerState>();
                        let currently_paused = lock_recover(&state.inner).pause.is_some();
                        let next = if currently_paused { None } else { Some(PauseReason::Manual) };
                        scheduler::set_pause(&state, next);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            scheduler::spawn_ticker(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close the window hides it back to the tray instead of quitting
            // the whole app — the tray's Quit item is the only real exit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let state = app_handle.state::<SchedulerState>();
                persist_remaining(app_handle, &state);
                // Backstop for the CV child process — every takeover close
                // path (confirm/snooze/skip in the frontend) already calls
                // cv_stop, but this covers a quit while a takeover happens
                // to be up, so the webcam light can never outlive the app.
                cv::cv_stop(app_handle.state::<CvState>());
            }
        });
}
