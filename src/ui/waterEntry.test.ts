// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountWaterEntry } from "./waterEntry";

function fixture(bottleOz = 24) {
  const container = document.createElement("div");
  const onLog = vi.fn();
  const handle = mountWaterEntry(container, bottleOz, onLog);
  const buttons = () => container.querySelectorAll<HTMLButtonElement>("button");
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  return { container, onLog, handle, buttons, input };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mountWaterEntry — quick-add composes, Add commits", () => {
  it("labels the quick buttons from the bottle size, half rounded", () => {
    const { buttons } = fixture(25);
    // [quick, half, add, remove] — quick and half are the first two.
    expect(buttons()[0]?.textContent).toBe("+25 oz");
    expect(buttons()[1]?.textContent).toBe("+13 oz"); // round(25/2) = 12.5 -> 13
  });

  it("clicking quick-add fills the field but does not log anything yet", () => {
    const { buttons, input, onLog } = fixture(24);
    buttons()[0]?.click();

    expect(input().value).toBe("24");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("stacks quick and half onto the same field rather than replacing it", () => {
    const { buttons, input } = fixture(24);
    buttons()[0]?.click(); // +24
    buttons()[1]?.click(); // +12
    expect(input().value).toBe("36");
  });

  it("Add commits the composed field and clears it", () => {
    const { buttons, input, onLog } = fixture(24);
    buttons()[0]?.click();
    const addBtn = Array.from(buttons()).find((b) => b.textContent === "Add")!;
    addBtn.click();

    expect(onLog).toHaveBeenCalledWith(24);
    expect(input().value).toBe("");
  });

  it("Enter in the custom field also commits it", () => {
    const { input, onLog } = fixture();
    input().value = "10";
    input().dispatchEvent(new Event("input"));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onLog).toHaveBeenCalledWith(10);
  });

  it("never logs a zero or empty amount", () => {
    const { buttons, onLog } = fixture();
    const addBtn = Array.from(buttons()).find((b) => b.textContent === "Add")!;
    addBtn.click(); // nothing typed
    expect(onLog).not.toHaveBeenCalled();
    expect(addBtn.disabled).toBe(true);
  });
});

describe("mountWaterEntry — setBottleOz", () => {
  it("relabels the quick buttons live, without touching an in-progress field value", () => {
    const { buttons, input, handle } = fixture(24);
    input().value = "5";
    input().dispatchEvent(new Event("input"));

    handle.setBottleOz(40);

    expect(buttons()[0]?.textContent).toBe("+40 oz");
    expect(input().value).toBe("5");
  });
});

describe("mountWaterEntry — reset", () => {
  it("clears the field and re-disables Add", () => {
    const { buttons, input, handle } = fixture();
    input().value = "8";
    input().dispatchEvent(new Event("input"));
    const addBtn = Array.from(buttons()).find((b) => b.textContent === "Add")!;
    expect(addBtn.disabled).toBe(false);

    handle.reset();

    expect(input().value).toBe("");
    expect(addBtn.disabled).toBe(true);
  });
});

describe("mountWaterEntry — setEnabled", () => {
  it("disables every control, including Add regardless of field contents", () => {
    const { buttons, input, handle } = fixture();
    input().value = "8";
    input().dispatchEvent(new Event("input"));

    handle.setEnabled(false);

    buttons().forEach((b) => expect(b.disabled).toBe(true));
    expect(input().disabled).toBe(true);
  });

  it("re-enabling restores Add's own enabled state from the field, not unconditionally", () => {
    const { buttons, input, handle } = fixture();
    handle.setEnabled(false);
    handle.setEnabled(true);

    const addBtn = Array.from(buttons()).find((b) => b.textContent === "Add")!;
    expect(addBtn.disabled).toBe(true); // field is still empty
    expect(input().disabled).toBe(false);

    input().value = "3";
    input().dispatchEvent(new Event("input"));
    expect(addBtn.disabled).toBe(false);
  });
});
