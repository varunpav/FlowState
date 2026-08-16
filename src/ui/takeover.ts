import type { ChimeHandle } from "../audio/chime";
import { cvPrompt, waterEntryUnlocked, type CvStatus } from "../core/cvGate";
import { applySnooze, resetSnoozeState, type SnoozeState } from "../core/snooze";
import type { PomodoroPhase } from "../core/pomodoro";
import type { ReminderKind } from "../core/reminders";
import type { Settings } from "../core/settings";
import { takeoverCopyFor } from "../core/takeoverCopy";
import { cvStart, cvStop, onCvError, onCvFrame, onCvReady, onCvVerified } from "../cv";
import { releaseTakeover, setRemainingMs } from "../ipc";
import { mountWaterEntry, type WaterEntryHandle } from "./waterEntry";

const CV_STARTUP_TIMEOUT_MS = 8_000;

export interface TakeoverElements {
  overlayEl: HTMLElement;
  titleEl: HTMLElement;
  cvPaneEl: HTMLElement;
  cvFrameEl: HTMLImageElement;
  cvPromptEl: HTMLElement;
  waterEntryContainerEl: HTMLElement;
  confirmRowEl: HTMLElement;
  confirmBtn: HTMLButtonElement;
  skipRowEl: HTMLElement;
  skipBtn: HTMLButtonElement;
  snoozeBtn: HTMLButtonElement;
  snoozeHintEl: HTMLElement;
}

export interface Takeover {
  show(kind: ReminderKind): void;
  /**
   * Starts the camera process ahead of an imminent hydration takeover
   * (main.ts calls this once hydration's remaining time drops to a few
   * seconds), so a frame is already flowing by the time `show()` actually
   * runs instead of the camera pane starting blank. A no-op if CV is off,
   * already active, or a takeover is currently showing.
   */
  prewarmCv(): void;
  /**
   * Stops a pre-warmed camera that never turned into a real takeover — the
   * reminder got paused, reset, or CV got disabled before it fired. Never
   * cancels while a takeover is actually showing; that's `hide()`'s job.
   */
  cancelCvPrewarm(): void;
}

export interface TakeoverCallbacks {
  onWaterLogged: (oz: number, nowMs: number) => void;
  /** The phase that just ended — always the opposite of the current (already-advanced) Pomodoro phase. */
  getPomodoroPhaseJustEnded: () => PomodoroPhase;
}

/**
 * Generic across all four reminder kinds. Hydration replaces the single
 * confirm button with the water quick-add widget — picking an amount IS the
 * confirmation. Snooze applies uniformly to every takeover-style kind.
 *
 * CV drink verification (settings.cv.enabled) only ever applies to the
 * hydration kind. When it's on, the water-entry widget stays visible but
 * `setEnabled(false)` locks its buttons until `core/cvGate.ts`'s
 * `waterEntryUnlocked` says otherwise — which includes a broken camera
 * (`"failed"`), so a webcam problem can never trap the user out of logging
 * a drink. **Skip** dismisses without logging, sharing `confirm()`'s exact
 * release/reset/hide mechanics — the only difference from a normal confirm
 * is that nothing called `onWaterLogged` first.
 */
