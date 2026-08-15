import { getCurrentWindow } from "@tauri-apps/api/window";
import { createChime } from "./audio/chime";
import { INACTIVITY_THRESHOLD_SECONDS, isIdle } from "./core/idlePolicy";
import { formatCountdown } from "./core/schedule";
import { getState, onHydrationDue, onTick, setPauseThresholdSeconds, setRemainingMs } from "./ipc";
import { loadSettings } from "./settingsStore";
import { initSettingsPanel } from "./ui/settingsPanel";
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

  const homeViewEl = document.querySelector<HTMLElement>("#home-view")!;
  const settingsViewEl = document.querySelector<HTMLElement>("#settings-view")!;
  const tabHomeBtn = document.querySelector<HTMLButtonElement>("#tab-home")!;
  const tabSettingsBtn = document.querySelector<HTMLButtonElement>("#tab-settings")!;

  function showTab(tab: "home" | "settings") {
    homeViewEl.hidden = tab !== "home";
    settingsViewEl.hidden = tab !== "settings";
    tabHomeBtn.classList.toggle("tab-btn-active", tab === "home");
    tabSettingsBtn.classList.toggle("tab-btn-active", tab === "settings");
  }

  const settings = await loadSettings();

  const chime = createChime(settings.volume);
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
    settings,
    chime,
  );

  const settingsPanel = initSettingsPanel(
    {
      saveBtn: document.querySelector("#settings-save")!,
      testSoundBtn: document.querySelector("#settings-test-sound")!,
      errorEl: document.querySelector("#settings-error")!,
      intervalInput: document.querySelector("#settings-interval")!,
      snoozeInput: document.querySelector("#settings-snooze")!,
      maxSnoozesInput: document.querySelector("#settings-max-snoozes")!,
      volumeInput: document.querySelector("#settings-volume")!,
    },
    settings,
    chime,
    () => showTab("home"),
  );

  tabHomeBtn.addEventListener("click", () => showTab("home"));
  tabSettingsBtn.addEventListener("click", () => {
    settingsPanel.refresh();
    showTab("settings");
  });

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
