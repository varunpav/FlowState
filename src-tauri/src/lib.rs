mod idle;
mod scheduler;

use scheduler::{Phase, SchedulerState};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State, WindowEvent};
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";
const REMAINING_MS_KEY: &str = "remainingMs";
const TRAY_ID: &str = "main-tray";
const SNOOZE_MS_DEFAULT: i64 = 5 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateSnapshot {
    remaining_ms: Option<i64>,
    idle_seconds: u64,
    now_ms: i64,
    phase: Phase,
}

#[tauri::command]
fn set_remaining_ms<R: Runtime>(app: AppHandle<R>, state: State<SchedulerState>, ms: Option<i64>) {
    scheduler::set_remaining(&state, ms);
    persist_remaining(&app, ms);
}

#[tauri::command]
fn get_state(state: State<SchedulerState>) -> AppStateSnapshot {
    let guard = state.inner.lock().unwrap();
    AppStateSnapshot {
        remaining_ms: guard.remaining_ms,
        phase: guard.phase,
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

/// Best-effort disk flush so the countdown survives a restart. A closed app
/// never ticks, so the budget is never decremented while closed — reloading
/// this value as-is on the next launch is exactly consistent with the pause
/// model (no elapsed-time gap math needed).
fn persist_remaining<R: Runtime>(app: &AppHandle<R>, ms: Option<i64>) {
    if let Ok(store) = app.store(SETTINGS_STORE) {
        match ms {
            Some(v) => store.set(REMAINING_MS_KEY, serde_json::json!(v)),
            None => store.set(REMAINING_MS_KEY, serde_json::Value::Null),
        }
        let _ = store.save();
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
        .manage(SchedulerState::default())
        .invoke_handler(tauri::generate_handler![
            set_remaining_ms,
            get_state,
            set_pause_threshold_seconds,
            release_takeover
        ])
        .setup(|app| {
            let state = app.state::<SchedulerState>();
            if let Ok(store) = app.store(SETTINGS_STORE) {
                let restored = store.get(REMAINING_MS_KEY).and_then(|v| v.as_i64());
                scheduler::set_remaining(&state, restored);
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let snooze_item = MenuItem::with_id(app, "snooze", "Snooze 5 min", true, None::<&str>)?;
            let pause_item = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
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
                        scheduler::set_remaining(&state, Some(snooze_ms));
                        persist_remaining(app, Some(snooze_ms));
                    }
                    "pause" => {
                        let state = app.state::<SchedulerState>();
                        scheduler::set_remaining(&state, None);
                        persist_remaining(app, None);
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
                let remaining = state.inner.lock().unwrap().remaining_ms;
                persist_remaining(app_handle, remaining);
            }
        });
}
