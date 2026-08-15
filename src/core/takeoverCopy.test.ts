import { describe, expect, it } from "vitest";
import { pomodoroCopy, takeoverCopyFor } from "./takeoverCopy";

describe("takeoverCopyFor", () => {
  it("returns distinct copy for each static kind", () => {
    const hydration = takeoverCopyFor("hydration");
    const eyeBreak = takeoverCopyFor("eyeBreak");
    const standUp = takeoverCopyFor("standUp");
    expect(hydration.confirmLabel).toBe("I drank water");
    expect(eyeBreak.title).toMatch(/look/i);
    expect(standUp.title).toMatch(/stand/i);
    expect(new Set([hydration.title, eyeBreak.title, standUp.title]).size).toBe(3);
  });

  it("defaults pomodoro copy to a focus-just-ended framing when no phase is given", () => {
    expect(takeoverCopyFor("pomodoro")).toEqual(pomodoroCopy("focus"));
  });
});

describe("pomodoroCopy", () => {
  it("prompts to start the break when focus just ended", () => {
    const copy = pomodoroCopy("focus");
    expect(copy.confirmLabel).toBe("Start break");
  });

  it("prompts to return to focus when the break just ended", () => {
    const copy = pomodoroCopy("break");
    expect(copy.confirmLabel).toBe("Back to focus");
  });
});
