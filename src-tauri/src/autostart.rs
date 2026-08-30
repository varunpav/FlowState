//! Works around a real bug in `auto-launch` 0.5.0 (the crate underlying
//! `tauri-plugin-autostart`) on Windows: its `enable()` writes
//! `[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]` into
//! `HKCU\...\Explorer\StartupApproved\Run`, apparently believing that marks
//! the entry "approved." Windows itself reads byte 0 as a parity flag — odd
//! (`01`/`03`) means enabled, even (`02`) means disabled, the same value
//! Task Manager's Startup apps toggle writes when a user turns an entry off.
//! So `enable()` doesn't just fail to clear an existing Task-Manager-level
//! block, it writes a value Windows treats as blocked, even on a machine
//! where nothing was ever manually disabled. Confirmed empirically
//! 2026-08-30: this exact byte pattern was present after enabling "Start
//! with Windows" in Settings, and the app did not launch after a real
//! reboot, while `isEnabled()` still (incorrectly) reported it as on — see
//! `auto-launch`'s own `task_manager_enabled` heuristic, which checks
//! whether the trailing 8 bytes are all zero rather than the real parity bit.
//!
//! The fix: rather than trying to write a "correct" enabled value ourselves
//! (an undocumented, Windows-version-dependent format), delete our entry
//! from `StartupApproved\Run` outright. Windows treats *absence* of an
//! entry there as enabled by default — Explorer only ever creates one once
//! a user (or, per the bug above, this app) has touched it — so deletion
//! sidesteps needing to replicate the format at all.
//!
//! Uses `winreg` directly (already compiled transitively via `auto-launch`,
//! pinned to the same 0.10 line here so this doesn't add a second copy to
//! the dependency tree) rather than raw `windows` crate Win32 calls, since
//! this is exactly the API `auto-launch`'s own Windows backend uses for the
//! same key.

#[cfg(target_os = "windows")]
const STARTUP_APPROVED_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

/// Best-effort and idempotent — called both right after the Settings switch
/// enables autostart (so a fresh toggle self-heals immediately) and once at
/// every app startup when the persisted setting is already on (so an
/// install already wedged by the bug above self-heals on its next launch,
/// with no user interaction required). Never treated as fatal by callers:
/// a failure here means Windows might still silently block the launch, not
/// that anything about the app itself is broken.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn clear_startup_approval_block<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    // Matches whatever tauri-plugin-autostart actually used as the Run key's
    // value name (it defaults to this unless a custom .app_name(...) is
    // configured, which lib.rs's plugin registration doesn't do) — resolved
    // dynamically rather than hardcoded so the two can never drift apart.
    let app_name = app.package_info().name.clone();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(STARTUP_APPROVED_RUN_KEY, KEY_SET_VALUE) {
        Ok(k) => k,
        // The subkey not existing at all means nothing has ever blocked
        // anything here — already the desired state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Couldn't open the Windows startup-approval key: {e}")),
    };
    match key.delete_value(&app_name) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // already not blocked
        Err(e) => Err(format!("Couldn't clear the Windows startup-approval block: {e}")),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn clear_startup_approval_block<R: tauri::Runtime>(_app: tauri::AppHandle<R>) -> Result<(), String> {
    Ok(())
}
