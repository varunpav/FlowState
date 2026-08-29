/**
 * Both clocks are wall-clock epoch ms (Rust's `SystemTime`, JS's `Date.now()`),
 * so a tick's own `nowMs` is directly comparable to the receiving side's
 * clock. A tick can arrive this stale after a queued backlog (a sleep/resume
 * catch-up volley, or any other IPC delivery delay) — rendering it would
 * repaint the UI with numbers already superseded by whatever tick is next in
 * the queue, so it's cheaper and more correct to just skip it.
 */
export const MAX_TICK_AGE_MS = 5_000;

export function isStaleTick(payloadNowMs: number, nowMs: number, maxAgeMs: number = MAX_TICK_AGE_MS): boolean {
  return nowMs - payloadNowMs > maxAgeMs;
}
