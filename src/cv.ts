import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CvSelfTestResult {
  opencv: boolean;
  model: boolean;
  camera: boolean;
  message: string;
}

export interface CvFramePayload {
  /** base64-encoded JPEG, already boxed by Python — the takeover just puts this straight into an <img src>. */
  jpeg: string;
}

export interface CvVerifiedPayload {
  confidence: number;
}

export interface CvErrorPayload {
  code: string;
  message: string;
}

/** Idempotent — a second call while already running is a no-op on the Rust side, never a duplicate camera-holding process. */
export function cvStart(): Promise<void> {
  return invoke("cv_start");
}

/** Idempotent — safe to call even if nothing is running. Call this on every takeover close path (confirm, snooze, skip), not just on verification. */
export function cvStop(): Promise<void> {
  return invoke("cv_stop");
}

export function cvSelftest(): Promise<CvSelfTestResult> {
  return invoke("cv_selftest");
}

export function onCvReady(handler: () => void): Promise<UnlistenFn> {
  return listen("cv-ready", () => handler());
}

export function onCvFrame(handler: (payload: CvFramePayload) => void): Promise<UnlistenFn> {
  return listen<CvFramePayload>("cv-frame", (event) => handler(event.payload));
}

export function onCvVerified(handler: (payload: CvVerifiedPayload) => void): Promise<UnlistenFn> {
  return listen<CvVerifiedPayload>("cv-verified", (event) => handler(event.payload));
}

export function onCvError(handler: (payload: CvErrorPayload) => void): Promise<UnlistenFn> {
  return listen<CvErrorPayload>("cv-error", (event) => handler(event.payload));
}
