import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createChime } from "./audio/chime";
import { formatCountdown } from "./core/format";
import { INACTIVITY_THRESHOLD_SECONDS, isIdle } from "./core/idlePolicy";
import { advancePomodoro, type PomodoroState } from "./core/pomodoro";
import { nextDue, reconcileReminders, REMINDER_LABELS, type ArmedReminder, type ReminderKind } from "./core/reminders";
import type { Settings } from "./core/settings";
import { clearDay, dayKeyOf, entryOn, logWater, removeWater } from "./core/waterLog";
import {
  getState,
  onReminderDue,
  onTick,
  setGlobalPause,
  setPauseThresholdSeconds,
  setReminderConfigs,
  setRemainingMs,
  type ReminderConfig,
  type ReminderSnapshot,
} from "./ipc";
import { loadLog, localTzOffsetMinutes, saveLog } from "./logStore";
import { loadPomodoroState, loadSettings, savePomodoroState, saveSettings } from "./settingsStore";
import { initHomeView } from "./ui/homeView";
import { initSettingsPanel } from "./ui/settingsPanel";
import { initTakeover } from "./ui/takeover";

let inactiveOverlayEl: HTMLElement | null;

function buildReminderConfigs(settings: Settings, pomodoroState: PomodoroState): ReminderConfig[] {
  return [
    { kind: "hydration", alertStyle: settings.reminders.hydration.alertStyle, pauseWhenIdle: true },
    { kind: "eyeBreak", alertStyle: settings.reminders.eyeBreak.alertStyle, pauseWhenIdle: true },
    { kind: "standUp", alertStyle: settings.reminders.standUp.alertStyle, pauseWhenIdle: true },
    // The one exception to "everything pauses when idle" — walking away IS the Pomodoro break.
    { kind: "pomodoro", alertStyle: settings.pomodoro.alertStyle, pauseWhenIdle: pomodoroState.phase !== "break" },
  ];
}

function reconcileInputsFor(settings: Settings, pomodoroState: PomodoroState, snapshot: ReminderSnapshot[]) {
  const remainingOf = (kind: ReminderKind) => snapshot.find((r) => r.kind === kind)?.remainingMs ?? null;
  return [
    {
      kind: "hydration" as const,
      enabled: settings.reminders.hydration.enabled,
      intervalMs: settings.reminders.hydration.intervalMs,
      currentRemainingMs: remainingOf("hydration"),
    },
    {
      kind: "eyeBreak" as const,
      enabled: settings.reminders.eyeBreak.enabled,
      intervalMs: settings.reminders.eyeBreak.intervalMs,
      currentRemainingMs: remainingOf("eyeBreak"),
    },
    {
      kind: "standUp" as const,
      enabled: settings.reminders.standUp.enabled,
      intervalMs: settings.reminders.standUp.intervalMs,
      currentRemainingMs: remainingOf("standUp"),
    },
    {
      kind: "pomodoro" as const,
      enabled: settings.pomodoro.enabled,
      intervalMs: pomodoroState.phase === "break" ? settings.pomodoro.breakMs : settings.pomodoro.focusMs,
      currentRemainingMs: remainingOf("pomodoro"),
    },
  ];
}

async function applyReconcile(settings: Settings, pomodoroState: PomodoroState, snapshot: ReminderSnapshot[]) {
  const actions = reconcileReminders(reconcileInputsFor(settings, pomodoroState, snapshot));
  for (const action of actions) {
    await setRemainingMs(action.kind, action.ms);
  }
  return actions.length > 0;
}

function armedFrom(snapshot: ReminderSnapshot[]): ArmedReminder[] {
  return snapshot
    .filter((r) => r.remainingMs !== null)
    .map((r) => ({ kind: r.kind, remainingMs: r.remainingMs as number }));
}

