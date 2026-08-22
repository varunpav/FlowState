// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { DailyLog } from "../core/waterLog";
import { initHistoryView, type HistoryViewElements } from "./historyView";

function fixture() {
  const el: HistoryViewElements = {
    heatmapEl: document.createElement("div"),
    yearLabelEl: document.createElement("span"),
    yearPrevBtn: document.createElement("button"),
    yearNextBtn: document.createElement("button"),
  };
  const view = initHistoryView(el);
  return { el, view };
}

describe("initHistoryView", () => {
  it("renders the current year by default, each week a column of exactly 7", () => {
    const { el, view } = fixture();
    view.render({}, "2026-01-15", 128);

    expect(el.yearLabelEl.textContent).toBe("2026");
    const weeks = el.heatmapEl.querySelectorAll(".heatmap-week");
    expect(weeks.length).toBeGreaterThan(0);
    weeks.forEach((week) => {
      expect(week.querySelectorAll(".heatmap-cell").length).toBe(7);
    });
  });

  it("disables Next at the current year and Prev at the lookback bound", () => {
    const { el, view } = fixture();
    view.render({}, "2026-01-15", 128);
    expect(el.yearNextBtn.disabled).toBe(true);
    expect(el.yearPrevBtn.disabled).toBe(false);

    for (let i = 0; i < 5; i++) el.yearPrevBtn.click();
    expect(el.yearLabelEl.textContent).toBe("2021");
    expect(el.yearPrevBtn.disabled).toBe(true);
    expect(el.yearNextBtn.disabled).toBe(false);

    el.yearPrevBtn.click(); // one step past the boundary must be a no-op
    expect(el.yearLabelEl.textContent).toBe("2021");
  });

  it("colors a day's cell by how close it got to the goal and labels it with the date and oz", () => {
    const { el, view } = fixture();
    const todayKey = "2026-01-15";
    const log: DailyLog = { [todayKey]: { oz: 128, count: 3 } };
    view.render(log, todayKey, 128);

    const todayCell = Array.from(el.heatmapEl.querySelectorAll(".heatmap-cell")).find(
      (cell) => cell.getAttribute("title") === "Today · 128 oz",
    );
    expect(todayCell?.className).toContain("heatmap-cell-4");
  });

  it("leaves days after today blank rather than showing them as tracked-but-empty", () => {
    const { el, view } = fixture();
    view.render({}, "2026-06-15", 128);

    const futureDayCell = Array.from(el.heatmapEl.querySelectorAll(".heatmap-cell")).find(
      (cell) => cell.getAttribute("title") === "Sat Jun 16 · 0 oz",
    );
    expect(futureDayCell).toBeUndefined();
  });

  it("labels the column that actually contains the 1st of the month, not the next one", () => {
    const { el, view } = fixture();
    // A full elapsed year, so every month's "1st" cell is populated rather than blank-future.
    view.render({}, "2026-12-31", 128);

    const weeks = Array.from(el.heatmapEl.querySelectorAll(".heatmap-week"));
    const labels = Array.from(el.heatmapEl.querySelectorAll(".heatmap-month-label"));
    const augFirstWeekIndex = weeks.findIndex((week) =>
      Array.from(week.querySelectorAll(".heatmap-cell")).some((cell) => /Aug 1 ·/.test(cell.getAttribute("title") ?? "")),
    );
    expect(augFirstWeekIndex).toBeGreaterThanOrEqual(0);
    expect(labels[augFirstWeekIndex]?.textContent).toBe("Aug");
  });

  it("renders one month-label slot per week column, so the two rows stay in step", () => {
    const { el, view } = fixture();
    view.render({}, "2026-12-31", 128);

    const weeks = el.heatmapEl.querySelectorAll(".heatmap-week");
    const labels = el.heatmapEl.querySelectorAll(".heatmap-month-label");
    expect(labels.length).toBe(weeks.length);
  });

  it("re-renders cleanly on a second call rather than stacking markup", () => {
    const { el, view } = fixture();
    view.render({}, "2026-01-15", 128);
    view.render({}, "2026-01-16", 128);
    expect(el.heatmapEl.children.length).toBe(1);
  });
});
