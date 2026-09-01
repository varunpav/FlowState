import { REMINDER_LABELS } from "../core/reminders";
import { formatClockTime, formatCountdown } from "../core/format";
import type { TimerRowModel } from "../core/timerRow";
import { entryOn, goalStreak, lastNDays, monthToDate, yearToDate, type DailyLog } from "../core/waterLog";
import type { PauseReason } from "../ipc";
import { mountWaterEntry, type WaterEntryHandle } from "./waterEntry";

const RING_RADIUS = 54;
const RING_STROKE = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Only meaningful while hydration is actually running — the idle/off hero states use their own fixed labels regardless of pauseReason. */
function hydrationHeroLabel(pauseReason: PauseReason | null): string {
  if (pauseReason === "system") return "System restart - Paused";
  if (pauseReason === "manual") return "Paused";
  return REMINDER_LABELS.hydration;
}

export interface HomeViewElements {
  heroEl: HTMLElement;
  heroLabelEl: HTMLElement;
  heroCountdownEl: HTMLElement;
  chipsEl: HTMLElement;
  ringContainerEl: HTMLElement;
  barsContainerEl: HTMLElement;
  streakEl: HTMLElement;
  monthStatsEl: HTMLElement;
  yearStatsEl: HTMLElement;
  waterEntryContainerEl: HTMLElement;
  intervalSliderEl: HTMLInputElement;
  intervalSliderValueEl: HTMLElement;
  startTimerBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
}

export interface HomeViewOptions {
  bottleOz: number;
  onWaterLogged: (oz: number, nowMs: number) => void;
  /** Slider is bound to `change`, not `input` — firing per-pixel would spam settings writes. Only ever updates the stored value; never arms anything on its own. */
  onIntervalChanged: (minutes: number) => void;
  /**
   * The Start/Reset timer button — a single two-state toggle. The caller
   * (main.ts) decides which action this is by checking whether hydration is
   * currently armed: unarmed arms everything enabled at its slider/settings
   * value, armed blanks everything back to unarmed. `minutes` is always the
   * slider's current value, used only by the arm path.
   */
  onStartTimer: (minutes: number) => void;
  onPauseToggle: () => void;
}

export interface HomeView {
  /**
   * Hero is always Hydration; `model.secondary` is pre-filtered to enabled
   * kinds, in fixed order. `nowMs` renders the idle/off-hero placeholder
   * clock — it's ignored once hydration is armed.
   */
  renderTimers(model: TimerRowModel, nowMs: number): void;
  renderWater(log: DailyLog, todayKey: string, goalOz: number): void;
  setBottleOz(oz: number): void;
  setIntervalMinutes(minutes: number): void;
  /** What the slider currently reads, in minutes — lets callers avoid clobbering an in-progress edit. */
  getIntervalMinutes(): number;
  /** `null` = running. `"system"` gets its own hero wording (see renderTimers) — a sleep/restart pause reads differently from one the user asked for. */
  setPause(reason: PauseReason | null): void;
}

function buildRing(
  container: HTMLElement,
): { setProgress(fraction: number): void; setLabel(ozText: string, goalText: string): void } {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("class", "ring-svg");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "60");
  track.setAttribute("cy", "60");
  track.setAttribute("r", String(RING_RADIUS));
  track.setAttribute("stroke-width", String(RING_STROKE));
  track.setAttribute("class", "ring-track");

  const progress = document.createElementNS(SVG_NS, "circle");
  progress.setAttribute("cx", "60");
  progress.setAttribute("cy", "60");
  progress.setAttribute("r", String(RING_RADIUS));
  progress.setAttribute("stroke-width", String(RING_STROKE));
  progress.setAttribute("stroke-linecap", "round");
  progress.setAttribute("class", "ring-progress");
  progress.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
  progress.setAttribute("transform", "rotate(-90 60 60)");

  svg.append(track, progress);

  const label = document.createElement("div");
  label.className = "ring-label";

  const ozEl = document.createElement("span");
  ozEl.className = "ring-label-oz";
  const goalEl = document.createElement("span");
  goalEl.className = "ring-label-goal";
  label.append(ozEl, goalEl);

  container.replaceChildren(svg, label);

  return {
    setProgress(fraction: number) {
      const clamped = Math.min(1, Math.max(0, fraction));
      progress.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - clamped)));
    },
    setLabel(ozText: string, goalText: string) {
      ozEl.textContent = ozText;
      goalEl.textContent = goalText;
    },
  };
}

