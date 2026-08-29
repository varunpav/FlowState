import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createChime } from "./audio/chime";
import { formatCountdown } from "./core/format";
import { isIdle } from "./core/idlePolicy";
import { advancePomodoro, type PomodoroState } from "./core/pomodoro";
import { nextDue, reconcileReminders, REMINDER_KINDS, REMINDER_LABELS, type ArmedReminder } from "./core/reminders";
import type { Settings } from "./core/settings";
import { isStaleTick } from "./core/tickPolicy";
import { timerRowModel } from "./core/timerRow";
import { dayKeyOf, entryOn, logWater, removeWater } from "./core/waterLog";
import {
  getState,
  onReminderDue,
  onTick,
  setPause,
  setPauseThresholdSeconds,
  setReminderConfigs,
  setRemainingMs,
  type PauseReason,
  type ReminderConfig,
  type ReminderSnapshot,
} from "./ipc";
import { loadLog, localTzOffsetMinutes, saveLog } from "./logStore";
import { loadPomodoroState, loadSettings, savePomodoroState, saveSettings } from "./settingsStore";
import { initErrorBanner, reportError } from "./ui/errorBanner";
import { initHistoryView } from "./ui/historyView";
import { initHomeView } from "./ui/homeView";
import { initSettingsPanel } from "./ui/settingsPanel";
import { initTakeover } from "./ui/takeover";

let inactiveOverlayEl: HTMLElement | null;

/** How far ahead of an imminent hydration takeover to start the camera, so it has a frame ready instead of showing blank when the takeover actually appears. */
const CV_PREWARM_MS = 3_000;

/**
 * If no `tick` event has landed in this long, the watchdog below re-syncs
 * from `getState()` directly rather than waiting on a stream that may be
 * dead — comfortably above the normal 1Hz cadence so a single skipped or
 * stale tick doesn't trigger a needless re-sync.
 */
const TICK_WATCHDOG_TIMEOUT_MS = 10_000;
const TICK_WATCHDOG_CHECK_INTERVAL_MS = 5_000;

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

/**
 * Reconcile's only job now is clearing a budget the user just disabled —
 * arming is always an explicit act (the Start button), never a side effect
 * of a settings change. See core/reminders.ts's reconcileReminders docstring.
 */
async function applyReconcile(settings: Settings, snapshot: ReminderSnapshot[]) {
  const actions = reconcileReminders([
    {
      kind: "hydration",
      enabled: settings.reminders.hydration.enabled,
      currentRemainingMs: remainingOf(snapshot, "hydration"),
    },
    {
      kind: "eyeBreak",
      enabled: settings.reminders.eyeBreak.enabled,
      currentRemainingMs: remainingOf(snapshot, "eyeBreak"),
    },
    {
      kind: "standUp",
      enabled: settings.reminders.standUp.enabled,
      currentRemainingMs: remainingOf(snapshot, "standUp"),
    },
    {
      kind: "pomodoro",
      enabled: settings.pomodoro.enabled,
      currentRemainingMs: remainingOf(snapshot, "pomodoro"),
    },
  ]);
  for (const action of actions) {
    await setRemainingMs(action.kind, action.ms).catch((e) => reportError("Updating reminder", e));
  }
  return actions.length > 0;
}

function remainingOf(snapshot: readonly ReminderSnapshot[], kind: ReminderSnapshot["kind"]): number | null {
  return snapshot.find((r) => r.kind === kind)?.remainingMs ?? null;
}

function armedFrom(snapshot: ReminderSnapshot[]): ArmedReminder[] {
  return snapshot
    .filter((r) => r.remainingMs !== null)
    .map((r) => ({ kind: r.kind, remainingMs: r.remainingMs as number }));
}

window.addEventListener("DOMContentLoaded", () => {
  // Uncaught, this silently skips everything after the first failing await —
  // including onTick/onReminderDue registration — leaving a half-wired
  // window with no countdown and no banner explaining why. Same shape as the
  // v2.3 autostart bug errorBanner.ts's docstring describes.
  void boot().catch((e) => reportError("Starting up", e));
});

