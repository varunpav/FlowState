import { relativeDayLabel } from "../core/format";
import { calendarYearHeatmap, HEATMAP_YEAR_LOOKBACK, type DailyLog, type HeatmapCell } from "../core/waterLog";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface HistoryViewElements {
  heatmapEl: HTMLElement;
  yearLabelEl: HTMLElement;
  yearPrevBtn: HTMLButtonElement;
  yearNextBtn: HTMLButtonElement;
}

export interface HistoryView {
  /** Repopulate from current data — call when the History tab becomes active. Resets the year picker back to the current year. */
  render(log: DailyLog, todayKey: string, goalOz: number): void;
}

function isCell(value: HeatmapCell | null): value is HeatmapCell {
  return value !== null;
}

/** GitHub/LeetCode-style calendar-year contribution grid for the water log, with its own year stepper — mirrors the Settings water-day stepper's bounded, not-data-derived approach. */
export function initHistoryView(el: HistoryViewElements): HistoryView {
  let log: DailyLog = {};
  let todayKey = "";
  let goalOz = 0;
  let selectedYear = 0;

  function currentYear(): number {
    return Number(todayKey.slice(0, 4));
  }

  function drawGrid() {
    const weeks = calendarYearHeatmap(log, selectedYear, todayKey, goalOz);

    const monthRow = document.createElement("div");
    monthRow.className = "heatmap-months";
    for (const week of weeks) {
      const label = document.createElement("span");
      label.className = "heatmap-month-label";
      // Label the column that actually CONTAINS the 1st of a month, not the
      // next column whose first (Sunday) cell happens to be in that month —
      // a month starting mid-week otherwise gets its label shifted one
      // column right of where its boxes actually start.
      const monthStartCell = week.find((cell) => isCell(cell) && cell.dayKey.endsWith("-01"));
      if (monthStartCell) {
        const month = monthStartCell.dayKey.slice(5, 7);
        label.textContent = MONTH_LABELS[Number(month) - 1] ?? "";
      }
      monthRow.append(label);
    }

    const grid = document.createElement("div");
    grid.className = "heatmap-grid";
    for (const week of weeks) {
      const col = document.createElement("div");
      col.className = "heatmap-week";
      for (const cell of week) {
        const box = document.createElement("div");
        if (cell) {
          box.className = cell.level > 0 ? `heatmap-cell heatmap-cell-${cell.level}` : "heatmap-cell";
          box.title = `${relativeDayLabel(cell.dayKey, todayKey)} · ${cell.oz} oz`;
        } else {
          box.className = "heatmap-cell heatmap-cell-empty";
        }
        col.append(box);
      }
      grid.append(col);
    }

    const inner = document.createElement("div");
    inner.className = "heatmap-inner";
    inner.append(monthRow, grid);

    el.heatmapEl.replaceChildren(inner);
  }

  function syncYearStepper() {
    el.yearLabelEl.textContent = String(selectedYear);
    el.yearNextBtn.disabled = selectedYear >= currentYear();
    el.yearPrevBtn.disabled = selectedYear <= currentYear() - HEATMAP_YEAR_LOOKBACK;
  }

  el.yearPrevBtn.addEventListener("click", () => {
    if (selectedYear <= currentYear() - HEATMAP_YEAR_LOOKBACK) return;
    selectedYear -= 1;
    syncYearStepper();
    drawGrid();
  });

  el.yearNextBtn.addEventListener("click", () => {
    if (selectedYear >= currentYear()) return;
    selectedYear += 1;
    syncYearStepper();
    drawGrid();
  });

  return {
    render(nextLog, nextTodayKey, nextGoalOz) {
      log = nextLog;
      todayKey = nextTodayKey;
      goalOz = nextGoalOz;
      selectedYear = currentYear();
      syncYearStepper();
      drawGrid();
    },
  };
}
