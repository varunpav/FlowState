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
"""

import base64
import json
import os
import sys
import time

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
PROTOTXT_PATH = os.path.join(MODEL_DIR, "MobileNetSSD_deploy.prototxt")
CAFFEMODEL_PATH = os.path.join(MODEL_DIR, "MobileNetSSD_deploy.caffemodel")

# MobileNet-SSD's standard PASCAL VOC label order — index into this list with
# the class id the model outputs. "bottle" is class 5; that's the only class
# this feature cares about (VOC has no separate "cup" class).
VOC_CLASSES = [
    "background", "aeroplane", "bicycle", "bird", "boat", "bottle", "bus",
    "car", "cat", "chair", "cow", "diningtable", "dog", "horse", "motorbike",
    "person", "pottedplant", "sheep", "sofa", "train", "tvmonitor",
]
BOTTLE_CLASS_ID = VOC_CLASSES.index("bottle")
# Lower than the textbook 0.5 — a bottle tilted back to drink looks quite
# different from the mostly-upright bottles MobileNet-SSD/VOC was trained
# on, and its confidence dips accordingly. Still well above the noise floor
# for a bottle-sized object at typical webcam distance.
DETECTION_CONFIDENCE_THRESHOLD = 0.35

FRAME_WIDTH = 320
FRAME_HEIGHT = 240
# MobileNet-SSD's own input_shape (see MobileNetSSD_deploy.prototxt) is a
# fixed 300x300, independent of the capture/display resolution above —
# feeding it a 320x240 blob would silently distort the aspect ratio the
# network was trained on and degrade detection quality.
DNN_INPUT_SIZE = 300
TARGET_FPS = 10
JPEG_QUALITY = 60
HOLD_FRAMES = 12  # ~1.2s at TARGET_FPS — a bottle merely passing through frame doesn't count
# A single missed frame (tilting the bottle back to drink changes its
# detected shape and can drop it for a frame or two) must not erase all
# progress — decay is a few frames' worth per miss rather than a hard reset,
# so brief gaps survive but sustained absence still resets in well under a
# second.
HOLD_DECAY_PER_MISS = 3


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def is_drinking(face_box, object_box) -> bool:
    """
    True when the object's center sits inside the face box extended downward
    by 1.5x its own height — i.e. held at or just below the mouth. Deliberately
    one geometric rule rather than a pile of heuristics, so it's explainable
    and tunable by a single constant. Boxes are (x, y, w, h) in the same pixel
    space; either box may come from a different detector, so this only
    assumes "top-left + size", nothing about aspect ratio or scale.
    """
    fx, fy, fw, fh = face_box
    ox, oy, ow, oh = object_box
    obj_center_x = ox + ow / 2
    obj_center_y = oy + oh / 2
    extended_bottom = fy + fh * 2.5  # face box's own height (fh), plus 1.5x more below it
    return (fx <= obj_center_x <= fx + fw) and (fy <= obj_center_y <= extended_bottom)


def _import_cv2():
    import cv2  # noqa: F401 — imported for its side effect (raises if missing) and returned
    return cv2


def run_selftest() -> None:
    result = {"type": "selftest", "opencv": False, "model": False, "camera": False, "message": ""}

    try:
        cv2 = _import_cv2()
        result["opencv"] = True
    except ImportError as err:
        result["message"] = f"opencv-python is not installed ({err}). See cv/README.md."
        emit(result)
        return

    result["model"] = os.path.isfile(PROTOTXT_PATH) and os.path.isfile(CAFFEMODEL_PATH)
    if not result["model"]:
        result["message"] = "MobileNet-SSD model files are missing from cv/models/. See cv/README.md."
        emit(result)
        return

    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    try:
        result["camera"] = cap.isOpened()
        if not result["camera"]:
            result["message"] = "No camera could be opened (index 0)."
    finally:
        cap.release()

    if result["opencv"] and result["model"] and result["camera"]:
        result["message"] = "Ready."
    emit(result)


def run_live() -> None:
    try:
        cv2 = _import_cv2()
    except ImportError as err:
        emit({"type": "error", "code": "no_opencv", "message": f"opencv-python is not installed ({err})."})
        return

    if not (os.path.isfile(PROTOTXT_PATH) and os.path.isfile(CAFFEMODEL_PATH)):
        emit({"type": "error", "code": "no_model", "message": "MobileNet-SSD model files are missing from cv/models/."})
        return

    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    net = cv2.dnn.readNetFromCaffe(PROTOTXT_PATH, CAFFEMODEL_PATH)

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

            blob = cv2.dnn.blobFromImage(frame, 0.007843, (DNN_INPUT_SIZE, DNN_INPUT_SIZE), 127.5)
            net.setInput(blob)
            detections = net.forward()  # shape [1, 1, N, 7]: [_, _, _, class_id, confidence, x1, y1, x2, y2] (x/y normalized 0-1)

            bottle_box = None
            bottle_confidence = 0.0
            for i in range(detections.shape[2]):
                confidence = float(detections[0, 0, i, 2])
                class_id = int(detections[0, 0, i, 1])
                if class_id != BOTTLE_CLASS_ID or confidence < DETECTION_CONFIDENCE_THRESHOLD:
                    continue
                x1 = detections[0, 0, i, 3] * FRAME_WIDTH
                y1 = detections[0, 0, i, 4] * FRAME_HEIGHT
                x2 = detections[0, 0, i, 5] * FRAME_WIDTH
                y2 = detections[0, 0, i, 6] * FRAME_HEIGHT
                if confidence > bottle_confidence:
                    bottle_confidence = confidence
                    bottle_box = (x1, y1, x2 - x1, y2 - y1)

            face_box = tuple(faces[0]) if len(faces) > 0 else None

            drinking_this_frame = face_box is not None and bottle_box is not None and is_drinking(face_box, bottle_box)
            if drinking_this_frame:
                consecutive_hold_frames = min(HOLD_FRAMES, consecutive_hold_frames + 1)
            else:
                consecutive_hold_frames = max(0, consecutive_hold_frames - HOLD_DECAY_PER_MISS)

            # Draw AFTER the geometry check so the boxes on screen exactly
            # match what was evaluated, not a stale previous frame's boxes.
            if face_box is not None:
                fx, fy, fw, fh = (int(v) for v in face_box)
                cv2.rectangle(frame, (fx, fy), (fx + fw, fy + fh), (255, 200, 0), 2)
            if bottle_box is not None:
                bx, by, bw, bh = (int(v) for v in bottle_box)
                color = (0, 200, 0) if drinking_this_frame else (0, 165, 255)
                cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), color, 2)

            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                emit({"type": "frame", "jpeg": base64.b64encode(buf).decode("ascii")})

            if consecutive_hold_frames >= HOLD_FRAMES:
                emit({"type": "verified", "confidence": round(bottle_confidence, 2)})
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
