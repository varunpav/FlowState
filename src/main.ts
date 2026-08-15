import { getCurrentWindow } from "@tauri-apps/api/window";
import { createChime } from "./audio/chime";
import { INACTIVITY_THRESHOLD_SECONDS, isIdle } from "./core/idlePolicy";
import { formatCountdown } from "./core/schedule";
import { DEFAULT_SETTINGS } from "./core/settings";
import { getState, onHydrationDue, onTick, setPauseThresholdSeconds, setRemainingMs } from "./ipc";
import { initTakeover } from "./ui/takeover";

let countdownEl: HTMLElement | null;
let intervalInputEl: HTMLInputElement | null;
let inactiveOverlayEl: HTMLElement | null;
let inactiveSecondsEl: HTMLElement | null;

function render(remainingMs: number | null, idleSeconds: number) {
  if (countdownEl) {
    countdownEl.textContent = remainingMs === null ? "--:--" : formatCountdown(remainingMs);
  }

  const inactive = isIdle(idleSeconds);
  if (inactiveOverlayEl) inactiveOverlayEl.hidden = !inactive;
  if (inactiveSecondsEl) {
    // Starts at 0 the moment the overlay appears, not at the debounce threshold.
    inactiveSecondsEl.textContent = String(Math.max(0, idleSeconds - INACTIVITY_THRESHOLD_SECONDS));
  }

  void getCurrentWindow().setTitle(
    remainingMs === null ? "Flow State" : `${formatCountdown(remainingMs)} — Flow State`,
  );
}

window.addEventListener("DOMContentLoaded", async () => {
  countdownEl = document.querySelector("#countdown");
  intervalInputEl = document.querySelector("#interval-minutes");
  inactiveOverlayEl = document.querySelector("#inactive-overlay");
  inactiveSecondsEl = document.querySelector("#inactive-seconds");

  const chime = createChime(DEFAULT_SETTINGS.volume);
  // hydration-due fires from an IPC event, not a user gesture, so the shared
  // AudioContext needs unlocking from a real click before that — silently
  // start-then-stop it on the first click anywhere in the app.
  document.addEventListener(
    "pointerdown",
    () => {
      chime.start();
      chime.stop();
    },
    { once: true },
  );

  const takeover = initTakeover(
    {
      overlayEl: document.querySelector("#takeover-overlay")!,
      confirmBtn: document.querySelector("#takeover-confirm")!,
      snoozeBtn: document.querySelector("#takeover-snooze")!,
      snoozeHintEl: document.querySelector("#takeover-snooze-hint")!,
    },
    DEFAULT_SETTINGS,
    chime,
  );

  await setPauseThresholdSeconds(INACTIVITY_THRESHOLD_SECONDS);

  document.querySelector("#start-interval")?.addEventListener("click", async () => {
    const minutes = Number(intervalInputEl?.value ?? "120");
    await setRemainingMs(minutes * 60 * 1000);
  });

  document.querySelector("#fire-in-10s")?.addEventListener("click", async () => {
    await setRemainingMs(10_000);
  });

  await onTick((payload) => render(payload.remainingMs, payload.idleSeconds));
  await onHydrationDue(() => takeover.show());

  const initial = await getState();
  render(initial.remainingMs, initial.idleSeconds);
  if (initial.phase === "takeoverActive") {
    // Handles a webview reload (e.g. dev hot-reload) happening mid-takeover.
    takeover.show();
  }
});
