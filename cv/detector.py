#!/usr/bin/env python3
"""
CV drink-verification detector, spawned as a child process by src-tauri/src/cv.rs.

Protocol: NDJSON on stdout, flushed after every line (the Rust side reads it
line-by-line and blocks otherwise). There is no stdin protocol — spawning the
process IS "start", and Rust killing it IS "stop". That asymmetry is
deliberate: a takeover is fullscreen and time-sensitive, so the lifecycle
should never depend on a graceful stdin round-trip landing in time.

Two modes, chosen by argv:

    python detector.py             # live detection loop (default)
    python detector.py --selftest  # one-shot capability check, then exit

Live mode emits, in order:
    {"type": "ready"}
    {"type": "frame", "jpeg": "<base64 jpeg>"}         ~10fps until verified or killed
    {"type": "verified", "confidence": 0.87}           emitted once, then the process exits
    {"type": "error", "code": "...", "message": "..."} fatal — process exits after this

Selftest mode emits exactly one line then exits:
    {"type": "selftest", "opencv": bool, "model": bool, "camera": bool, "message": "..."}

Nothing here ever writes a frame to disk — see cv/README.md's privacy note.

Detection: no external model file. Earlier versions used a vendored
MobileNet-SSD (Caffe) object detector to specifically classify "bottle" —
opencv-python 5.0 also removed the Caffe importer entirely, and carrying a
23MB weights file in this repo just to classify one class was more than the
feature needed. This version uses `cv2.createBackgroundSubtractorMOG2`,
built into the base `opencv-python` package (the `video` module, not
`opencv-contrib-python`) — no download, no vendored file, works on any
opencv-python version. See `object_present_in_zone`'s docstring for what
that trades away.
"""

import base64
import json
import os
import sys
import time

FRAME_WIDTH = 320
FRAME_HEIGHT = 240
TARGET_FPS = 10
JPEG_QUALITY = 60
HOLD_FRAMES = 12  # ~1.2s at TARGET_FPS — a bottle merely passing through frame doesn't count
# A single missed frame (tilting the bottle back to drink changes its
# detected shape and can drop it for a frame or two) must not erase all
# progress — decay is a few frames' worth per miss rather than a hard reset,
# so brief gaps survive but sustained absence still resets in well under a
# second.
HOLD_DECAY_PER_MISS = 3

# How far below the detected face to treat as "the mouth zone" — the region
# from the top of the face down to this many multiples of the face's own
# height. 2.5x means: the face's own height, plus 1.5x more below it.
MOUTH_ZONE_EXTEND_FACTOR = 2.5
# Fraction of the mouth zone that must register as foreground (different
# from the learned background) to count as "something is there."
FOREGROUND_MIN_FRACTION = 0.06
# MOG2's own adaptation window, in frames — how much history it blends into
# the background model. Kept short relative to the default (500) since a
# takeover's camera pane only exists for a matter of seconds; a slower-
# adapting model would still be mid-warm-up by the time the user drinks.
BACKGROUND_HISTORY_FRAMES = 120


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def mouth_zone_box(face_box):
    """
    Pure geometry, no camera/cv2 needed: the region below a detected face,
    extended downward by MOUTH_ZONE_EXTEND_FACTOR times the face's own
    height. Boxes are (x, y, w, h) in the same pixel space as the face box.
    """
    fx, fy, fw, fh = face_box
    return (fx, fy, fw, int(fh * MOUTH_ZONE_EXTEND_FACTOR))


def object_present_in_zone(changed_pixel_count: int, zone_area: int, min_fraction: float = FOREGROUND_MIN_FRACTION) -> bool:
    """
    True when at least `min_fraction` of the zone's pixels are foreground
    (different from the learned background) — i.e. something new is
    occupying that region, whether it's moving or just being held there.
    Takes plain counts rather than a numpy mask so this stays testable
    without numpy or opencv installed (see test_detector.py).

    This verifies "an object is present at the mouth," not specifically "a
    bottle" — a hand, a cup, or anything else raised into the zone counts
    too. That's a deliberate simplicity tradeoff (no model file, no
    download, works on any opencv-python version) traded against the
    specificity a trained object classifier would have had.
    """
    if zone_area <= 0:
        return False
    return (changed_pixel_count / zone_area) >= min_fraction


def _import_cv2():
    import cv2  # noqa: F401 — imported for its side effect (raises if missing) and returned
    return cv2


