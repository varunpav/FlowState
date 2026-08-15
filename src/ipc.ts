import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AlertStyle, ReminderKind } from "./core/reminders";

export interface ReminderSnapshot {
  kind: ReminderKind;
  remainingMs: number | null;
}

export interface TickPayload {
  nowMs: number;
  idleSeconds: number;
  reminders: ReminderSnapshot[];
  activeKind: ReminderKind | null;
  globalPause: boolean;
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
  globalPause: boolean;
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

export function setGlobalPause(paused: boolean): Promise<void> {
  return invoke("set_global_pause", { paused });
}

export function releaseTakeover(): Promise<void> {
  return invoke("release_takeover");
}

export function onTick(handler: (payload: TickPayload) => void): Promise<UnlistenFn> {
  return listen<TickPayload>("tick", (event) => handler(event.payload));
}

export function onReminderDue(handler: (payload: ReminderDuePayload) => void): Promise<UnlistenFn> {
  return listen<ReminderDuePayload>("reminder-due", (event) => handler(event.payload));
}