window.addEventListener("DOMContentLoaded", async () => {
  inactiveOverlayEl = document.querySelector("#inactive-overlay");

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
  let pomodoroState = await loadPomodoroState();
  let dailyLog = await loadLog();
  let todayKey = dayKeyOf(Date.now(), localTzOffsetMinutes());
  let lastArmed: ArmedReminder[] = [];
  let isPaused = false;

  const chime = createChime(settings.volume);
  // reminder-due arrives via an IPC event, not a user gesture, so the shared
  // AudioContext needs unlocking from a real click before that, or Chromium's
  // autoplay policy can silently block playback the first time it's needed.
  document.addEventListener("pointerdown", () => chime.unlock(), { once: true });

  function handleWaterLogged(oz: number, nowMs: number) {
    const key = dayKeyOf(nowMs, localTzOffsetMinutes());
    dailyLog = logWater(dailyLog, key, oz);
    void saveLog(dailyLog);
    if (key === todayKey) {
      homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
    }
  }

  function handleWaterRemoved(oz: number) {
    dailyLog = removeWater(dailyLog, todayKey, oz);
    void saveLog(dailyLog);
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  function handleTodayCleared() {
    dailyLog = clearDay(dailyLog, todayKey);
    void saveLog(dailyLog);
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  const takeover = initTakeover(
    {
      overlayEl: document.querySelector("#takeover-overlay")!,
      titleEl: document.querySelector("#takeover-title")!,
      waterEntryContainerEl: document.querySelector("#takeover-water-entry")!,
      confirmRowEl: document.querySelector("#takeover-confirm-row")!,
      confirmBtn: document.querySelector("#takeover-confirm")!,
      snoozeBtn: document.querySelector("#takeover-snooze")!,
      snoozeHintEl: document.querySelector("#takeover-snooze-hint")!,
    },
    settings,
    chime,
    {
      onWaterLogged: handleWaterLogged,
      getPomodoroPhaseJustEnded: () => (pomodoroState.phase === "focus" ? "break" : "focus"),
    },
  );

  const homeView = initHomeView(
    {
      heroEl: document.querySelector("#hero")!,
      heroLabelEl: document.querySelector("#hero-label")!,
      heroCountdownEl: document.querySelector("#hero-countdown")!,
      chipsEl: document.querySelector("#reminder-chips")!,
      ringContainerEl: document.querySelector("#water-ring")!,
      barsContainerEl: document.querySelector("#water-bars")!,
      streakEl: document.querySelector("#water-streak")!,
      monthStatsEl: document.querySelector("#water-month-stats")!,
      yearStatsEl: document.querySelector("#water-year-stats")!,
      waterEntryContainerEl: document.querySelector("#home-water-entry")!,
      intervalSliderEl: document.querySelector("#hydration-interval-slider")!,
      intervalSliderValueEl: document.querySelector("#hydration-interval-value")!,
      pauseBtn: document.querySelector("#pause-toggle")!,
      testAlertBtn: document.querySelector("#test-alert")!,
      testNotificationBtn: document.querySelector("#test-notification")!,
    },
    {
      bottleOz: settings.water.bottleOz,
      onWaterLogged: handleWaterLogged,
      onIntervalChanged: (minutes) => {
        void (async () => {
          const ms = minutes * 60_000;
          settings.reminders.hydration.intervalMs = ms;
          await saveSettings(settings);
          // Next cycle only — never clobber a countdown already running.
          // Read authoritatively from getState() rather than the cached
          // lastArmed, which can be up to one tick (≤1s) stale; using the
          // stale value here would intermittently reset a running timer.
          const current = (await getState()).reminders.find((r) => r.kind === "hydration")?.remainingMs ?? null;
          if (current === null && settings.reminders.hydration.enabled) {
            await setRemainingMs("hydration", ms);
          }
        })();
      },
      onPauseToggle: () => {
        const next = !isPaused;
        isPaused = next;
        homeView.setPaused(next);
        void setGlobalPause(next);
      },
      onTestAlert: () => {
        // Always hydration — an unpredictable "whatever's next-due" target
        // made this button confusing to use for its actual purpose.
        void setRemainingMs("hydration", 10_000);
      },
      onTestNotification: () => {
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) {
            granted = (await requestPermission()) === "granted";
          }
          if (granted) {
            sendNotification({ title: "Flow State", body: "Test notification" });
          }
        })();
      },
    },
  );

  const settingsPanel = initSettingsPanel(
    {
      remindersContainerEl: document.querySelector("#settings-reminders-container")!,
      saveBtn: document.querySelector("#settings-save")!,
      testSoundBtn: document.querySelector("#settings-test-sound")!,
      errorEl: document.querySelector("#settings-error")!,
      bottleOzInput: document.querySelector("#settings-bottle-oz")!,
      dailyGoalOzInput: document.querySelector("#settings-daily-goal-oz")!,
      todayLoggedEl: document.querySelector("#settings-today-logged")!,
      removeOzInput: document.querySelector("#settings-remove-oz")!,
      removeWaterBtn: document.querySelector("#settings-remove-water")!,
      clearTodayBtn: document.querySelector("#settings-clear-today")!,
      snoozeInput: document.querySelector("#settings-snooze")!,
      maxSnoozesInput: document.querySelector("#settings-max-snoozes")!,
      volumeInput: document.querySelector("#settings-volume")!,
      startWithWindowsContainerEl: document.querySelector("#settings-start-with-windows-switch")!,
    },
    settings,
    chime,
    (updated) => {
      void (async () => {
        homeView.setBottleOz(updated.water.bottleOz);
        homeView.setIntervalMinutes(updated.reminders.hydration.intervalMs / 60_000);
        homeView.renderWater(dailyLog, todayKey, updated.water.dailyGoalOz);
        await setReminderConfigs(buildReminderConfigs(updated, pomodoroState));
        const snapshot = (await getState()).reminders;
        await applyReconcile(updated, pomodoroState, snapshot);
        showTab("home");
      })();
    },
    {
      getTodayOz: () => entryOn(dailyLog, todayKey).oz,
      onRemoveWater: handleWaterRemoved,
      onClearToday: handleTodayCleared,
    },
  );

  tabHomeBtn.addEventListener("click", () => showTab("home"));
  tabSettingsBtn.addEventListener("click", () => {
    settingsPanel.refresh();
    showTab("settings");
  });

  await setPauseThresholdSeconds(INACTIVITY_THRESHOLD_SECONDS);
  await setReminderConfigs(buildReminderConfigs(settings, pomodoroState));

  const initial = await getState();
  const reconciled = await applyReconcile(settings, pomodoroState, initial.reminders);
  const afterReconcile = reconciled ? await getState() : initial;

  homeView.setIntervalMinutes(settings.reminders.hydration.intervalMs / 60_000);
  homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  isPaused = afterReconcile.globalPause;
  homeView.setPaused(isPaused);
  lastArmed = armedFrom(afterReconcile.reminders);
  homeView.renderReminders(lastArmed);

  if (afterReconcile.activeKind) {
    // Handles a webview reload (e.g. dev hot-reload) happening mid-takeover
    // — active is never persisted across a real restart, so a genuine cold
    // boot never hits this branch.
    takeover.show(afterReconcile.activeKind);
  }

  await onTick((payload) => {
    const idle = isIdle(payload.idleSeconds);
    if (inactiveOverlayEl) inactiveOverlayEl.hidden = !idle;

    if (payload.globalPause !== isPaused) {
      isPaused = payload.globalPause;
      homeView.setPaused(isPaused);
    }

    lastArmed = armedFrom(payload.reminders);
    homeView.renderReminders(lastArmed);

    const hero = nextDue(lastArmed);
    void getCurrentWindow().setTitle(
      hero ? `${REMINDER_LABELS[hero.kind]} ${formatCountdown(hero.remainingMs)} — Flow State` : "Flow State",
    );

    const nowKey = dayKeyOf(payload.nowMs, localTzOffsetMinutes());
    if (nowKey !== todayKey) {
      todayKey = nowKey;
      homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
    }
  });

  await onReminderDue((payload) => {
    void (async () => {
      const kind = payload.kind;

      if (kind === "pomodoro") {
        const advance = advancePomodoro(pomodoroState, {
          focusMs: settings.pomodoro.focusMs,
          breakMs: settings.pomodoro.breakMs,
        });
        pomodoroState = advance.state;
        await savePomodoroState(pomodoroState);
        await setReminderConfigs(buildReminderConfigs(settings, pomodoroState));
        // Pre-arm before rendering the overlay — the budget written now is
        // inert until release_takeover (Rust gates the decrement loop on
        // `active.is_none()`), so it's already in place by the time the
        // user clicks Confirm; no IPC round-trip on that click path.
        await setRemainingMs("pomodoro", advance.nextBudgetMs);
      } else if (settings.reminders[kind].enabled) {
        await setRemainingMs(kind, settings.reminders[kind].intervalMs);
      }
      // Disabled: leave it unarmed — Rust already cleared remaining_ms to
      // null when it fired. Only reachable via the debug test-alert button
      // (a disabled reminder can't fire on its own), but re-arming a
      // disabled kind forever would be a real bug if it ever did.

      if (payload.alertStyle === "takeover") {
        takeover.show(kind);
      }
      // Notify-style: Rust already showed the OS toast: nothing else to do.
    })();
  });
});