// Two letters, not one — "T" alone doesn't say Tuesday or Thursday, "S"
// doesn't say Saturday or Sunday. Indexed by Date.getUTCDay() (0 = Sunday).
const DAY_LETTERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const DAYS_IN_BAR_ROW = 7;

function buildBars(container: HTMLElement): { render(log: DailyLog, todayKey: string, goalOz: number): void } {
  const barEls: { fill: HTMLElement; letter: HTMLElement }[] = [];

  const goalLine = document.createElement("div");
  goalLine.className = "bars-goal-line";

  const row = document.createElement("div");
  row.className = "bars-row";

  for (let i = 0; i < DAYS_IN_BAR_ROW; i++) {
    const col = document.createElement("div");
    col.className = "bars-col";

    const fill = document.createElement("div");
    fill.className = "bars-fill";

    const letter = document.createElement("div");
    letter.className = "bars-letter";

    col.append(fill, letter);
    row.append(col);
    barEls.push({ fill, letter });
  }

  const wrap = document.createElement("div");
  wrap.className = "bars-wrap";
  wrap.append(goalLine, row);
  container.replaceChildren(wrap);

  return {
    render(log: DailyLog, todayKey: string, goalOz: number) {
      const entries = lastNDays(log, todayKey, DAYS_IN_BAR_ROW);
      const maxOz = Math.max(goalOz, ...entries.map((d) => d.entry.oz));
      const goalFraction = maxOz > 0 ? goalOz / maxOz : 0;
      goalLine.style.bottom = `${goalFraction * 100}%`;

      entries.forEach((d, i) => {
        const bar = barEls[i];
        if (!bar) return;
        const fraction = maxOz > 0 ? d.entry.oz / maxOz : 0;
        bar.fill.style.height = `${Math.max(2, fraction * 100)}%`;
        bar.fill.classList.toggle("bars-fill-goal-hit", d.entry.oz >= goalOz);
        bar.fill.classList.toggle("bars-fill-today", d.dayKey === todayKey);
        const dayOfWeek = new Date(`${d.dayKey}T00:00:00Z`).getUTCDay();
        bar.letter.textContent = DAY_LETTERS[dayOfWeek] ?? "";
        bar.letter.classList.toggle("bars-letter-today", d.dayKey === todayKey);
      });
    },
  };
}

