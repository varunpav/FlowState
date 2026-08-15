import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createChime } from "./audio/chime";
import { formatCountdown } from "./core/format";
import { isIdle } from "./core/idlePolicy";
import { advancePomodoro, type PomodoroState } from "./core/pomodoro";
import {
  nextDue,
  reconcileReminders,
  REMINDER_KINDS,
  REMINDER_LABELS,
  type ArmedReminder,
  type ReminderKind,
} from "./core/reminders";
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
import { initHomeView, type TimerRowEntry } from "./ui/homeView";
import { initSettingsPanel } from "./ui/settingsPanel";
import { initTakeover } from "./ui/takeover";

let inactiveOverlayEl: HTMLElement | null;

function buildReminderConfigs(settings: Settings, pomodoroState: PomodoroState): ReminderConfig[] {
  const pauseWhenIdle = settings.idlePause.enabled;
  return [
    { kind: "hydration", alertStyle: settings.reminders.hydration.alertStyle, pauseWhenIdle },
    { kind: "eyeBreak", alertStyle: settings.reminders.eyeBreak.alertStyle, pauseWhenIdle },
    { kind: "standUp", alertStyle: settings.reminders.standUp.alertStyle, pauseWhenIdle },
    // The one exception to "everything pauses when idle" — walking away IS
    // the Pomodoro break. The idle-pause switch can only ever make things
    // LESS pause-y (turn it off, nothing ever pauses); it must never
    // resurrect pausing on a break by dropping this half of the condition.
    {
      kind: "pomodoro",
      alertStyle: settings.pomodoro.alertStyle,
      pauseWhenIdle: pauseWhenIdle && pomodoroState.phase !== "break",
    },
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

function isKindEnabled(settings: Settings, kind: Exclude<ReminderKind, "hydration">): boolean {
  return kind === "pomodoro" ? settings.pomodoro.enabled : settings.reminders[kind].enabled;
}

/**
 * Hydration is always the hero; the rest render as a small fixed-order row
 * underneath, filtered to enabled kinds only (an enabled-but-not-yet-armed
 * kind still shows — as an em dash — so the row doesn't reflow every time a
 * reminder fires and re-arms).
 */
function timerRowFrom(
  settings: Settings,
  snapshot: ReminderSnapshot[],
): { hydrationMs: number | null; secondary: TimerRowEntry[] } {
  const remainingOf = (kind: ReminderKind) => snapshot.find((r) => r.kind === kind)?.remainingMs ?? null;
  const secondary: TimerRowEntry[] = REMINDER_KINDS.filter(
    (k): k is Exclude<ReminderKind, "hydration"> => k !== "hydration",
  )
    .filter((k) => isKindEnabled(settings, k))
    .map((kind) => ({ kind, remainingMs: remainingOf(kind) }));
  return { hydrationMs: remainingOf("hydration"), secondary };
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
  let lastSnapshot: ReminderSnapshot[] = [];
  let isPaused = false;

  const chime = createChime(settings.volume);
  // reminder-due arrives via an IPC event, not a user gesture, so the shared
  // AudioContext needs unlocking from a real click before that, or Chromium's
  // autoplay policy can silently block playback the first time it's needed.
  document.addEventListener("pointerdown", () => chime.unlock(), { once: true });

  function renderTimerRow() {
    const timers = timerRowFrom(settings, lastSnapshot);
    homeView.renderTimers(timers.hydrationMs, timers.secondary);
  }

  function handleWaterLogged(oz: number, nowMs: number) {
    const key = dayKeyOf(nowMs, localTzOffsetMinutes());
    dailyLog = logWater(dailyLog, key, oz);
    void saveLog(dailyLog);
    if (key === todayKey) {
      homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
    }
  }

  // Day-aware — the Settings water-history editor can add/remove/clear any
  // of the last 7 days, not just today. Re-rendering unconditionally is
  // correct even for a day outside today: the 7-day bars and month/year
  // stats both depend on days other than today, so any edit within their
  // range needs to show up immediately.
  function handleWaterAdded(dayKey: string, oz: number) {
    dailyLog = logWater(dailyLog, dayKey, oz);
    void saveLog(dailyLog);
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  function handleWaterHistoryRemoved(dayKey: string, oz: number) {
    dailyLog = removeWater(dailyLog, dayKey, oz);
    void saveLog(dailyLog);
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  function handleDayCleared(dayKey: string) {
    dailyLog = clearDay(dailyLog, dayKey);
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
      startTimerBtn: document.querySelector("#start-timer")!,
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
      onStartTimer: (minutes) => {
        void (async () => {
          // Unconditional, unlike the slider's onIntervalChanged — this is
          // the explicit "start it now" gesture, so it arms/restarts even
          // if hydration is already counting down.
          const ms = minutes * 60_000;
          settings.reminders.hydration.intervalMs = ms;
          await saveSettings(settings);
          await setRemainingMs("hydration", ms);
        })();
      },
      onPauseToggle: () => {
        const next = !isPaused;
        isPaused = next;
        homeView.setPaused(next);
        // Re-render immediately so the hero label swaps to "Paused" without
        // waiting up to a second for the next tick — the pause button's own
        // label already updates instantly via setPaused above.
        renderTimerRow();
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
      waterDaySelect: document.querySelector("#settings-water-day")!,
      waterLoggedEl: document.querySelector("#settings-water-logged")!,
      waterAmountInput: document.querySelector("#settings-water-amount")!,
      addWaterBtn: document.querySelector("#settings-add-water")!,
      removeWaterBtn: document.querySelector("#settings-remove-water")!,
      clearDayBtn: document.querySelector("#settings-clear-day")!,
      snoozeInput: document.querySelector("#settings-snooze")!,
      maxSnoozesInput: document.querySelector("#settings-max-snoozes")!,
      volumeInput: document.querySelector("#settings-volume")!,
      idlePauseSwitchContainerEl: document.querySelector("#settings-idle-pause-switch")!,
      idlePauseThresholdRowEl: document.querySelector("#settings-idle-pause-threshold-row")!,
      idlePauseThresholdInput: document.querySelector("#settings-idle-pause-threshold")!,
      startWithWindowsContainerEl: document.querySelector("#settings-start-with-windows-switch")!,
    },
    settings,
    chime,
    (updated) => {
      void (async () => {
        homeView.setBottleOz(updated.water.bottleOz);
        homeView.setIntervalMinutes(updated.reminders.hydration.intervalMs / 60_000);
        homeView.renderWater(dailyLog, todayKey, updated.water.dailyGoalOz);
        await setPauseThresholdSeconds(updated.idlePause.thresholdSeconds);
        await setReminderConfigs(buildReminderConfigs(updated, pomodoroState));
        const snapshot = (await getState()).reminders;
        const reconciledNow = await applyReconcile(updated, pomodoroState, snapshot);
        lastSnapshot = reconciledNow ? (await getState()).reminders : snapshot;
        renderTimerRow();
        showTab("home");
      })();
    },
    {
      getTodayKey: () => todayKey,
      getOzFor: (dayKey) => entryOn(dailyLog, dayKey).oz,
      onAddWater: handleWaterAdded,
      onRemoveWater: handleWaterHistoryRemoved,
      onClearDay: handleDayCleared,
    },
  );

  tabHomeBtn.addEventListener("click", () => showTab("home"));
  tabSettingsBtn.addEventListener("click", () => {
    settingsPanel.refresh();
    showTab("settings");
  });

  await setPauseThresholdSeconds(settings.idlePause.thresholdSeconds);
  await setReminderConfigs(buildReminderConfigs(settings, pomodoroState));

  const initial = await getState();
  const reconciled = await applyReconcile(settings, pomodoroState, initial.reminders);
  const afterReconcile = reconciled ? await getState() : initial;

  homeView.setIntervalMinutes(settings.reminders.hydration.intervalMs / 60_000);
  homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  isPaused = afterReconcile.globalPause;
  homeView.setPaused(isPaused);
  lastArmed = armedFrom(afterReconcile.reminders);
  lastSnapshot = afterReconcile.reminders;
  renderTimerRow();

  if (afterReconcile.activeKind) {
    // Handles a webview reload (e.g. dev hot-reload) happening mid-takeover
    // — active is never persisted across a real restart, so a genuine cold
    // boot never hits this branch.
    takeover.show(afterReconcile.activeKind);
  }

  await onTick((payload) => {
    // Force-hidden when idle-pause is off — the overlay would otherwise
    // claim "Paused" while every timer deliberately keeps running, which is
    // a lie the user explicitly opted out of via the Settings switch.
    const idle = settings.idlePause.enabled && isIdle(payload.idleSeconds, settings.idlePause.thresholdSeconds);
    if (inactiveOverlayEl) inactiveOverlayEl.hidden = !idle;

    if (payload.globalPause !== isPaused) {
      isPaused = payload.globalPause;
      homeView.setPaused(isPaused);
    }

    lastArmed = armedFrom(payload.reminders);
    lastSnapshot = payload.reminders;
    renderTimerRow();

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
