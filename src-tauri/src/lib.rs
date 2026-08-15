mod idle;
mod scheduler;

use scheduler::{ReminderConfigInput, ReminderKind, ReminderRemainingEntry, ReminderSnapshot, SchedulerState};
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
const TRAY_ID: &str = "main-tray";
const SNOOZE_MS_DEFAULT: i64 = 15 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateSnapshot {
    reminders: Vec<ReminderSnapshot>,
    active_kind: Option<ReminderKind>,
    idle_seconds: u64,
    now_ms: i64,
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
    let guard = state.inner.lock().unwrap();
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
    }
}

#[tauri::command]
fn set_pause_threshold_seconds(state: State<SchedulerState>, seconds: u64) {
    state.inner.lock().unwrap().pause_threshold_seconds = seconds;
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(SchedulerState::default())
        .invoke_handler(tauri::generate_handler![
            set_remaining_ms,
            set_reminder_configs,
            get_state,
            set_pause_threshold_seconds,
            release_takeover
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

                if let Some(entries_value) = store.get(REMAINING_MS_BY_KIND_KEY) {
                    if let Ok(entries) = serde_json::from_value::<Vec<ReminderRemainingEntry>>(entries_value) {
                        for entry in entries {
                            scheduler::set_remaining(&state, entry.kind, entry.remaining_ms);
                        }
                    }
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            // The tray's quick actions act on the hydration reminder
            // specifically — with four independent reminders a single
            // "Snooze"/"Pause" pair is otherwise ambiguous, and hydration is
            // the one every install has enabled by default. A per-kind tray
            // submenu is a reasonable future improvement, not required here.
            let snooze_item = MenuItem::with_id(app, "snooze", "Snooze hydration 15 min", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause hydration", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &snooze_item, &pause_item, &separator, &quit_item],
            )?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
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
                        scheduler::set_remaining(&state, ReminderKind::Hydration, None);
                        persist_remaining(app, &state);
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
            }
        });
}
