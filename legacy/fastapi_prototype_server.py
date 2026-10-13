"""
SAGAR-NETRA backend.

Runs the full three-layer pipeline on an uploaded image and serves both frontends.

  Layer 1  OpenCV      gray-world white balance + CLAHE
  Layer 2  YOLOv8n-seg instance segmentation (demo_model/best.pt)
  Layer 3  GIS         severity scoring from mask area, geotagging

Run:
    .venv\\Scripts\\python.exe backend\\server.py
Then:
    http://localhost:8000/citizen/     citizen PWA
    http://localhost:8000/authority/   operations console
    http://localhost:8000/docs         OpenAPI docs
"""
import base64
import io
import json
import time
import uuid
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS = ROOT / "demo_model" / "best.pt"
STORE = ROOT / "backend" / "reports.json"
FRONTEND = ROOT / "frontend"

# Classes that represent debris (vs. fauna/flora/ROV) — only these raise a report.
DEBRIS_PREFIX = "trash_"
# Severity bands keyed by class, then refined by mask area.
HIGH_CLASSES = {"trash_net", "trash_wreckage", "trash_tarp"}
LOW_CLASSES = {"trash_bottle", "trash_cup", "trash_can", "trash_snack_wrapper"}

app = FastAPI(title="SAGAR-NETRA API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # prototype only — restrict before deployment
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None


def model():
    """Lazy-load YOLO so the server starts instantly and warms on first use."""
    global _model
    if _model is None:
        if not WEIGHTS.exists():
            raise HTTPException(503, f"weights not found at {WEIGHTS} — train first")
        from ultralytics import YOLO
        _model = YOLO(str(WEIGHTS))
        # warm up: first CUDA call costs ~3 s, do it now not on the demo request
        _model.predict(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False)
    return _model


# ---------------------------------------------------------------- Layer 1
def restore(bgr: np.ndarray) -> np.ndarray:
    """Undo underwater colour cast and low contrast.

    Gray-world white balance neutralises the blue-green shift caused by water
    absorbing red light first; CLAHE restores local contrast lost to backscatter
    without globally amplifying noise.
    """
    img = bgr.astype(np.float32)
    means = img.reshape(-1, 3).mean(axis=0)
    gray = float(means.mean())
    for c in range(3):
        if means[c] > 1e-6:
            img[:, :, c] *= gray / means[c]
    img = np.clip(img, 0, 255).astype(np.uint8)

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


# ---------------------------------------------------------------- Layer 3
def severity(cls_name: str, area_frac: float) -> str:
    """Blend class prior with how much of the frame the mask covers."""
    if cls_name in HIGH_CLASSES or area_frac > 0.18:
        return "high"
    if cls_name in LOW_CLASSES and area_frac < 0.05:
        return "low"
    return "med"


def to_b64(bgr: np.ndarray, quality: int = 82) -> str:
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


def analyse(raw_bytes: bytes, conf: float = 0.25, want_images: bool = True,
            detect_on_enhanced: bool = False) -> dict:
    """Full pipeline on one image. Returns detections + rendered previews.

    IMPORTANT — detect_on_enhanced defaults to False, and that is deliberate.
    The model was fine-tuned on RAW TrashCan frames. Feeding it Layer-1 enhanced
    images at inference is a train/test distribution mismatch and measurably HURTS
    recall: on our own ghost-net frames, best-net confidence fell 0.99 -> 0.80,
    0.99 -> 0.95, and in one case 0.95 -> 0.00 (net missed entirely).

    Layer 1 therefore runs for the HUMAN-VISIBLE preview only. To make enhancement
    genuinely help the model, the training set must be enhanced too and the model
    retrained — that is the correct fix and is on the roadmap.
    """
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(400, "could not decode image — unsupported format (HEIC?)")

    # keep it sane for laptop GPUs
    h, w = bgr.shape[:2]
    scale = min(1.0, 1280 / max(h, w))
    if scale < 1.0:
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    enhanced = restore(bgr)
    target = enhanced if detect_on_enhanced else bgr

    m = model()                      # load + warm up BEFORE timing
    t0 = time.time()
    res = m.predict(target, conf=conf, retina_masks=True, verbose=False)[0]
    ms = (time.time() - t0) * 1000

    frame_px = target.shape[0] * target.shape[1]
    dets = []
    if res.boxes is not None and len(res.boxes):
        masks = res.masks.data.cpu().numpy() if res.masks is not None else None
        for i in range(len(res.boxes)):
            name = res.names[int(res.boxes.cls[i])]
            mask_px = int(masks[i].sum()) if masks is not None else 0
            frac = mask_px / frame_px if frame_px else 0.0
            dets.append({
                "cls": name,
                "label": name.replace("trash_", "").replace("_", " ").title(),
                "conf": round(float(res.boxes.conf[i]), 3),
                "mask_px": mask_px,
                "area_frac": round(frac, 4),
                "is_debris": name.startswith(DEBRIS_PREFIX),
                "severity": severity(name, frac),
                "bbox": [round(float(v), 1) for v in res.boxes.xyxy[i].tolist()],
            })
    dets.sort(key=lambda d: (d["is_debris"], d["conf"]), reverse=True)
    debris = [d for d in dets if d["is_debris"]]

    out = {
        "detections": dets,
        "debris_count": len(debris),
        "top": debris[0] if debris else (dets[0] if dets else None),
        "severity": (max((d["severity"] for d in debris),
                         key=lambda s: {"low": 0, "med": 1, "high": 2}[s])
                     if debris else "none"),
        "total_area_frac": round(sum(d["area_frac"] for d in debris), 4),
        "inference_ms": round(ms, 1),
        "size": [target.shape[1], target.shape[0]],
        "detected_on": "enhanced" if detect_on_enhanced else "raw",
    }
    if want_images:
        out["original"] = to_b64(bgr)
        out["enhanced"] = to_b64(enhanced)
        out["annotated"] = to_b64(res.plot(line_width=2))
    return out


# ---------------------------------------------------------------- storage
def load_reports() -> list:
    if STORE.exists():
        try:
            return json.loads(STORE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
    return []


def save_reports(rs: list) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(rs, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- API
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "weights": WEIGHTS.exists(),
        "model_loaded": _model is not None,
        "reports": len(load_reports()),
    }


@app.post("/api/detect")
async def detect(image: UploadFile = File(...), conf: float = Form(0.25),
                 detect_on_enhanced: bool = Form(False)):
    """Stateless: run the pipeline, return results. Used by the survey console.

    detect_on_enhanced is exposed so the A/B difference can be demonstrated live,
    but leave it False for real detection — see the note in analyse().
    """
    return analyse(await image.read(), conf=conf, detect_on_enhanced=detect_on_enhanced)


@app.get("/api/reports")
def list_reports():
    return load_reports()


@app.post("/api/reports")
async def create_report(
    image: UploadFile = File(...),
    lat: Optional[str] = Form(None),
    lng: Optional[str] = Form(None),
    note: str = Form(""),
    source: str = Form("citizen"),
    site: str = Form(""),
    lang: str = Form("en"),
):
    """Citizen/professional submission: detect, score, persist."""
    result = analyse(await image.read())

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    rid = "SN-" + uuid.uuid4().hex[:6].upper()
    rep = {
        "id": rid,
        "ts": int(time.time() * 1000),
        "lat": num(lat),
        "lng": num(lng),
        "site": site or "Unlocated",
        "note": note,
        "source": source,
        "lang": lang,
        "status": "new",
        "severity": result["severity"],
        "debris_count": result["debris_count"],
        "detections": result["detections"],
        "top": result["top"],
        "inference_ms": result["inference_ms"],
        "thumb": result["annotated"],
    }
    rs = load_reports()
    rs.insert(0, rep)
    save_reports(rs[:500])

    return JSONResponse({
        "report": {k: v for k, v in rep.items() if k != "thumb"},
        "annotated": result["annotated"],
        "enhanced": result["enhanced"],
        "detections": result["detections"],
        "whatsapp": whatsapp_payload(rep),
    })


@app.patch("/api/reports/{rid}")
def update_report(rid: str, status: str = Form(...)):
    rs = load_reports()
    for r in rs:
        if r["id"] == rid:
            r["status"] = status
            save_reports(rs)
            return r
    raise HTTPException(404, "report not found")


def whatsapp_payload(rep: dict) -> dict:
    """The exact message that would go out via WhatsApp Cloud API.

    Not sent — dispatch requires a Meta access token supplied via environment
    variable, and messaging real recipients is an explicit, separate step.
    """
    top = rep.get("top") or {}
    where = (f"{rep['lat']}, {rep['lng']}" if rep.get("lat") is not None else rep.get("site", "unknown"))
    body = (
        f"SAGAR-NETRA ALERT {rep['id']}\n"
        f"{top.get('label', 'Debris')} detected "
        f"({int(top.get('conf', 0) * 100)}% confidence)\n"
        f"Location: {where}\n"
        f"Severity: {rep['severity'].upper()}\n"
        f"Items: {rep['debris_count']}\n"
        f"Time: {time.strftime('%d %b %Y %H:%M', time.localtime(rep['ts'] / 1000))}"
    )
    return {"messaging_product": "whatsapp", "type": "text",
            "text": {"body": body}, "_status": "not_sent_no_token"}


# ---------------------------------------------------------------- static
if FRONTEND.exists():
    app.mount("/citizen", StaticFiles(directory=FRONTEND / "citizen", html=True), name="citizen")
    app.mount("/authority", StaticFiles(directory=FRONTEND / "authority", html=True), name="authority")


@app.get("/")
def index():
    return {
        "service": "SAGAR-NETRA",
        "citizen": "/citizen/",
        "authority": "/authority/",
        "docs": "/docs",
        "health": "/api/health",
    }


if __name__ == "__main__":
    import uvicorn
    print("SAGAR-NETRA  ->  http://localhost:8000/citizen/   http://localhost:8000/authority/")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
