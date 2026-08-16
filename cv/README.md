# CV drink verification

Optional, off by default. When enabled in Settings, the hydration takeover spawns this as a
child process to confirm something was actually raised to your face before letting you log
water — see the main [README](../README.md)'s feature description for the user-facing behavior.

## Setup

```bash
pip install -r cv/requirements.txt
```

That's the only step — no model file to download or vendor. Verify everything's wired up
correctly from Settings → **Check camera**, or directly:

```bash
python cv/detector.py --selftest
```

This reports exactly which of opencv / the camera itself is missing — the same diagnostic the
in-app button runs.

## How it works

`detector.py` has no persistent stdin protocol — the process being spawned at all *is* "start",
and being killed *is* "stop" (see the module docstring for why: a fullscreen takeover is
time-sensitive, and a graceful shutdown handshake could still be in flight when the user just
wants out). It streams NDJSON on stdout: a `ready` line, then a `frame` (base64 JPEG, ~10fps,
320×240) per iteration, until either something is held at face height for about 1.2 seconds
(`verified`) or the process is killed by `src-tauri/src/cv.rs`.

Detection is two independent OpenCV pieces per frame, **neither needing an external model file**:

- **Face** — Haar cascade (`haarcascade_frontalface_default.xml`), which ships inside
  `opencv-python` itself.
- **"Something's there"** — `cv2.createBackgroundSubtractorMOG2`, also built into base
  `opencv-python` (the `video` module, not `opencv-contrib-python`). It learns what the scene
  looks like with nothing going on, then flags pixels that don't match that learned background —
  which includes a bottle/cup/hand held steady, not just something moving. `mouth_zone_box`
  defines the region below the detected face this is evaluated in; `object_present_in_zone`
  decides whether enough of that zone changed to count. Both are pure functions —
  `cv/test_detector.py` covers them without a camera or opencv installed.

**Tradeoff, worth knowing**: this verifies "something new is at your mouth," not specifically "a
bottle." A hand, a cup, or anything else held there for ~1.2s counts too. That's the deliberate
trade for needing no model file and working on any opencv-python version — an earlier version of
this feature used a vendored MobileNet-SSD object detector that actually classified "bottle"
specifically, at the cost of a 23MB file in the repo and a version-pinned opencv-python (5.0
removed the Caffe importer entirely). If that specificity matters more than the simplicity, that
tradeoff can be revisited.

## Privacy

Frames exist only in memory for the lifetime of the process — nothing is ever written to disk,
and no frame or detection result is persisted anywhere, including in `settings.json`. The camera
is only ever opened while a hydration takeover is on screen; there is no background capture.

## Tests

```bash
python -m unittest discover cv
```

No pytest dependency — everything here runs on the stdlib `unittest` runner.
