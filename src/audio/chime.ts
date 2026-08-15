export interface ChimeHandle {
  start(): void;
  stop(): void;
  setVolume(volume: number): void;
  /** Resumes the AudioContext without scheduling any audible notes. */
  unlock(): void;
}

const NOTE_A5 = 880;
const NOTE_E5 = 659.25;
const CHIME_PERIOD_MS = 3000;

/**
 * A synthesized two-note chime — no binary asset needed, volume is a plain
 * gain multiplier. `hydration-due` arrives via an IPC event, not a user
 * gesture, so the shared AudioContext this returns must be unlocked earlier
 * by a real click (see main.ts's pointerdown listener calling `unlock()`) or
 * Chromium's autoplay policy can silently block playback the first time it's
 * needed. `unlock()` resumes the context without scheduling any notes —
 * calling `start()` immediately followed by `stop()` is NOT silent, since
 * `start()` schedules real notes onto the AudioContext timeline synchronously
 * and `stop()` only prevents the *next* loop iteration, not those already
 * scheduled.
 */
export function createChime(initialVolume: number): ChimeHandle {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let volume = clamp01(initialVolume);
  let timerId: number | null = null;

  function ensureContext(): { ctx: AudioContext; gain: GainNode } {
    if (!ctx || !masterGain) {
      ctx = new AudioContext();
      masterGain = ctx.createGain();
      masterGain.gain.value = volume;
      masterGain.connect(ctx.destination);
    }
    return { ctx, gain: masterGain };
  }

  function playNote(c: AudioContext, dest: GainNode, freq: number, atTime: number, duration: number) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0, atTime);
    envelope.gain.linearRampToValueAtTime(1, atTime + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, atTime + duration);

    osc.connect(envelope);
    envelope.connect(dest);
    osc.start(atTime);
    osc.stop(atTime + duration + 0.05);
  }

  function scheduleLoop() {
    const { ctx: c, gain } = ensureContext();
    const now = c.currentTime;
    playNote(c, gain, NOTE_A5, now + 0.05, 0.35);
    playNote(c, gain, NOTE_E5, now + 0.33, 0.45);
    timerId = window.setTimeout(scheduleLoop, CHIME_PERIOD_MS);
  }

  return {
    start() {
      if (timerId !== null) return;
      const { ctx: c } = ensureContext();
      if (c.state === "suspended") void c.resume();
      scheduleLoop();
    },
    stop() {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      // Don't close the context — keep it unlocked for the next start().
    },
    setVolume(next: number) {
      volume = clamp01(next);
      if (masterGain) masterGain.gain.value = volume;
    },
    unlock() {
      const { ctx: c } = ensureContext();
      if (c.state === "suspended") void c.resume();
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
