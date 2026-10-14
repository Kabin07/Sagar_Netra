"""
SAGAR-NETRA private inference service.

Loads the trained YOLOv8n-seg checkpoint ONCE and serves instance segmentation
to the Node.js backend over a private HTTP interface. It is not meant to be
reachable by browsers: it binds to 127.0.0.1 by default and every inference
request must carry the shared secret in the X-Inference-Token header.

Endpoints
    GET  /health        model status, class list, configuration (no token needed;
                        exposes no image data)
    POST /v1/segment    body = raw image bytes (JPEG / PNG / WebP)
                        query: conf=<0.01..0.95>  imgsz=<160..1920, multiple of 32>

Output coordinate conventions (documented in README):
    bbox      [x1, y1, x2, y2] in ORIGINAL image pixels, top-left origin
    bbox_norm the same box divided by original width / height (0..1)
    mask      single-channel PNG (0 = background, 255 = object) at the
              ANALYSED resolution (image downscaled so the long side is at most
              SN_MAX_SIDE); its width/height are returned alongside it

Configuration (environment variables; all optional except the token):
    SN_INFERENCE_TOKEN   shared secret, must match the backend's INFERENCE_TOKEN
    SN_MODEL_PATH        default runs/sagarnetra_gpu_v2/weights/best.pt
    SN_INFERENCE_HOST    default 127.0.0.1
    SN_INFERENCE_PORT    default 8001
    SN_CONF              default confidence threshold, default 0.25
    SN_IMGSZ             default inference size; default = the checkpoint's training imgsz
    SN_DEVICE            "" (auto), "cpu", "0", ...
    SN_MAX_SIDE          downscale very large images before inference, default 1920
    SN_MAX_BYTES         request body limit, default 26214400 (25 MB)

Run:
    python inference/service.py
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CLASSES_FILE = Path(__file__).resolve().parent / "classes.json"
DEFAULT_MODEL = ROOT / "runs" / "sagarnetra_gpu_v2" / "weights" / "best.pt"


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader so the service can share inference/.env without
    adding python-dotenv as a dependency. Existing environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(__file__).resolve().parent / ".env")

TOKEN = os.environ.get("SN_INFERENCE_TOKEN", "")
MODEL_PATH = Path(os.environ.get("SN_MODEL_PATH") or DEFAULT_MODEL)
if not MODEL_PATH.is_absolute():
    MODEL_PATH = (ROOT / MODEL_PATH).resolve()
HOST = os.environ.get("SN_INFERENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SN_INFERENCE_PORT", "8001"))
DEFAULT_CONF = float(os.environ.get("SN_CONF", "0.25"))
ENV_IMGSZ = os.environ.get("SN_IMGSZ", "")
DEVICE = os.environ.get("SN_DEVICE", "")
MAX_SIDE = int(os.environ.get("SN_MAX_SIDE", "1920"))
MAX_BYTES = int(os.environ.get("SN_MAX_BYTES", str(25 * 1024 * 1024)))
MAX_PIXELS = 60_000_000  # refuse decompression bombs before decoding fully

EXPECTED_CLASSES: list[str] = json.loads(CLASSES_FILE.read_text(encoding="utf-8"))


class ModelState:
    def __init__(self) -> None:
        self.model = None
        self.error: str | None = None
        self.sha256: str | None = None
        self.imgsz: int | None = None
        self.names: list[str] = []
        self.loaded_at: float | None = None
        self.ultralytics_version: str | None = None
        self.lock = threading.Lock()  # one predict at a time; YOLO is not re-entrant

    def load(self) -> None:
        try:
            if not MODEL_PATH.exists():
                raise FileNotFoundError(f"model file not found: {MODEL_PATH}")
            import ultralytics
            from ultralytics import YOLO

            self.ultralytics_version = ultralytics.__version__
            h = hashlib.sha256()
            with open(MODEL_PATH, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            self.sha256 = h.hexdigest()

            model = YOLO(str(MODEL_PATH))
            if getattr(model, "task", None) != "segment":
                raise RuntimeError(f"expected a segmentation model, got task={model.task!r}")
            names = [model.names[i] for i in range(len(model.names))]
            if names != EXPECTED_CLASSES:
                raise RuntimeError(
                    "class mapping mismatch between checkpoint and inference/classes.json: "
                    f"model={names}"
                )
            train_imgsz = (getattr(model, "overrides", {}) or {}).get("imgsz") or 640
            self.imgsz = int(ENV_IMGSZ) if ENV_IMGSZ else int(train_imgsz)
            # warm-up so the first real request is not penalised by lazy init
            model.predict(np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8),
                          imgsz=self.imgsz, device=DEVICE or None, verbose=False)
            self.model, self.names = model, names
            self.loaded_at = time.time()
            self.error = None
        except Exception as exc:  # surfaced through /health and 503 responses
            self.model = None
            self.error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()


STATE = ModelState()


def _encode_png(mask: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    if not ok:
        raise RuntimeError("failed to encode mask PNG")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _encode_jpeg(img: np.ndarray, quality: int = 85) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("failed to encode annotated JPEG")
    return base64.b64encode(buf.tobytes()).decode("ascii")


class BadRequest(Exception):
    pass


def segment(raw: bytes, conf: float, imgsz: int) -> dict:
    arr = np.frombuffer(raw, dtype=np.uint8)
    # read the header first so huge images are rejected before a full decode
    header = cv2.imdecode(arr, cv2.IMREAD_REDUCED_GRAYSCALE_8)
    if header is None:
        raise BadRequest("could not decode image (corrupt or unsupported format)")
    if header.shape[0] * header.shape[1] * 64 > MAX_PIXELS:
        raise BadRequest("image dimensions too large")
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise BadRequest("could not decode image (corrupt or unsupported format)")
    orig_h, orig_w = bgr.shape[:2]
    if orig_h < 8 or orig_w < 8:
        raise BadRequest("image too small")

    scale = min(1.0, MAX_SIDE / max(orig_h, orig_w))
    work = bgr if scale >= 1.0 else cv2.resize(
        bgr, (round(orig_w * scale), round(orig_h * scale)), interpolation=cv2.INTER_AREA)
    work_h, work_w = work.shape[:2]

    with STATE.lock:
        t0 = time.perf_counter()
        res = STATE.model.predict(work, conf=conf, imgsz=imgsz, retina_masks=True,
                                  device=DEVICE or None, verbose=False)[0]
        elapsed = (time.perf_counter() - t0) * 1000

    detections = []
    n = 0 if res.boxes is None else len(res.boxes)
    masks = res.masks.data.cpu().numpy() if (n and res.masks is not None) else None
    frame_px = work_h * work_w
    for i in range(n):
        cls_idx = int(res.boxes.cls[i])
        x1, y1, x2, y2 = (float(v) for v in res.boxes.xyxy[i].tolist())
        # back to original-image pixel coordinates
        x1, y1, x2, y2 = (x1 / scale, y1 / scale, x2 / scale, y2 / scale) if scale < 1.0 else (x1, y1, x2, y2)
        x1, x2 = max(0.0, min(x1, orig_w)), max(0.0, min(x2, orig_w))
        y1, y2 = max(0.0, min(y1, orig_h)), max(0.0, min(y2, orig_h))
        det = {
            "class_index": cls_idx,
            "class_name": res.names[cls_idx],
            "confidence": round(float(res.boxes.conf[i]), 5),
            "bbox": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
            "bbox_norm": [round(x1 / orig_w, 6), round(y1 / orig_h, 6),
                          round(x2 / orig_w, 6), round(y2 / orig_h, 6)],
            "mask": None,
        }
        if masks is not None:
            m = masks[i]
            if m.shape != (work_h, work_w):
                m = cv2.resize(m, (work_w, work_h), interpolation=cv2.INTER_NEAREST)
            binary = (m > 0.5).astype(np.uint8) * 255
            area = int(np.count_nonzero(binary))
            det["mask"] = {
                "format": "png",
                "width": work_w,
                "height": work_h,
                "area_px": area,
                "area_frac": round(area / frame_px, 6) if frame_px else 0.0,
                "png_base64": _encode_png(binary),
            }
        detections.append(det)

    return {
        "image": {"width": orig_w, "height": orig_h,
                  "analysed_width": work_w, "analysed_height": work_h},
        "model": {"path": MODEL_PATH.name, "sha256": STATE.sha256, "imgsz": imgsz,
                  "conf": conf, "ultralytics": STATE.ultralytics_version},
        "inference_ms": round(elapsed, 1),
        "detections": detections,
        "annotated_jpeg_base64": _encode_jpeg(res.plot(line_width=2)),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "SagarNetraInference/1.0"

    def log_message(self, fmt, *args):  # quieter, single-line logs
        sys.stderr.write("[inference] %s %s\n" % (self.address_string(), fmt % args))

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._json(404, {"error": "not found"})
        ok = STATE.model is not None
        self._json(200 if ok else 503, {
            "status": "ok" if ok else "error",
            "error": STATE.error,
            "model_loaded": ok,
            "model_file": MODEL_PATH.name,
            "model_exists": MODEL_PATH.exists(),
            "model_sha256": STATE.sha256,
            "classes": STATE.names or EXPECTED_CLASSES,
            "num_classes": len(STATE.names or EXPECTED_CLASSES),
            "imgsz": STATE.imgsz,
            "default_conf": DEFAULT_CONF,
            "device": DEVICE or "auto",
            "ultralytics": STATE.ultralytics_version,
        })

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/v1/segment":
            return self._json(404, {"error": "not found"})
        supplied = self.headers.get("X-Inference-Token", "")
        if not TOKEN or not hmac.compare_digest(supplied.encode(), TOKEN.encode()):
            return self._json(401, {"error": "invalid inference token"})
        if STATE.model is None:
            return self._json(503, {"error": "model unavailable", "detail": STATE.error})

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._json(400, {"error": "invalid Content-Length"})
        if length <= 0:
            return self._json(400, {"error": "empty body"})
        if length > MAX_BYTES:
            return self._json(413, {"error": "image too large"})
        raw = self.rfile.read(length)

        q = parse_qs(url.query)
        try:
            conf = float(q.get("conf", [DEFAULT_CONF])[0])
            imgsz = int(q.get("imgsz", [STATE.imgsz])[0])
        except ValueError:
            return self._json(400, {"error": "conf/imgsz must be numeric"})
        if not (0.01 <= conf <= 0.95):
            return self._json(400, {"error": "conf must be between 0.01 and 0.95"})
        if not (160 <= imgsz <= 1920) or imgsz % 32:
            return self._json(400, {"error": "imgsz must be a multiple of 32 between 160 and 1920"})

        try:
            return self._json(200, segment(raw, conf, imgsz))
        except BadRequest as exc:
            return self._json(422, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            return self._json(500, {"error": "inference failed", "detail": type(exc).__name__})


def main() -> None:
    if not TOKEN or len(TOKEN) < 24:
        sys.exit("SN_INFERENCE_TOKEN must be set (24+ random characters) in the environment "
                 "or inference/.env — it must match INFERENCE_TOKEN in backend/.env")
    print(f"[inference] loading {MODEL_PATH} ...", flush=True)
    STATE.load()
    if STATE.model is None:
        print(f"[inference] MODEL NOT LOADED: {STATE.error}", flush=True)
    else:
        print(f"[inference] model ready: {len(STATE.names)} classes, imgsz={STATE.imgsz}, "
              f"sha256={STATE.sha256[:12]}", flush=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[inference] listening on http://{HOST}:{PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
