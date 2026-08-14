import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TickPayload {
  nowMs: number;
  idleSeconds: number;
  deadlineMs: number | null;
  remainingMs: number | null;
}

export interface HydrationDuePayload {
  dueAtMs: number;
}

export interface AppStateSnapshot {
  deadlineMs: number | null;
  idleSeconds: number;
  nowMs: number;
}

export function setDeadline(atMs: number | null): Promise<void> {
  return invoke("set_deadline", { atMs });
}

export function getState(): Promise<AppStateSnapshot> {
  return invoke("get_state");
}

export function confirmHydration(): Promise<void> {
  return invoke("confirm_hydration");
}

export function onTick(handler: (payload: TickPayload) => void): Promise<UnlistenFn> {
  return listen<TickPayload>("tick", (event) => handler(event.payload));
}

export function onHydrationDue(
  handler: (payload: HydrationDuePayload) => void,
): Promise<UnlistenFn> {
  return listen<HydrationDuePayload>("hydration-due", (event) => handler(event.payload));
}
