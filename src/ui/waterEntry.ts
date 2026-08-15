export interface WaterEntryHandle {
  setBottleOz(oz: number): void;
}

/**
 * Rebuilds a quick-add water widget into `container` — bottle-size button,
 * half-bottle button, and a custom-amount field. Mounted twice (home page,
 * hydration takeover) with independent `onLog` callbacks, so this is a
 * plain builder rather than a singleton component.
 */
export function mountWaterEntry(
  container: HTMLElement,
  initialBottleOz: number,
  onLog: (oz: number) => void,
): WaterEntryHandle {
  let bottleOz = initialBottleOz;

  const quickBtn = document.createElement("button");
  quickBtn.type = "button";
  quickBtn.className = "water-entry-btn water-entry-btn-primary";

  const halfBtn = document.createElement("button");
  halfBtn.type = "button";
  halfBtn.className = "water-entry-btn";

  const customInput = document.createElement("input");
  customInput.type = "number";
  customInput.min = "1";
  customInput.placeholder = "oz";
  customInput.className = "water-entry-custom-input";

  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "water-entry-btn";
  customBtn.textContent = "Add";

  const quickRow = document.createElement("div");
  quickRow.className = "row water-entry-row";
  quickRow.append(quickBtn, halfBtn);

  const customRow = document.createElement("div");
  customRow.className = "row water-entry-row";
  customRow.append(customInput, customBtn);

  container.replaceChildren(quickRow, customRow);

  function render() {
    quickBtn.textContent = `+${bottleOz} oz`;
    halfBtn.textContent = `+${Math.round(bottleOz / 2)} oz`;
  }
  render();

  function submitCustom() {
    const value = Number(customInput.value);
    if (value > 0) {
      onLog(value);
      customInput.value = "";
    }
  }

  quickBtn.addEventListener("click", () => onLog(bottleOz));
  halfBtn.addEventListener("click", () => onLog(Math.round(bottleOz / 2)));
  customBtn.addEventListener("click", submitCustom);
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitCustom();
  });

  return {
    setBottleOz(oz: number) {
      bottleOz = oz;
      render();
    },
  };
}
