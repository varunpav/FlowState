//! Bridges to `cv/detector.py`, an optional child process for the drink-
//! verification feature (off by default — see `core/settings.ts`'s `cv`
//! section). Mirrors `scheduler.rs`'s split: this module owns process
//! lifecycle and event relay; the frontend (`src/cv.ts`, `core/cvGate.ts`)
//! owns all policy about what the states mean.
//!
//! There is no stdin protocol. Spawning the process IS "start"; killing it
//! IS "stop" — a fullscreen takeover is time-sensitive, so the lifecycle
//! must never depend on a graceful handshake landing in time. See
//! `cv/detector.py`'s module docstring for the matching rationale on the
//! Python side.
//!
//! Rust does not interpret detection payloads — `relay_line` only reads the
//! `"type"` field to pick which Tauri event to re-emit, and forwards the
//! parsed JSON verbatim as the payload. Typing the frame/verified/error
//! shapes lives once, in `src/cv.ts`, rather than duplicated on both sides
//! of the process boundary.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Resolved at COMPILE time via `CARGO_MANIFEST_DIR` (which is `src-tauri/`),
/// not at runtime via `current_exe()` — the latter would resolve to deep
/// inside `target/debug/` in dev, not the project root. This is correct for
/// `npm run tauri dev` only; bundling `cv/` as an installed-build resource
/// (README's Distribution section) will need a different resolution
/// strategy, deliberately deferred — see the plan's "Deferred, still open".
fn detector_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../cv/detector.py")
}

/// A bare `Command::new("python")` searches PATH at spawn time — which on
/// most Windows installs resolves to the Microsoft Store's app-execution
/// stub (it lives under a `WindowsApps` directory and exits immediately
/// without running anything), and more generally trusts whatever binary
/// happens to be earliest on PATH. Resolving explicitly, once, means a
/// missing/stub Python is reported with a specific message instead of a
/// silent no-op, and a later `FLOW_STATE_PYTHON` override always wins.
fn resolve_python() -> Result<&'static Path, String> {
    static RESOLVED: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            if let Some(over) = std::env::var_os("FLOW_STATE_PYTHON") {
                let p = PathBuf::from(over);
                if p.is_absolute() && p.is_file() {
                    return Ok(p);
                }
                return Err(format!("FLOW_STATE_PYTHON is set but does not point to a file: {}", p.display()));
            }

            let Some(path_var) = std::env::var_os("PATH") else {
                return Err("No PATH environment variable to search for python".to_string());
            };

            for dir in std::env::split_paths(&path_var) {
                // The Store stub lives under a WindowsApps directory and
                // exits without doing anything when run non-interactively —
                // worse than "not found", since it looks like success to spawn().
                if dir.components().any(|c| c.as_os_str().eq_ignore_ascii_case("WindowsApps")) {
                    continue;
                }
                for name in ["python.exe", "python3.exe", "python", "python3"] {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }

            Err("Couldn't find a python executable on PATH. Install Python 3 (see cv/README.md), \
                 or set the FLOW_STATE_PYTHON environment variable to its full path."
                .to_string())
        })
        .as_deref()
        .map_err(|e| e.clone())
}

#[derive(Default)]
pub struct CvState {
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestResult {
    pub opencv: bool,
    pub model: bool,
    pub camera: bool,
    pub message: String,
}

/// Idempotent: a second call while already running is a no-op rather than
/// spawning a duplicate camera-holding process.
#[tauri::command]
pub async fn cv_start<R: Runtime>(app: AppHandle<R>, state: State<'_, CvState>) -> Result<(), String> {
    {
        let guard = crate::scheduler::lock_recover(&state.child);
        if guard.is_some() {
            return Ok(());
        }
    }

    let python = resolve_python()?;
    let mut child = Command::new(python)
        .arg(detector_script_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start the camera process: {e}"))?;

    let stdout = child.stdout.take().ok_or("Camera process started with no stdout pipe")?;
    *crate::scheduler::lock_recover(&state.child) = Some(child);

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            relay_line(&app, &line);
        }
        // Loop exit (EOF) covers both a clean process exit after `verified`
        // and cv_stop() killing it — no synthetic "unexpected exit" event
        // here. The frontend's own ~8s starting-camera timeout (cv.ts) is
        // what catches a camera that never produces a first frame; a
        // mid-stream crash is a rarer edge the user can always Skip past.
    });

    Ok(())
}

/// Idempotent — a no-op if nothing is running. `start_kill()` sends the
/// signal without waiting for exit (this must return fast; it's called from
/// the takeover's close paths — confirm, snooze, skip — none of which
/// should be blocked on process teardown), and `kill_on_drop(true)` from
/// `cv_start` is the backstop if the signal itself doesn't land.
#[tauri::command]
pub fn cv_stop(state: State<'_, CvState>) {
    if let Some(mut child) = crate::scheduler::lock_recover(&state.child).take() {
        let _ = child.start_kill();
    }
}

/// One-shot: spawn `--selftest`, read its single output line, exit. Used by
/// both the Settings "Check camera" button and (indirectly, by the same
/// code path) whatever a future startup check might want — kept as a plain
/// async fn rather than touching `CvState`, since it never holds the camera
/// open past its own process's lifetime.
#[tauri::command]
pub async fn cv_selftest() -> Result<SelfTestResult, String> {
    let python = resolve_python()?;
    let output = Command::new(python)
        .arg(detector_script_path())
        .arg("--selftest")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Couldn't start the camera process: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .next()
        .ok_or_else(|| "The camera process produced no output".to_string())?;

    serde_json::from_str(line).map_err(|e| format!("Couldn't parse the camera process's output: {e}"))
}

fn relay_line<R: Runtime>(app: &AppHandle<R>, line: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let Some(kind) = value.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    let event_name = match kind {
        "ready" => "cv-ready",
        "frame" => "cv-frame",
        "verified" => "cv-verified",
        "error" => "cv-error",
        _ => return,
    };
    let _ = app.emit(event_name, value);
}
