export interface ScheduleSettings {
  intervalMs: number;
}

export function computeNextDeadline(settings: ScheduleSettings, now: number): number {
  return now + settings.intervalMs;
}

export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
