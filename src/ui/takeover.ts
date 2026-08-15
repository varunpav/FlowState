import type { ChimeHandle } from "../audio/chime";
import { applySnooze, resetSnoozeState, type SnoozeState } from "../core/snooze";
import type { PomodoroPhase } from "../core/pomodoro";
import type { ReminderKind } from "../core/reminders";
import type { Settings } from "../core/settings";
import { takeoverCopyFor } from "../core/takeoverCopy";
import { releaseTakeover, setRemainingMs } from "../ipc";
import { mountWaterEntry } from "./waterEntry";

export interface TakeoverElements {
  overlayEl: HTMLElement;
  titleEl: HTMLElement;
  waterEntryContainerEl: HTMLElement;
  confirmRowEl: HTMLElement;
  confirmBtn: HTMLButtonElement;
  snoozeBtn: HTMLButtonElement;
  snoozeHintEl: HTMLElement;
}

export interface Takeover {
  show(kind: ReminderKind): void;
}

export interface TakeoverCallbacks {
  onWaterLogged: (oz: number, nowMs: number) => void;
  /** The phase that just ended — always the opposite of the current (already-advanced) Pomodoro phase. */
  getPomodoroPhaseJustEnded: () => PomodoroPhase;
}

/**
 * Generic across all four reminder kinds. Hydration replaces the single
 * confirm button with the water quick-add widget — picking an amount IS the
 * confirmation (requirement: "upon 'I drank water' click the interval
 * should be preloaded before the user confirms", satisfied by the caller
 * pre-arming the next budget via setRemainingMs BEFORE calling show()).
 * Snooze applies uniformly to every takeover-style kind.
 */
export function initTakeover(
  el: TakeoverElements,
  settings: Settings,
  chime: ChimeHandle,
  callbacks: TakeoverCallbacks,
): Takeover {
  let snoozeState: SnoozeState = resetSnoozeState();
  let activeKind: ReminderKind | null = null;

  function syncSnoozeAvailability() {
    const exhausted = snoozeState.snoozeCount >= settings.maxSnoozes;
    el.snoozeBtn.disabled = exhausted;
    el.snoozeBtn.textContent = `Snooze ${settings.snoozeMs / 60_000} min`;
    el.snoozeHintEl.hidden = !exhausted;
    if (exhausted) el.snoozeHintEl.textContent = "No snoozes left — please confirm.";
  }

  function hide() {
    chime.stop();
    el.overlayEl.hidden = true;
    activeKind = null;
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
        mountWaterEntry(el.waterEntryContainerEl, settings.water.bottleOz, (oz) => {
          callbacks.onWaterLogged(oz, Date.now());
          void confirm();
        });
      } else {
        el.waterEntryContainerEl.hidden = true;
        el.confirmRowEl.hidden = false;
        el.confirmBtn.textContent = copy.confirmLabel;
      }

      el.overlayEl.hidden = false;
      chime.start();
    },
  };
}