async function boot() {
  inactiveOverlayEl = document.querySelector("#inactive-overlay");

  const homeViewEl = document.querySelector<HTMLElement>("#home-view")!;
  const historyViewEl = document.querySelector<HTMLElement>("#history-view")!;
  const settingsViewEl = document.querySelector<HTMLElement>("#settings-view")!;
  const tabHomeBtn = document.querySelector<HTMLButtonElement>("#tab-home")!;
  const tabHistoryBtn = document.querySelector<HTMLButtonElement>("#tab-history")!;
  const tabSettingsBtn = document.querySelector<HTMLButtonElement>("#tab-settings")!;

  function showTab(tab: "home" | "history" | "settings") {
    homeViewEl.hidden = tab !== "home";
    historyViewEl.hidden = tab !== "history";
    settingsViewEl.hidden = tab !== "settings";
    tabHomeBtn.classList.toggle("tab-btn-active", tab === "home");
    tabHistoryBtn.classList.toggle("tab-btn-active", tab === "history");
    tabSettingsBtn.classList.toggle("tab-btn-active", tab === "settings");
  }

  const settings = await loadSettings();
  let pomodoroState = await loadPomodoroState();
  let dailyLog = await loadLog();
  let todayKey = dayKeyOf(Date.now(), localTzOffsetMinutes());
  let lastArmed: ArmedReminder[] = [];
  let lastSnapshot: ReminderSnapshot[] = [];
  let lastNowMs = Date.now();
  let pauseReason: PauseReason | null = null;
  let lastTitle = "";
  // Wall-clock time this side last received a `tick` event, live or stale —
  // the watchdog below uses a real gap here (not the payload's own nowMs) to
  // detect a dead event stream regardless of why it went quiet.
  let lastTickAtMs = Date.now();

  const errorBannerEl = document.querySelector<HTMLElement>("#error-banner");
  if (errorBannerEl) initErrorBanner(errorBannerEl);

  const chime = createChime(settings.volume);
  // reminder-due arrives via an IPC event, not a user gesture, so the shared
  // AudioContext needs unlocking from a real click before that, or Chromium's
  // autoplay policy can silently block playback the first time it's needed.
  document.addEventListener("pointerdown", () => chime.unlock(), { once: true });

  function renderTimerRow() {
    homeView.renderTimers(timerRowModel(settings, pomodoroState, lastSnapshot), lastNowMs);
  }

  function handleWaterLogged(oz: number, nowMs: number) {
    const key = dayKeyOf(nowMs, localTzOffsetMinutes());
    dailyLog = logWater(dailyLog, key, oz);
    void saveLog(dailyLog).catch((e) => reportError("Saving water log", e));
    if (key === todayKey) {
      homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
    }
  }

  // Day-aware — the Settings water-history editor can add/remove ounces on
  // any of the last 7 days, not just today. Re-rendering unconditionally is
  // correct even for a day outside today: the 7-day bars and month/year
  // stats both depend on days other than today, so any edit within their
  // range needs to show up immediately.
  function handleWaterAdded(dayKey: string, oz: number) {
    dailyLog = logWater(dailyLog, dayKey, oz);
    void saveLog(dailyLog).catch((e) => reportError("Saving water log", e));
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  function handleWaterHistoryRemoved(dayKey: string, oz: number) {
    dailyLog = removeWater(dailyLog, dayKey, oz);
    void saveLog(dailyLog).catch((e) => reportError("Saving water log", e));
    homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  }

  const takeover = initTakeover(
    {
      overlayEl: document.querySelector("#takeover-overlay")!,
      titleEl: document.querySelector("#takeover-title")!,
      cvPaneEl: document.querySelector("#takeover-cv-pane")!,
      cvFrameEl: document.querySelector("#takeover-cv-frame")!,
      cvPromptEl: document.querySelector("#takeover-cv-prompt")!,
      waterEntryContainerEl: document.querySelector("#takeover-water-entry")!,
      confirmRowEl: document.querySelector("#takeover-confirm-row")!,
      confirmBtn: document.querySelector("#takeover-confirm")!,
      skipRowEl: document.querySelector("#takeover-skip-row")!,
      skipBtn: document.querySelector("#takeover-skip")!,
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
    },
    {
      bottleOz: settings.water.bottleOz,
      onWaterLogged: handleWaterLogged,
      onIntervalChanged: (minutes) => {
        void (async () => {
          // Only ever updates the stored value for whenever the user next
          // presses Start/Reset — arming is always an explicit act; the
          // slider must never start anything on its own.
          settings.reminders.hydration.intervalMs = minutes * 60_000;
          await saveSettings(settings);
          // The Settings hydration card has its own copy of this value —
          // keep it in sync so a later Settings commit can't write the
          // stale figure back and clobber what the user just set here.
          settingsPanel.refresh();
        })().catch((e) => reportError("Updating hydration interval", e));
      },
      onStartTimer: (minutes) => {
        void (async () => {
          // Single two-state toggle. "Armed" means ANYTHING is running, not
          // just hydration — otherwise switching hydration off would strand
          // the button on "Start timer" forever while Pomodoro/eye break
          // keep counting. Read authoritatively from getState() rather than
          // the cached lastSnapshot, which can be up to one tick (≤1s) stale.
          const current = await getState();
          const anyArmed = current.reminders.some((r) => r.remainingMs !== null);

          // Reset the Pomodoro phase on both paths — Reset must never leave
          // it mid-break, and Start must always pick up a changed focus
          // length rather than resuming whatever phase it last left off in.
          pomodoroState = { phase: "focus", completedBlocks: pomodoroState.completedBlocks };
          await savePomodoroState(pomodoroState);
          await setReminderConfigs(buildReminderConfigs(settings, pomodoroState));

          // Clear any pause on both paths — otherwise a reminder armed by
          // Start would come up frozen if a stale "system" pause (from a
          // restart) or a manual tray-pause was still in effect, silently
          // contradicting the whole point of pressing Start. Reset clears
          // it too, since it's meant to return to a genuinely clean slate.
          if (pauseReason !== null) {
            pauseReason = null;
            homeView.setPause(null);
            void setPause(null).catch((e) => reportError("Clearing pause", e));
          }

          if (anyArmed) {
            // Reset: clear every kind unconditionally, including one that
            // was disabled while still armed — Start only arms ENABLED
            // kinds below, so a disabled-but-armed kind would otherwise
            // never get cleared by this path.
            for (const kind of REMINDER_KINDS) {
              await setRemainingMs(kind, null);
            }
          } else {
            // Start: arm only what's enabled, each at its own configured
            // length. Hydration is not special-cased — with it switched
            // off, Start must not hijack the hero by arming it anyway.
            settings.reminders.hydration.intervalMs = minutes * 60_000;
            await saveSettings(settings);
            settingsPanel.refresh();
            if (settings.reminders.hydration.enabled) {
              await setRemainingMs("hydration", settings.reminders.hydration.intervalMs);
            }
            if (settings.reminders.eyeBreak.enabled) {
              await setRemainingMs("eyeBreak", settings.reminders.eyeBreak.intervalMs);
            }
            if (settings.reminders.standUp.enabled) {
              await setRemainingMs("standUp", settings.reminders.standUp.intervalMs);
            }
            if (settings.pomodoro.enabled) {
              await setRemainingMs("pomodoro", settings.pomodoro.focusMs);
            }
          }

          const finalState = await getState();
          lastSnapshot = finalState.reminders;
          // Reconcile against what Rust actually holds rather than trusting
          // the optimistic local clear above — if that fire-and-forget
          // setPause(null) silently failed, the button/hero must still end
          // up matching reality instead of drifting out of sync forever.
          if (finalState.pause !== pauseReason) {
            pauseReason = finalState.pause;
            homeView.setPause(pauseReason);
          }
          renderTimerRow();
        })().catch((e) => reportError("Starting/resetting timers", e));
      },
      onPauseToggle: () => {
        void (async () => {
          // Always toggles to/from "manual" — clicking Pause is always the
          // user asking for it, even if a "system" pause (sleep/restart) is
          // what's currently in effect.
          const next: PauseReason | null = pauseReason === null ? "manual" : null;
          pauseReason = next;
          homeView.setPause(next);
          // Re-render immediately so the hero label swaps to "Paused"
          // without waiting up to a second for the next tick — the pause
          // button's own label already updates instantly via setPause above.
          renderTimerRow();

          try {
            await setPause(next);
          } catch (e) {
            reportError("Toggling pause", e);
          }

          // Confirm against Rust's actual state rather than trusting the
          // optimistic local write above — a silent disagreement here (a
          // failed IPC call, or a dead tick stream that would otherwise
          // never correct it) is exactly what leaves the button and hero
          // stuck lying about whether anything is actually paused.
          try {
            const confirmed = await getState();
            if (confirmed.pause !== pauseReason) {
              pauseReason = confirmed.pause;
              homeView.setPause(pauseReason);
              renderTimerRow();
            }
          } catch (e) {
            reportError("Confirming pause state", e);
          }
        })();
      },
    },
  );

  // Test alert / Test notification live in Settings → Alerts & sound rather
  // than as options threaded through homeView — they're standalone debug
  // triggers, not part of the home page's own state.
  document.querySelector<HTMLButtonElement>("#test-alert")!.addEventListener("click", () => {
    // Always hydration — an unpredictable "whatever's next-due" target
    // made this button confusing to use for its actual purpose.
    void setRemainingMs("hydration", 10_000).catch((e) => reportError("Starting test alert", e));
  });
  document.querySelector<HTMLButtonElement>("#test-notification")!.addEventListener("click", () => {
    void (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (granted) {
        sendNotification({ title: "Flow State", body: "Test notification" });
      }
    })().catch((e) => reportError("Sending test notification", e));
  });

  const settingsPanel = initSettingsPanel(
    {
      remindersContainerEl: document.querySelector("#settings-reminders-container")!,
      testSoundBtn: document.querySelector("#settings-test-sound")!,
      statusEl: document.querySelector("#settings-status")!,
      bottleOzInput: document.querySelector("#settings-bottle-oz")!,
      dailyGoalOzInput: document.querySelector("#settings-daily-goal-oz")!,
      waterDayPrevBtn: document.querySelector("#settings-water-day-prev")!,
      waterDayLabelEl: document.querySelector("#settings-water-day-label")!,
      waterDayNextBtn: document.querySelector("#settings-water-day-next")!,
      waterAmountInput: document.querySelector("#settings-water-amount")!,
      addWaterBtn: document.querySelector("#settings-add-water")!,
      removeWaterBtn: document.querySelector("#settings-remove-water")!,
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
      // Called on every settings change now — there is no Save button, so
      // this no longer navigates back to Home; the user is still editing.
      void (async () => {
        homeView.setBottleOz(updated.water.bottleOz);
        // Only move the slider if the value actually differs from what it
        // currently reads — otherwise an unrelated commit (e.g. toggling
        // Pomodoro) would yank the slider out from under a value the user
        // just set on the home page and hasn't committed from there.
        const updatedMinutes = updated.reminders.hydration.intervalMs / 60_000;
        if (updatedMinutes !== homeView.getIntervalMinutes()) {
          homeView.setIntervalMinutes(updatedMinutes);
        }
        homeView.renderWater(dailyLog, todayKey, updated.water.dailyGoalOz);
        await setPauseThresholdSeconds(updated.idlePause.thresholdSeconds);
        await setReminderConfigs(buildReminderConfigs(updated, pomodoroState));
        const snapshot = (await getState()).reminders;
        const reconciledNow = await applyReconcile(updated, snapshot);
        lastSnapshot = reconciledNow ? (await getState()).reminders : snapshot;
        renderTimerRow();
      })().catch((e) => reportError("Applying settings", e));
    },
    {
      getTodayKey: () => todayKey,
      getOzFor: (dayKey) => entryOn(dailyLog, dayKey).oz,
      onAddWater: handleWaterAdded,
      onRemoveWater: handleWaterHistoryRemoved,
    },
  );

  const historyView = initHistoryView({
    heatmapEl: document.querySelector("#history-heatmap")!,
    yearLabelEl: document.querySelector("#history-year-label")!,
    yearPrevBtn: document.querySelector("#history-year-prev")!,
    yearNextBtn: document.querySelector("#history-year-next")!,
  });

  tabHomeBtn.addEventListener("click", () => showTab("home"));
  tabHistoryBtn.addEventListener("click", () => {
    historyView.render(dailyLog, todayKey, settings.water.dailyGoalOz);
    showTab("history");
  });
  tabSettingsBtn.addEventListener("click", () => {
    settingsPanel.refresh();
    showTab("settings");
  });

  await setPauseThresholdSeconds(settings.idlePause.thresholdSeconds).catch((e) => reportError("Starting up", e));
  await setReminderConfigs(buildReminderConfigs(settings, pomodoroState)).catch((e) => reportError("Starting up", e));

  const initial = await getState();
  // Startup never auto-arms anything — reconcile only ever disarms a
  // reminder the user disabled, and there's nothing to disarm on a cold
  // boot. A restored non-null budget from a previous run still resumes
  // untouched; a never-armed reminder stays idle until the user presses
  // Start.
  const reconciled = await applyReconcile(settings, initial.reminders);
  const afterReconcile = reconciled ? await getState() : initial;

  homeView.setIntervalMinutes(settings.reminders.hydration.intervalMs / 60_000);
  homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
  // Rust derives this fresh on every launch (a restored non-null budget
  // implies a "system" pause — see lib.rs's .setup()) rather than restoring
  // a persisted flag, so a countdown never silently resumes across a
  // restart.
  pauseReason = afterReconcile.pause;
  homeView.setPause(pauseReason);
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
    // Any tick reaching here at all is evidence the event stream is alive —
    // record it before the staleness check below, so the watchdog's "no
    // tick in 10s" gap tracks real silence, not just skipped stale ones.
    lastTickAtMs = Date.now();
    // A tick queued behind a sleep/resume backlog (or any other delivery
    // delay) is already superseded by whatever tick is next in the queue —
    // rendering it would just repaint with numbers about to be overwritten.
    if (isStaleTick(payload.nowMs, Date.now())) return;

    // Force-hidden when idle-pause is off — the overlay would otherwise
    // claim "Paused" while every timer deliberately keeps running, which is
    // a lie the user explicitly opted out of via the Settings switch.
    const idle = settings.idlePause.enabled && isIdle(payload.idleSeconds, settings.idlePause.thresholdSeconds);
    if (inactiveOverlayEl) inactiveOverlayEl.hidden = !idle;

    if (payload.pause !== pauseReason) {
      // Covers a sleep-gap or restart pause the tick loop decided on its
      // own — the button/hero must reflect it even though nothing on this
      // side of the IPC boundary requested it.
      pauseReason = payload.pause;
      homeView.setPause(pauseReason);
    }

    lastArmed = armedFrom(payload.reminders);
    lastSnapshot = payload.reminders;
    lastNowMs = payload.nowMs;
    renderTimerRow();

    // Pre-warm the camera a few seconds ahead of an imminent hydration
    // takeover — gated on !pause so a paused reminder frozen just under the
    // threshold can't leave the camera running indefinitely with nothing
    // ever firing to justify it. cancelCvPrewarm() is a safe no-op when
    // there's nothing to cancel or a takeover is already showing.
    const hydrationRemainingMs = payload.reminders.find((r) => r.kind === "hydration")?.remainingMs ?? null;
    const hydrationDueSoon =
      settings.cv.enabled &&
      // "Camera verification (CV)" can be toggled on while hydration's own
      // Attention Grabber is set to Notification (dimmed in Settings, but
      // not forced off — see settingsPanel.ts's syncCvRowDisabled). A
      // notify-style reminder never opens the takeover at all, so
      // pre-warming for one would just leave the camera running for nothing.
      settings.reminders.hydration.alertStyle === "takeover" &&
      payload.pause === null &&
      hydrationRemainingMs !== null &&
      hydrationRemainingMs <= CV_PREWARM_MS;
    if (hydrationDueSoon) {
      takeover.prewarmCv();
    } else {
      takeover.cancelCvPrewarm();
    }

    const hero = nextDue(lastArmed);
    const title = hero ? `${REMINDER_LABELS[hero.kind]} ${formatCountdown(hero.remainingMs)} — Flow State` : "Flow State";
    if (title !== lastTitle) {
      lastTitle = title;
      void getCurrentWindow()
        .setTitle(title)
        .catch((e) => reportError("Updating window title", e));
    }

    const nowKey = dayKeyOf(payload.nowMs, localTzOffsetMinutes());
    if (nowKey !== todayKey) {
      todayKey = nowKey;
      homeView.renderWater(dailyLog, todayKey, settings.water.dailyGoalOz);
    }
  });

  // A dead tick stream (the `should_emit_tick` gate skipping every tick
  // while hidden is expected, but anything else going quiet is not) must
  // never leave the app silently stuck on stale numbers with no way back —
  // that combination is exactly what made the countdown-freeze bug this
  // watchdog exists for so hard to recover from: no error, no fresh data,
  // and every button acting on state that stopped being true hours ago.
  setInterval(() => {
    if (Date.now() - lastTickAtMs < TICK_WATCHDOG_TIMEOUT_MS) return;
    // Treat this attempt as handled regardless of outcome, so a
    // persistently broken IPC channel retries at this same cadence instead
    // of spamming the error banner every check.
    lastTickAtMs = Date.now();
    void (async () => {
      try {
        const state = await getState();
        lastArmed = armedFrom(state.reminders);
        lastSnapshot = state.reminders;
        lastNowMs = state.nowMs;
        if (state.pause !== pauseReason) {
          pauseReason = state.pause;
          homeView.setPause(pauseReason);
        }
        renderTimerRow();
      } catch (e) {
        reportError("Reconnecting after a stalled tick stream", e);
      }
    })();
  }, TICK_WATCHDOG_CHECK_INTERVAL_MS);

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
    })().catch((e) => reportError("Handling reminder", e));
  });
}