export function initTakeover(
  el: TakeoverElements,
  settings: Settings,
  chime: ChimeHandle,
  callbacks: TakeoverCallbacks,
): Takeover {
  let snoozeState: SnoozeState = resetSnoozeState();
  let activeKind: ReminderKind | null = null;
  let waterEntry: WaterEntryHandle | null = null;
  let cvStatus: CvStatus = "off";
  let cvUnlisten: (() => void)[] = [];
  let cvStartupTimeout: ReturnType<typeof setTimeout> | undefined;

  function syncSnoozeAvailability() {
    const exhausted = snoozeState.snoozeCount >= settings.maxSnoozes;
    el.snoozeBtn.disabled = exhausted;
    el.snoozeBtn.textContent = `Snooze ${settings.snoozeMs / 60_000} min`;
    el.snoozeHintEl.hidden = !exhausted;
    if (exhausted) el.snoozeHintEl.textContent = "No snoozes left — please confirm.";
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !el.snoozeBtn.disabled) {
      event.preventDefault();
      el.snoozeBtn.click();
    }
  }

  function clearCvStartupTimeout() {
    if (cvStartupTimeout !== undefined) {
      clearTimeout(cvStartupTimeout);
      cvStartupTimeout = undefined;
    }
  }

  function setCvStatus(status: CvStatus) {
    cvStatus = status;
    const showPane = status !== "off";
    el.cvPaneEl.hidden = !showPane;
    el.skipRowEl.hidden = !showPane;
    el.cvPromptEl.textContent = cvPrompt(status);
    const unlocked = waterEntryUnlocked(status);
    waterEntry?.setEnabled(unlocked);
    // While CV is actually in play (starting/watching/verified/failed),
    // hide the water-entry buttons entirely rather than showing them
    // visibly disabled next to Skip — a grayed-out "Add" sitting beside an
    // active Skip button read as a second, redundant dismiss action.
    // Guarded to `status !== "off"` so this never fights show()'s own
    // handling of the non-CV and non-hydration cases, which set
    // waterEntryContainerEl.hidden directly before setCvStatus("off") runs.
    if (status !== "off") {
      el.waterEntryContainerEl.hidden = !unlocked;
    }
  }

  /** Idempotent and best-effort — the camera light must go out regardless of whether the process was actually running or the IPC call itself fails. */
  function stopCv() {
    clearCvStartupTimeout();
    for (const unlisten of cvUnlisten) unlisten();
    cvUnlisten = [];
    void cvStop().catch((err: unknown) => console.error("Failed to stop the camera process:", err));
  }

  function startCv() {
    el.cvFrameEl.src = ""; // clear any frame left over from a previous session
    setCvStatus("starting");
    // A camera that never produces a first frame (a hung process, a
    // permission prompt nobody answers) must not leave the takeover looking
    // frozen — fail open after a bounded wait rather than hanging forever.
    cvStartupTimeout = setTimeout(() => setCvStatus("failed"), CV_STARTUP_TIMEOUT_MS);

    void (async () => {
      // Register every listener before spawning the process, so a fast
      // "ready"/"frame" can never arrive before something is listening.
      const [unlistenReady, unlistenFrame, unlistenVerified, unlistenError] = await Promise.all([
        onCvReady(() => {
          clearCvStartupTimeout();
          if (cvStatus === "starting") setCvStatus("watching");
        }),
        onCvFrame((payload) => {
          clearCvStartupTimeout();
          el.cvFrameEl.src = `data:image/jpeg;base64,${payload.jpeg}`;
          if (cvStatus === "starting") setCvStatus("watching");
        }),
        onCvVerified(() => {
          clearCvStartupTimeout();
          setCvStatus("verified");
        }),
        onCvError((payload) => {
          clearCvStartupTimeout();
          console.error("CV detector error:", payload.code, payload.message);
          setCvStatus("failed");
        }),
      ]);
      cvUnlisten = [unlistenReady, unlistenFrame, unlistenVerified, unlistenError];

      try {
        await cvStart();
      } catch (err) {
        clearCvStartupTimeout();
        console.error("Failed to start the camera process:", err);
        setCvStatus("failed");
      }
    })();
  }

  function hide() {
    chime.stop();
    el.overlayEl.hidden = true;
    activeKind = null;
    stopCv();
    setCvStatus("off");
    document.removeEventListener("keydown", handleKeydown);
  }

  async function confirm() {
    if (!activeKind) return;
    // No budget call here on purpose — the next interval was already
    // pre-armed by the caller before show() ran, so this click has nothing
    // left to wait on.
    await releaseTakeover();
    snoozeState = resetSnoozeState();
    hide();
  }

  el.confirmBtn.addEventListener("click", () => void confirm());
  // Skip is mechanically identical to confirm() — release, reset snooze,
  // hide — the only difference is nothing logged water first.
  el.skipBtn.addEventListener("click", () => void confirm());

  el.snoozeBtn.addEventListener("click", () => {
    void (async () => {
      const result = applySnooze(snoozeState, Date.now(), {
        snoozeMs: settings.snoozeMs,
        maxSnoozes: settings.maxSnoozes,
      });
      if (!result.ok) {
        syncSnoozeAvailability();
        return;
      }
      snoozeState = result.state;
      const kind = activeKind;
      if (kind) {
        // Overwrites the pre-armed full interval — snoozing means "not the
        // full interval, just a short grace period."
        await setRemainingMs(kind, settings.snoozeMs);
      }
      await releaseTakeover();
      hide();
    })();
  });

  return {
    show(kind: ReminderKind) {
      activeKind = kind;
      syncSnoozeAvailability();

      const copy = takeoverCopyFor(kind, kind === "pomodoro" ? callbacks.getPomodoroPhaseJustEnded() : undefined);
      el.titleEl.textContent = copy.title;

      if (kind === "hydration") {
        el.confirmRowEl.hidden = true;
        el.waterEntryContainerEl.hidden = false;
        waterEntry = mountWaterEntry(el.waterEntryContainerEl, settings.water.bottleOz, (oz) => {
          callbacks.onWaterLogged(oz, Date.now());
          void confirm();
        });

        if (settings.cv.enabled) {
          if (cvStatus === "off") {
            // No pre-warm in flight (e.g. CV was only just enabled, too
            // late for main.ts's ~3s-ahead prewarmCv() to have caught it)
            // — start fresh here as a fallback.
            startCv();
          } else {
            // Already starting/watching/verified/failed from a prewarm —
            // reuse it rather than spawning a second process. Re-apply the
            // current status to the elements this call just (re)created,
            // in particular the fresh `waterEntry` from mountWaterEntry above.
            setCvStatus(cvStatus);
          }
        } else {
          setCvStatus("off");
        }
      } else {
        el.waterEntryContainerEl.hidden = true;
        el.confirmRowEl.hidden = false;
        el.confirmBtn.textContent = copy.confirmLabel;
        setCvStatus("off");
      }

      el.overlayEl.hidden = false;
      chime.start();

      // Idempotent against a show() firing twice without an intervening
      // hide() (e.g. a dev-mode webview reload mid-takeover) — remove
      // before add, so Escape can never fire the snooze handler twice.
      document.removeEventListener("keydown", handleKeydown);
      document.addEventListener("keydown", handleKeydown);

      // Focus a native control so Enter/Space work with no extra handling.
      // Hydration normally focuses its first quick-add button; while CV has
      // water entry locked, Skip is the primary action instead.
      const primaryControl =
        kind === "hydration"
          ? waterEntryUnlocked(cvStatus)
            ? el.waterEntryContainerEl.querySelector<HTMLButtonElement>("button")
            : el.skipBtn
          : el.confirmBtn;
      primaryControl?.focus();
    },

    prewarmCv() {
      if (!settings.cv.enabled) return;
      if (cvStatus !== "off") return; // already warming, active, or failed — nothing to do
      if (activeKind !== null) return; // a different takeover is showing right now; don't turn the camera on behind it
      startCv();
    },

    cancelCvPrewarm() {
      if (activeKind !== null) return; // never cancel while a real takeover is showing — that's hide()'s job
      if (cvStatus === "off") return; // nothing to cancel
      stopCv();
      setCvStatus("off");
    },
  };
}
