/**
 * Pure policy for the hydration takeover's camera-verification gate — no
 * DOM, no camera, no IPC, so it's unit-testable on its own. `ui/takeover.ts`
 * owns the actual state transitions (spawning the process, reacting to
 * cv-ready/cv-frame/cv-verified/cv-error events, the starting-camera
 * timeout); this module only answers two questions given whatever status
 * that transition logic landed on.
 */
export type CvStatus = "off" | "starting" | "watching" | "verified" | "failed";

/**
 * `failed` unlocks water entry just like `verified` does — a broken camera
 * must never trap the user out of logging a drink they actually took. See
 * the CV feature's plan §Context: "being unable to record a drink because a
 * webcam failed is worse than the feature is good."
 */
export function waterEntryUnlocked(status: CvStatus): boolean {
  return status === "off" || status === "verified" || status === "failed";
}

export function cvPrompt(status: CvStatus): string {
  switch (status) {
    case "off":
      return "";
    case "starting":
      return "Starting camera…";
    case "watching":
      return "Take a sip — watching…";
    case "verified":
      return "Verified ✓";
    case "failed":
      return "Camera unavailable — log manually";
  }
}