def run_selftest() -> None:
    result = {"type": "selftest", "opencv": False, "model": True, "camera": False, "message": ""}

    try:
        cv2 = _import_cv2()
        result["opencv"] = True
    except ImportError as err:
        result["message"] = f"opencv-python is not installed ({err}). See cv/README.md."
        emit(result)
        return

    # No external model file to check for — detection is background
    # subtraction, built into opencv-python itself. `model` stays in the
    # payload for wire-shape stability with src-tauri/src/cv.rs and
    # settingsPanel.ts, always true.

    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    try:
        result["camera"] = cap.isOpened()
        if not result["camera"]:
            result["message"] = "No camera could be opened (index 0)."
    finally:
        cap.release()

    if result["opencv"] and result["camera"]:
        result["message"] = "Ready."
    emit(result)


def run_live() -> None:
    try:
        cv2 = _import_cv2()
    except ImportError as err:
        emit({"type": "error", "code": "no_opencv", "message": f"opencv-python is not installed ({err})."})
        return

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    bg_subtractor = cv2.createBackgroundSubtractorMOG2(
        history=BACKGROUND_HISTORY_FRAMES, varThreshold=40, detectShadows=False
    )

    # CAP_DSHOW, not the MSMF default: MSMF has a multi-second init stall on
    # Windows that would make the fullscreen takeover look frozen/broken.
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    try:
        if not cap.isOpened():
            emit({"type": "error", "code": "no_camera", "message": "No camera could be opened (index 0)."})
            return

        emit({"type": "ready"})

        consecutive_hold_frames = 0
        frame_interval_s = 1.0 / TARGET_FPS

        while True:
            frame_start = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                emit({"type": "error", "code": "camera_read_failed", "message": "Camera stopped returning frames."})
                return

            frame = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT))
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
            face_box = tuple(int(v) for v in faces[0]) if len(faces) > 0 else None

            # Always feed the subtractor every frame, even when there's no
            # face — otherwise the background model doesn't adapt while
            # nobody's in frame, which is exactly the pre-warm window.
            fg_mask = bg_subtractor.apply(frame)

            object_box = None
            drinking_this_frame = False
            if face_box is not None:
                zx, zy, zw, zh = mouth_zone_box(face_box)
                zx0, zy0 = max(0, zx), max(0, zy)
                zx1, zy1 = min(FRAME_WIDTH, zx + zw), min(FRAME_HEIGHT, zy + zh)
                zone_mask = fg_mask[zy0:zy1, zx0:zx1]
                zone_area = zone_mask.size
                changed = int(cv2.countNonZero(zone_mask)) if zone_area > 0 else 0
                drinking_this_frame = object_present_in_zone(changed, zone_area)

                if drinking_this_frame:
                    # Bounding box for the on-screen box, purely visual —
                    # the largest foreground contour within the zone.
                    contours, _ = cv2.findContours(zone_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if contours:
                        bx, by, bw, bh = cv2.boundingRect(max(contours, key=cv2.contourArea))
                        object_box = (zx0 + bx, zy0 + by, bw, bh)

            if drinking_this_frame:
                consecutive_hold_frames = min(HOLD_FRAMES, consecutive_hold_frames + 1)
            else:
                consecutive_hold_frames = max(0, consecutive_hold_frames - HOLD_DECAY_PER_MISS)

            # Draw AFTER the detection so the boxes on screen exactly match
            # what was evaluated, not a stale previous frame's boxes.
            if face_box is not None:
                fx, fy, fw, fh = face_box
                cv2.rectangle(frame, (fx, fy), (fx + fw, fy + fh), (255, 200, 0), 2)
            if object_box is not None:
                bx, by, bw, bh = object_box
                color = (0, 200, 0) if drinking_this_frame else (0, 165, 255)
                cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), color, 2)

            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                emit({"type": "frame", "jpeg": base64.b64encode(buf).decode("ascii")})

            if consecutive_hold_frames >= HOLD_FRAMES:
                emit({"type": "verified", "confidence": round(consecutive_hold_frames / HOLD_FRAMES, 2)})
                return

            # No self-imposed timeout here — this loop runs until either
            # verification or the caller kills the process (cv.rs on
            # takeover close, or cv.ts's own ~8s starting-camera timeout on
            # the frontend). Enforcing a timeout on both ends would just
            # race two different failure paths against each other.
            elapsed = time.monotonic() - frame_start
            time.sleep(max(0.0, frame_interval_s - elapsed))
    finally:
        cap.release()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        run_selftest()
    else:
        run_live()
