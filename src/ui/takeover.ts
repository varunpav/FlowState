import type { ChimeHandle } from "../audio/chime";
import { cvPrompt, waterEntryUnlocked, type CvStatus } from "../core/cvGate";
import { applySnooze, resetSnoozeState, type SnoozeState } from "../core/snooze";
import type { PomodoroPhase } from "../core/pomodoro";
import type { ReminderKind } from "../core/reminders";
import type { Settings } from "../core/settings";
import { takeoverCopyFor } from "../core/takeoverCopy";
import { shouldOfferTurnOff } from "../core/turnOffPolicy";
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
  /** Shown instead of `confirmRowEl` only when a Pomodoro *focus* session just ended — lets the user pick the break length instead of a single "Start break" confirm. */
  breakChoiceRowEl: HTMLElement;
  shortBreakBtn: HTMLButtonElement;
  longBreakBtn: HTMLButtonElement;
  skipRowEl: HTMLElement;
  skipBtn: HTMLButtonElement;
  snoozeBtn: HTMLButtonElement;
  snoozeHintEl: HTMLElement;
  /** The escape hatch that persistently disables the reminder that just fired — see `core/turnOffPolicy.ts` for when it's actually shown. */
  turnOffRowEl: HTMLElement;
  turnOffBtn: HTMLButtonElement;
  // DEBUG — temporary manual-testing aid, hydration-only. Commented out for
  // now (not deleted) so it's a quick uncomment to bring back for future
  // testing — see the matching commented-out block in main.ts's
  // initTakeover(...) call, the click handler + show() visibility toggle
  // below in this file, and the row in index.html.
  // debugSnoozeRowEl: HTMLElement;
  // debugSnoozeBtn: HTMLButtonElement;
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
  /**
   * The "Turn off" button's action — main.ts owns settings persistence and
   * reconcile, so this just hands it which kind to disable and awaits the
   * settings/Rust side actually clearing that kind's budget before the
   * takeover releases (see the click handler below for why the ordering
   * matters).
   */
  onTurnOffReminder: (kind: ReminderKind) => Promise<void>;
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
 * a drink. **Done** (labeled "Skip" internally — `skipBtn`/`skipRowEl` — a
 * holdover from when it only ever appeared during CV verification) dismisses
 * without logging, sharing `confirm()`'s exact release/reset/hide mechanics
 * — the only difference from a normal confirm is that nothing called
 * `onWaterLogged` first. Shown unconditionally for hydration (not just
 * during CV verification) — a plain "I'm not drinking right now" dismiss
 * that doesn't require snoozing first or reaching for Settings, the way
 * eyeBreak/standUp's own Done button already does for those kinds.
 */
