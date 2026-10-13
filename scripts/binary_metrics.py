"""
Sensitivity / specificity style metrics for the trained SAGAR-NETRA model.

Object detection has no true negatives, so the model is scored as three yes/no tasks
on the held-out validation split, at the same confidence threshold the app uses:

  1. image level  - does the photo contain any debris (any trash_* class)?
  2. image level  - does the photo contain a ghost net (trash_net)?
  3. pixel level  - is each pixel debris? (predicted masks vs. hand-drawn polygons)

    python scripts/binary_metrics.py            # writes docs/review/eval/binary_metrics.json
"""
import argparse
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
NAMES = json.loads((ROOT / "inference" / "classes.json").read_text())
TRASH = {i for i, n in enumerate(NAMES) if n.startswith("trash_")}
NET = NAMES.index("trash_net")


def scores(tp, fp, tn, fn):
    div = lambda a, b: a / b if b else float("nan")
    sens, spec = div(tp, tp + fn), div(tn, tn + fp)
    prec, npv = div(tp, tp + fp), div(tn, tn + fn)
    mcc_den = math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
    return {
        "TP": tp, "FP": fp, "TN": tn, "FN": fn,
        "accuracy": div(tp + tn, tp + tn + fp + fn),
        "sensitivity_recall": sens,
        "specificity": spec,
        "precision_ppv": prec,
        "npv": npv,
        "f1": div(2 * prec * sens, prec + sens) if not (math.isnan(prec) or math.isnan(sens)) else float("nan"),
        "balanced_accuracy": (sens + spec) / 2,
        "false_positive_rate": div(fp, fp + tn),
        "false_negative_rate": div(fn, fn + tp),
        "mcc": div(tp * tn - fp * fn, mcc_den),
    }


def gt_for(label_path, h, w):
    classes, mask = set(), np.zeros((h, w), np.uint8)
    if label_path.exists():
        for line in label_path.read_text().splitlines():
            parts = line.split()
            if len(parts) < 7:
                continue
            c = int(parts[0]); classes.add(c)
            if c in TRASH:
                pts = (np.array(parts[1:], dtype=np.float32).reshape(-1, 2) * [w, h]).round().astype(np.int32)
                cv2.fillPoly(mask, [pts], 1)
    return classes, mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ROOT / "runs" / "sagarnetra_5k_finetune-3" / "weights" / "best.pt"))
    ap.add_argument("--images", default=str(ROOT / "data" / "yolo" / "images" / "val"))
    ap.add_argument("--conf", type=float, default=0.25, help="same threshold as the deployed app")
    ap.add_argument("--imgsz", type=int, default=512)
    ap.add_argument("--out", default=str(ROOT / "docs" / "review" / "eval" / "binary_metrics.json"))
    args = ap.parse_args()

    model = YOLO(args.weights)
    labels = Path(args.images).parent.parent / "labels" / "val"
    img_debris = [0, 0, 0, 0]   # tp fp tn fn
    img_net = [0, 0, 0, 0]
    px = [0, 0, 0, 0]
    images = sorted(p for p in Path(args.images).iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    t0 = time.time()
    for path in images:
        bgr = cv2.imread(str(path)); h, w = bgr.shape[:2]
        gt_cls, gt_mask = gt_for(labels / (path.stem + ".txt"), h, w)
        r = model.predict(bgr, conf=args.conf, imgsz=args.imgsz, retina_masks=True, verbose=False)[0]
        pred_cls = set(int(c) for c in r.boxes.cls) if r.boxes is not None else set()
        pred_mask = np.zeros((h, w), np.uint8)
        if r.masks is not None:
            for m, c in zip(r.masks.data.cpu().numpy(), r.boxes.cls):
                if int(c) in TRASH:
                    m = m if m.shape == (h, w) else cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
                    pred_mask |= (m > 0.5).astype(np.uint8)

        for acc, gt, pr in ((img_debris, bool(gt_cls & TRASH), bool(pred_cls & TRASH)),
                            (img_net, NET in gt_cls, NET in pred_cls)):
            acc[0 if gt and pr else 1 if pr else 2 if not gt else 3] += 1
        g, p = gt_mask.astype(bool), pred_mask.astype(bool)
        px[0] += int(np.sum(g & p)); px[1] += int(np.sum(~g & p))
        px[2] += int(np.sum(~g & ~p)); px[3] += int(np.sum(g & ~p))

    pixel = scores(*px)
    tp, fp, _, fn = px
    pixel["iou_jaccard"] = tp / (tp + fp + fn)
    pixel["dice"] = 2 * tp / (2 * tp + fp + fn)
    result = {
        "weights": Path(args.weights).name, "images": len(images), "conf": args.conf, "imgsz": args.imgsz,
        "seconds": round(time.time() - t0, 1),
        "image_level_debris": scores(*img_debris),
        "image_level_ghost_net": scores(*img_net),
        "pixel_level_debris": pixel,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
