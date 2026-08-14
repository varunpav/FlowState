export interface IdlePolicyConfig {
  deferThresholdSeconds: number;
  resumeThresholdSeconds: number;
}

/**
 * Called when the deadline hits. If the user is away (idle beyond the defer
 * threshold), the reminder is deferred rather than fired into an empty room.
 * A deferred reminder resumes on the first tick where the user is back
 * (idle below the resume threshold) — never queued or repeated.
 */
export function decideOnDue(idleSeconds: number, config: IdlePolicyConfig): "fire" | "defer" {
  return idleSeconds > config.deferThresholdSeconds ? "defer" : "fire";
}

export function shouldResumeDeferred(idleSeconds: number, config: IdlePolicyConfig): boolean {
  return idleSeconds < config.resumeThresholdSeconds;
}

/**
 * A short debounce before the UI labels the user "idle" at all — distinct from
 * (and much shorter than) the defer/resume thresholds above, which govern
 * whether to hold back the hydration reminder itself. Without this, the idle
 * status would flip the instant a tick lands with zero input, e.g. mid-read.
 */
export const IDLE_DISPLAY_THRESHOLD_SECONDS = 5;

export function isIdle(
  idleSeconds: number,
  thresholdSeconds: number = IDLE_DISPLAY_THRESHOLD_SECONDS,
): boolean {
  return idleSeconds >= thresholdSeconds;
}
