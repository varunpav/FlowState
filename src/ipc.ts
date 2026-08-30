import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AlertStyle, ReminderKind } from "./core/reminders";

export interface ReminderSnapshot {
  kind: ReminderKind;
  remainingMs: number | null;
}

/**
 * Mirrors Rust's `PauseReason` — `manual` is the home page's Pause button /
 * the tray's "Pause / Resume all", `system` is a sleep/wake gap or a
 * restored budget at startup, both cases the app froze on its own rather
 * than the user asking it to.
 */
export type PauseReason = "manual" | "system";

export interface TickPayload {
  nowMs: number;
  idleSeconds: number;
  reminders: ReminderSnapshot[];
  activeKind: ReminderKind | null;
  pause: PauseReason | null;
}

export interface ReminderDuePayload {
  kind: ReminderKind;
  alertStyle: AlertStyle;
  dueAtMs: number;
}

export interface AppStateSnapshot {
  reminders: ReminderSnapshot[];
  activeKind: ReminderKind | null;
  idleSeconds: number;
  nowMs: number;
  pause: PauseReason | null;
}

export interface ReminderConfig {
  kind: ReminderKind;
  alertStyle: AlertStyle;
  pauseWhenIdle: boolean;
}

export function setRemainingMs(kind: ReminderKind, ms: number | null): Promise<void> {
  return invoke("set_remaining_ms", { kind, ms });
}

/** Always pushes all four configs at once — no partial-update state on the Rust side. */
export function setReminderConfigs(configs: ReminderConfig[]): Promise<void> {
  return invoke("set_reminder_configs", { configs });
}

export function getState(): Promise<AppStateSnapshot> {
  return invoke("get_state");
}

export function setPauseThresholdSeconds(seconds: number): Promise<void> {
  return invoke("set_pause_threshold_seconds", { seconds });
}

export function setPause(reason: PauseReason | null): Promise<void> {
  return invoke("set_pause", { reason });
}

export function releaseTakeover(): Promise<void> {
  return invoke("release_takeover");
}

/**
 * Works around a real bug in the `auto-launch` crate underlying
 * `tauri-plugin-autostart` on Windows: its `enable()` writes a value into
 * `StartupApproved\Run` that it believes means "approved" but Windows itself
 * reads as disabled (see `src-tauri/src/autostart.rs`'s module docstring for
 * the full story). Best-effort and idempotent — a no-op on non-Windows and
 * safe to call any time intent is "autostart should be on," not just on a
 * fresh enable.
 */
export function clearStartupApprovalBlock(): Promise<void> {
  return invoke("clear_startup_approval_block");
}

export function onTick(handler: (payload: TickPayload) => void): Promise<UnlistenFn> {
  return listen<TickPayload>("tick", (event) => handler(event.payload));
}

export function onReminderDue(handler: (payload: ReminderDuePayload) => void): Promise<UnlistenFn> {
  return listen<ReminderDuePayload>("reminder-due", (event) => handler(event.payload));
}
