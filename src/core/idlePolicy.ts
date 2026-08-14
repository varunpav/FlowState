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