export function initHomeView(el: HomeViewElements, options: HomeViewOptions): HomeView {
  const ring = buildRing(el.ringContainerEl);
  const bars = buildBars(el.barsContainerEl);

  const streakIcon = document.createElementNS(SVG_NS, "svg");
  streakIcon.setAttribute("viewBox", "0 0 24 24");
  streakIcon.setAttribute("fill", "currentColor");
  const streakPath = document.createElementNS(SVG_NS, "path");
  streakPath.setAttribute(
    "d",
    "M12 2c1 3-3 4.5-3 8a3 3 0 0 0 6 0c1.5 1 2 2.8 2 4.2A5.2 5.2 0 0 1 6.8 14C6.8 8 12 6 12 2Z",
  );
  streakIcon.append(streakPath);
  const streakTextEl = document.createElement("span");
  el.streakEl.replaceChildren(streakIcon, streakTextEl);

  const waterEntry: WaterEntryHandle = mountWaterEntry(el.waterEntryContainerEl, options.bottleOz, (oz) =>
    options.onWaterLogged(oz, Date.now()),
  );
  let pauseReason: PauseReason | null = null;

  el.intervalSliderEl.addEventListener("change", () => {
    const minutes = Number(el.intervalSliderEl.value);
    el.intervalSliderValueEl.textContent = `${minutes} min`;
    options.onIntervalChanged(minutes);
  });
  el.intervalSliderEl.addEventListener("input", () => {
    // Live label while dragging, without restarting the countdown per pixel.
    el.intervalSliderValueEl.textContent = `${el.intervalSliderEl.value} min`;
  });

  el.startTimerBtn.addEventListener("click", () => options.onStartTimer(Number(el.intervalSliderEl.value)));
  el.pauseBtn.addEventListener("click", () => options.onPauseToggle());

  return {
    renderTimers(model: TimerRowModel, nowMs: number) {
      const { hero, secondary } = model;

      // "off" (hydration disabled) and "idle" (enabled, not yet armed) both
      // show a neutral clock placeholder rather than a countdown to nothing
      // — the hero shouldn't imply a timer is running until the user
      // explicitly starts one. Paused keeps the countdown on screen while
      // running (only the label changes) — blanking it reads as a hang.
      el.heroEl.classList.toggle("hero-off", hero.state === "off");
      if (hero.state === "off") {
        el.heroLabelEl.textContent = "Hydration off";
        el.heroCountdownEl.textContent = formatClockTime(nowMs);
      } else if (hero.state === "idle") {
        el.heroLabelEl.textContent = "Not started";
        el.heroCountdownEl.textContent = formatClockTime(nowMs);
      } else {
        el.heroLabelEl.textContent = hydrationHeroLabel(pauseReason);
        el.heroCountdownEl.textContent = formatCountdown(hero.remainingMs as number);
      }

      // Start/Reset reflects whether ANYTHING is armed, not just hydration —
      // otherwise switching hydration off would leave the button reading
      // "Start timer" forever while Pomodoro/eye break keep counting below.
      const anyArmed = hero.state === "running" || secondary.some((entry) => entry.running);
      // secondary is already filtered to enabled kinds, so "off" + no
      // secondary entries means literally nothing is enabled — a Start
      // button that provably can't do anything shouldn't invite a click.
      const anyEnabled = hero.state !== "off" || secondary.length > 0;
      el.startTimerBtn.textContent = anyArmed ? "Reset timer" : "Start timer";
      el.startTimerBtn.disabled = !anyEnabled;
      el.startTimerBtn.title = anyEnabled ? "" : "Enable a reminder in Settings first";
      // Nothing to pause/resume when nothing's armed — a fully interactive
      // Pause button sitting over an idle hero is dead weight.
      el.pauseBtn.hidden = !anyArmed;

      el.chipsEl.replaceChildren(
        ...secondary.map((entry) => {
          const chipEl = document.createElement("span");
          chipEl.className = entry.running ? "reminder-chip" : "reminder-chip reminder-chip-idle";
          chipEl.textContent = `${entry.label} ${formatCountdown(entry.displayMs)}`;
          return chipEl;
        }),
      );
    },

    renderWater(log: DailyLog, todayKey: string, goalOz: number) {
      const today = entryOn(log, todayKey);
      ring.setProgress(goalOz > 0 ? today.oz / goalOz : 0);
      ring.setLabel(`${today.oz} oz`, `of ${goalOz}`);

      bars.render(log, todayKey, goalOz);

      const streak = goalStreak(log, todayKey, goalOz);
      streakTextEl.textContent = `Streak ${streak} day${streak === 1 ? "" : "s"}`;

      const month = monthToDate(log, todayKey, goalOz);
      el.monthStatsEl.textContent =
        month.daysCounted === 0
          ? "This month · no water logged yet"
          : `This month · avg ${Math.round(month.avgOzPerDay)} oz/day · ${month.daysAtGoal} of ${month.daysCounted} at goal`;

      const year = yearToDate(log, todayKey, goalOz);
      el.yearStatsEl.textContent =
        year.daysCounted === 0
          ? "This year · no water logged yet"
          : `This year · avg ${Math.round(year.avgOzPerDay)} oz/day · ${year.daysAtGoal} of ${year.daysCounted} at goal`;
    },

    setBottleOz(oz: number) {
      waterEntry.setBottleOz(oz);
    },

    setIntervalMinutes(minutes: number) {
      el.intervalSliderEl.value = String(minutes);
      el.intervalSliderValueEl.textContent = `${minutes} min`;
    },

    getIntervalMinutes() {
      return Number(el.intervalSliderEl.value);
    },

    setPause(reason: PauseReason | null) {
      pauseReason = reason;
      const isPaused = reason !== null;
      el.pauseBtn.textContent = isPaused ? "Resume" : "Pause";
      el.pauseBtn.classList.toggle("pause-btn-active", isPaused);
      el.heroEl.classList.toggle("hero-paused", isPaused);
    },
  };
}
