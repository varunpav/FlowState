export interface WaterEntryHandle {
  setBottleOz(oz: number): void;
  /** Empties the composed field — called each time the hydration takeover reopens. */
  reset(): void;
}

/**
 * Rebuilds a quick-add water widget into `container` — bottle-size and
 * half-bottle buttons *compose* an amount into the field (so clicking +24
 * twice reads 48), and Add is the only thing that commits it to the daily
 * total. Mounted twice (home page, hydration takeover) with independent
 * `onLog` callbacks, so this is a plain builder rather than a singleton
 * component.
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
  customInput.placeholder = "Custom (oz)";
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

  function currentValue(): number {
    const value = Number(customInput.value);
    return Number.isFinite(value) ? value : 0;
  }

  function syncAddDisabled() {
    customBtn.disabled = currentValue() <= 0;
  }

  function addToField(amount: number) {
    customInput.value = String(currentValue() + amount);
    syncAddDisabled();
  }

  function submitCustom() {
    const value = currentValue();
    if (value > 0) {
      onLog(value);
      customInput.value = "";
      syncAddDisabled();
    }
  }

  quickBtn.addEventListener("click", () => addToField(bottleOz));
  halfBtn.addEventListener("click", () => addToField(Math.round(bottleOz / 2)));
  customBtn.addEventListener("click", submitCustom);
  customInput.addEventListener("input", syncAddDisabled);
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitCustom();
  });

  syncAddDisabled();

  return {
    setBottleOz(oz: number) {
      bottleOz = oz;
      render();
    },
    reset() {
      customInput.value = "";
      syncAddDisabled();
    },
  };
}
