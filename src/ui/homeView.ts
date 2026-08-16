import type { ReminderKind } from "../core/reminders";
import { REMINDER_LABELS } from "../core/reminders";
import { formatClockTime, formatCountdown } from "../core/format";
import { entryOn, goalStreak, lastNDays, monthToDate, yearToDate, type DailyLog } from "../core/waterLog";
import { mountWaterEntry, type WaterEntryHandle } from "./waterEntry";

const RING_RADIUS = 54;
const RING_STROKE = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

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
  testAlertBtn: HTMLButtonElement;
  testNotificationBtn: HTMLButtonElement;
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
  onTestAlert: () => void;
  onTestNotification: () => void;
}

/** One row entry for a non-hydration timer shown under the hero. */
export interface TimerRowEntry {
  kind: ReminderKind;
  remainingMs: number | null;
}

export interface HomeView {
  /**
   * Hero is always Hydration; `secondary` is pre-filtered to enabled kinds,
   * in fixed order. `nowMs` renders the idle-hero placeholder clock — it's
   * ignored once hydration is armed.
   */
  renderTimers(hydrationMs: number | null, secondary: TimerRowEntry[], nowMs: number): void;
  renderWater(log: DailyLog, todayKey: string, goalOz: number): void;
  setBottleOz(oz: number): void;
  setIntervalMinutes(minutes: number): void;
  /** What the slider currently reads, in minutes — lets callers avoid clobbering an in-progress edit. */
  getIntervalMinutes(): number;
  setPaused(paused: boolean): void;
}

function buildRing(container: HTMLElement): { setProgress(fraction: number): void; setLabel(text: string): void } {
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

  container.replaceChildren(svg, label);

  return {
    setProgress(fraction: number) {
      const clamped = Math.min(1, Math.max(0, fraction));
      progress.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - clamped)));
    },
    setLabel(text: string) {
      label.textContent = text;
    },
  };
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

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
  const waterEntry: WaterEntryHandle = mountWaterEntry(el.waterEntryContainerEl, options.bottleOz, (oz) =>
    options.onWaterLogged(oz, Date.now()),
  );
  let paused = false;

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
  el.testAlertBtn.addEventListener("click", () => options.onTestAlert());
  el.testNotificationBtn.addEventListener("click", () => options.onTestNotification());

  return {
    renderTimers(hydrationMs: number | null, secondary: TimerRowEntry[], nowMs: number) {
      // Unarmed: a neutral clock placeholder rather than a countdown to
      // nothing — the hero shouldn't imply a timer is running until the
      // user explicitly starts one. Paused keeps the countdown on screen
      // (only the label changes) — blanking it reads as a hang, not a pause.
      if (hydrationMs === null) {
        el.heroLabelEl.textContent = "Not started";
        el.heroCountdownEl.textContent = formatClockTime(nowMs);
      } else {
        el.heroLabelEl.textContent = paused ? "Paused" : REMINDER_LABELS.hydration;
        el.heroCountdownEl.textContent = formatCountdown(hydrationMs);
      }
      // hydrationMs !== null IS "armed" — the label can never disagree with
      // the actual timer state, unlike a separately-tracked boolean would.
      el.startTimerBtn.textContent = hydrationMs === null ? "Start timer" : "Reset timer";

      el.chipsEl.replaceChildren(
        ...secondary.map((entry) => {
          const chipEl = document.createElement("span");
          chipEl.className = "reminder-chip";
          chipEl.textContent = `${REMINDER_LABELS[entry.kind]} ${entry.remainingMs === null ? "—" : formatCountdown(entry.remainingMs)}`;
          return chipEl;
        }),
      );
    },

    renderWater(log: DailyLog, todayKey: string, goalOz: number) {
      const today = entryOn(log, todayKey);
      ring.setProgress(goalOz > 0 ? today.oz / goalOz : 0);
      ring.setLabel(`${today.oz}\n/${goalOz}`);

      bars.render(log, todayKey, goalOz);

      const streak = goalStreak(log, todayKey, goalOz);
      el.streakEl.textContent = `Streak ${streak} day${streak === 1 ? "" : "s"}`;

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

    setPaused(next: boolean) {
      paused = next;
      el.pauseBtn.textContent = next ? "Resume" : "Pause";
      el.pauseBtn.classList.toggle("pause-btn-active", next);
      el.heroEl.classList.toggle("hero-paused", next);
    },
  };
}
