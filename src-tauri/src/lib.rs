mod idle;
mod scheduler;

use scheduler::{Phase, SchedulerState};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateSnapshot {
    remaining_ms: Option<i64>,
    idle_seconds: u64,
    now_ms: i64,
    phase: Phase,
}

#[tauri::command]
fn set_remaining_ms(state: State<SchedulerState>, ms: Option<i64>) {
    // Deliberately doesn't touch `phase`: tick()'s Idle arm is the only one
    // that reads remaining_ms, so setting it during TakeoverActive is
    // harmless — it sits inert until release_takeover() returns to Idle.
    let mut guard = state.inner.lock().unwrap();
    guard.remaining_ms = ms;
    guard.last_tick_ms = scheduler::now_ms();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SchedulerState::default())
        .invoke_handler(tauri::generate_handler![
            set_remaining_ms,
            get_state,
            set_pause_threshold_seconds,
            release_takeover
        ])
        .setup(|app| {
            scheduler::spawn_ticker(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
