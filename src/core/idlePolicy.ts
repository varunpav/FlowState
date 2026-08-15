/**
 * The single threshold that drives both the "Inactive" overlay and pausing
 * the hydration countdown (the live comparison against real idle data
 * happens in Rust — `scheduler.rs`'s `is_paused` mirrors this exactly — for
 * the same reason the countdown clock itself lives in Rust: it has to
 * survive a hidden/throttled webview). Below the threshold, the countdown
 * runs and the UI shows nothing special; at or beyond it, the countdown
 * pauses and the UI shows the full-page Inactive overlay.
 */
export const INACTIVITY_THRESHOLD_SECONDS = 30;

export function isIdle(
  idleSeconds: number,
  thresholdSeconds: number = INACTIVITY_THRESHOLD_SECONDS,
): boolean {
  return idleSeconds >= thresholdSeconds;
}