export function initTakeover(
  el: TakeoverElements,
  settings: Settings,
  chime: ChimeHandle,
  callbacks: TakeoverCallbacks,
): Takeover {
  // Keyed per reminder kind — a shared single counter would let snoozing
  // Hydration eat into Pomodoro's/eye break's/stand-up's snooze budget (and
  // vice versa) any time more than one reminder is enabled, since they'd all
  // be reading and exhausting the same count. Missing keys mean "never
  // snoozed," equivalent to resetSnoozeState().
  let snoozeStateByKind: Partial<Record<ReminderKind, SnoozeState>> = {};
  let activeKind: ReminderKind | null = null;
  let waterEntry: WaterEntryHandle | null = null;
  let cvStatus: CvStatus = "off";
  let cvUnlisten: (() => void)[] = [];
  let cvStartupTimeout: ReturnType<typeof setTimeout> | undefined;

  function snoozeStateFor(kind: ReminderKind): SnoozeState {
    return snoozeStateByKind[kind] ?? resetSnoozeState();
  }

  function syncSnoozeAvailability() {
    const exhausted = activeKind !== null && snoozeStateFor(activeKind).snoozeCount >= settings.maxSnoozes;
    el.snoozeBtn.disabled = exhausted;
    el.snoozeBtn.textContent = `Snooze ${settings.snoozeMs / 60_000} min`;
    el.snoozeHintEl.hidden = !exhausted;
    if (exhausted) el.snoozeHintEl.textContent = "No snoozes left — please confirm.";
  }

  function syncTurnOffAvailability() {
    el.turnOffRowEl.hidden =
      activeKind === null || !shouldOfferTurnOff(activeKind, snoozeStateFor(activeKind).snoozeCount);
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
    // skipRowEl (labeled "Done") is NOT tied to CV pane visibility — show()
    // now sets it unconditionally for hydration, on or off. It's just that
    // while CV is active, the water-entry hide/show a few lines down means
    // Done is briefly the ONLY dismiss option on screen.
    el.cvPromptEl.textContent = cvPrompt(status);
    el.cvPromptEl.classList.toggle("cv-verified", status === "verified");
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
    delete snoozeStateByKind[activeKind];
    hide();
  }

  el.confirmBtn.addEventListener("click", () => void confirm());
  // Skip is mechanically identical to confirm() — release, reset snooze,
  // hide — the only difference is nothing logged water first.
  el.skipBtn.addEventListener("click", () => void confirm());

  /**
   * Shared by the real snooze button and the debug 5s shortcut below — the
   * only difference between them is which `snoozeMs` they pass in. Both go
   * through the real applySnooze/snoozeStateByKind bookkeeping, so the debug
   * shortcut genuinely behaves like a (much faster) real snooze: it counts
   * toward maxSnoozes and correctly reveals hydration's Turn off after one
   * use, rather than being a parallel path that silently skips both.
   */
  function doSnooze(kind: ReminderKind, snoozeMs: number) {
    void (async () => {
      const result = applySnooze(snoozeStateFor(kind), Date.now(), {
        snoozeMs,
        maxSnoozes: settings.maxSnoozes,
      });
      if (!result.ok) {
        syncSnoozeAvailability();
        return;
      }
      snoozeStateByKind[kind] = result.state;
      // Overwrites the pre-armed full interval — snoozing means "not the
      // full interval, just a short grace period."
      await setRemainingMs(kind, snoozeMs);
      await releaseTakeover();
      hide();
    })();
  }

  el.snoozeBtn.addEventListener("click", () => {
    if (!activeKind) return;
    doSnooze(activeKind, settings.snoozeMs);
  });

  // DEBUG — temporary manual-testing aid, hydration-only: a fixed 5s snooze
  // for quickly cycling back to another hydration takeover without waiting
  // out the real (usually much longer) settings.snoozeMs. Commented out for
  // now — un-comment together with TakeoverElements' debugSnoozeRowEl/
  // debugSnoozeBtn above, the show() visibility toggle below, main.ts's
  // matching element wiring, and index.html's row to bring it back. Runs
  // through the same doSnooze as the real button above (kept, since Snooze
  // now depends on it too) purely with a shorter duration — so it
  // accurately exercises maxSnoozes exhaustion and Turn off's
  // reveal-after-a-snooze gating, not a separate bypass path.
  // el.debugSnoozeBtn.addEventListener("click", () => {
  //   if (activeKind !== "hydration") return;
  //   doSnooze("hydration", 5_000);
  // });

  el.turnOffBtn.addEventListener("click", () => {
    void (async () => {
      const kind = activeKind;
      if (!kind) return;
      // Must land BEFORE releaseTakeover(): Rust's decrement loop is gated
      // on `active` still being set, so the pre-armed budget stays frozen
      // as long as the takeover is up. Releasing first would open a window
      // where that budget starts counting down again before this clears it.
      await callbacks.onTurnOffReminder(kind);
      await confirm();
    })();
  });

  /**
   * Overwrites whatever main.ts pre-armed `advancePomodoro`'s `nextBudgetMs`
   * to (always the short break) with the user's actual choice — same
   * override-then-release shape as the snooze handler above. Guarded to
   * `activeKind === "pomodoro"` even though these buttons are only ever
   * shown for pomodoro, purely so a stray click can't act on the wrong kind.
   */
  function takeBreak(ms: number) {
    void (async () => {
      if (activeKind !== "pomodoro") return;
      await setRemainingMs("pomodoro", ms);
      await confirm();
    })();
  }
  el.shortBreakBtn.addEventListener("click", () => takeBreak(settings.pomodoro.breakMs));
  el.longBreakBtn.addEventListener("click", () => takeBreak(settings.pomodoro.longBreakMs));

  return {
    show(kind: ReminderKind) {
      activeKind = kind;
      syncSnoozeAvailability();
      syncTurnOffAvailability();
      // DEBUG — temporary, hydration-only, commented out. See the commented-out debugSnoozeBtn listener above.
      // el.debugSnoozeRowEl.hidden = kind !== "hydration";

      // Computed once and reused for both the copy lookup and the
      // break-choice branch below, rather than calling the callback twice
      // and risking the two reads disagreeing.
      const phaseJustEnded = kind === "pomodoro" ? callbacks.getPomodoroPhaseJustEnded() : undefined;
      const copy = takeoverCopyFor(kind, phaseJustEnded);
      el.titleEl.textContent = copy.title;

      // Only a focus session ending offers a break-length choice — a break
      // ending goes back to a single focus session, nothing to choose.
      const showBreakChoice = kind === "pomodoro" && phaseJustEnded === "focus";

      // Done (skipRowEl/skipBtn) is hydration-only, and no longer tied to
      // CV pane visibility (see setCvStatus) — set unconditionally here so
      // it's independent of whichever CV branch runs below.
      el.skipRowEl.hidden = kind !== "hydration";

      if (kind === "hydration") {
        el.confirmRowEl.hidden = true;
        el.breakChoiceRowEl.hidden = true;
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
      } else if (showBreakChoice) {
        el.waterEntryContainerEl.hidden = true;
        el.confirmRowEl.hidden = true;
        el.breakChoiceRowEl.hidden = false;
        el.shortBreakBtn.textContent = `Short break · ${settings.pomodoro.breakMs / 60_000} min`;
        el.longBreakBtn.textContent = `Long break · ${settings.pomodoro.longBreakMs / 60_000} min`;
        setCvStatus("off");
      } else {
        el.waterEntryContainerEl.hidden = true;
        el.breakChoiceRowEl.hidden = true;
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
      // water entry locked, Skip is the primary action instead. The
      // break-choice row focuses Short break as the more common pick.
      const primaryControl =
        kind === "hydration"
          ? waterEntryUnlocked(cvStatus)
            ? el.waterEntryContainerEl.querySelector<HTMLButtonElement>("button")
            : el.skipBtn
          : showBreakChoice
            ? el.shortBreakBtn
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
