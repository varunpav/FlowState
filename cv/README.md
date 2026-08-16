# CV drink verification

Optional, off by default. When enabled in Settings, the hydration takeover spawns this as a
child process to confirm a bottle is actually being raised to your face before letting you log
water — see the main [README](../README.md)'s feature description for the user-facing behavior.

## Setup

```bash
pip install -r cv/requirements.txt
```

**The version pin matters**: `opencv-python` 5.0 removed `cv2.dnn`'s Caffe importer entirely
(`readNetFromCaffe` no longer exists — even the generic `readNet` refuses Caffe files with
*"Caffe importer has been removed. Please use ONNX-converted models or use an older OpenCV
version."*). `detector.py` loads the vendored MobileNet-SSD via `readNetFromCaffe`, so this repo
targets the last 4.x line (`opencv-python<5`) until/unless the model is ported to ONNX.

The two MobileNet-SSD (PASCAL VOC) model files — `cv/models/MobileNetSSD_deploy.prototxt` and
`cv/models/MobileNetSSD_deploy.caffemodel` (~23MB) — are vendored directly in this repo, not
downloaded at setup time. `pip install` is the only step.

Verify everything's wired up correctly from Settings → **Check camera**, or directly:

```bash
python cv/detector.py --selftest
```

This reports exactly which of opencv / the model files / the camera itself is missing — the same
diagnostic the in-app button runs.

## How it works

`detector.py` has no persistent stdin protocol — the process being spawned at all *is* "start",
and being killed *is* "stop" (see the module docstring for why: a fullscreen takeover is
time-sensitive, and a graceful shutdown handshake could still be in flight when the user just
wants out). It streams NDJSON on stdout: a `ready` line, then a `frame` (base64 JPEG, ~10fps,
320×240) per iteration, until either a bottle is held at face height for about 1.2 seconds
(`verified`) or the process is killed by `src-tauri/src/cv.rs`.

Detection is two independent OpenCV pieces per frame:

- **Face** — Haar cascade (`haarcascade_frontalface_default.xml`), which ships inside
  `opencv-python` itself — no separate download.
- **Bottle** — MobileNet-SSD via `cv2.dnn`, trained on PASCAL VOC. VOC has a `bottle` class but
  no `cup` class, which is why this only ever looks for a bottle.

`is_drinking(face_box, object_box)` — the one pure, camera-free function — decides whether the
bottle's center falls inside the face box extended downward by 1.5× its height (roughly: held at
or just below the mouth). `cv/test_detector.py` covers its geometry directly.

## Privacy

Frames exist only in memory for the lifetime of the process — nothing is ever written to disk,
and no frame or detection result is persisted anywhere, including in `settings.json`. The camera
is only ever opened while a hydration takeover is on screen; there is no background capture.

## Tests

```bash
python -m unittest discover cv
```

No pytest dependency — everything here runs on the stdlib `unittest` runner.
