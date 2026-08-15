import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Phase = "idle" | "takeoverActive";

export interface TickPayload {
  nowMs: number;
  idleSeconds: number;
  remainingMs: number | null;
  phase: Phase;
}

export interface HydrationDuePayload {
  dueAtMs: number;
}

export interface AppStateSnapshot {
  remainingMs: number | null;
  idleSeconds: number;
  nowMs: number;
  phase: Phase;
}

export function setRemainingMs(ms: number | null): Promise<void> {
  return invoke("set_remaining_ms", { ms });
}

export function getState(): Promise<AppStateSnapshot> {
  return invoke("get_state");
}

export function setPauseThresholdSeconds(seconds: number): Promise<void> {
  return invoke("set_pause_threshold_seconds", { seconds });
}

export function releaseTakeover(): Promise<void> {
  return invoke("release_takeover");
}

export function onTick(handler: (payload: TickPayload) => void): Promise<UnlistenFn> {
  return listen<TickPayload>("tick", (event) => handler(event.payload));
}

export function onHydrationDue(
  handler: (payload: HydrationDuePayload) => void,
): Promise<UnlistenFn> {
  return listen<HydrationDuePayload>("hydration-due", (event) => handler(event.payload));
}
