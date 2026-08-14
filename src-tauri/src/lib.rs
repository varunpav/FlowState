mod idle;
mod scheduler;

use scheduler::SchedulerState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateSnapshot {
    deadline_ms: Option<i64>,
    idle_seconds: u64,
    now_ms: i64,
}

#[tauri::command]
fn set_deadline(state: State<SchedulerState>, at_ms: Option<i64>) {
    *state.deadline_ms.lock().unwrap() = at_ms;
}

#[tauri::command]
fn get_state(state: State<SchedulerState>) -> AppStateSnapshot {
    AppStateSnapshot {
        deadline_ms: *state.deadline_ms.lock().unwrap(),
        idle_seconds: idle::idle_seconds(),
        now_ms: scheduler::now_ms(),
    }
}

#[tauri::command]
fn confirm_hydration(state: State<SchedulerState>) {
    *state.deadline_ms.lock().unwrap() = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SchedulerState::default())
        .invoke_handler(tauri::generate_handler![
            set_deadline,
            get_state,
            confirm_hydration
        ])
        .setup(|app| {
            scheduler::spawn_ticker(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
