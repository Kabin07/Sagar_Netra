"""
Evaluate the trained SAGAR-NETRA checkpoint on the held-out validation split.

    python scripts/evaluate.py                       # best.pt on data/yolo val, imgsz 640
    python scripts/evaluate.py --out docs/review/eval

Writes metrics.json (overall + per-class box/mask precision, recall, mAP50, mAP50-95,
speed) and Ultralytics' plots (PR curves, confusion matrix) into --out. Does not touch
runs/ or the checkpoint.
"""
import argparse
import json
import time
from pathlib import Path

import yaml
from ultralytics import YOLO


def dataset_root(data_yaml):
    """Directory holding images/ and labels/: the yaml's `path:` key, else the yaml's own folder."""
    data_yaml = Path(data_yaml)
    root = (yaml.safe_load(data_yaml.read_text(encoding="utf-8")) or {}).get("path")
    if not root:
        return data_yaml.parent
    root = Path(root)
    return root if root.is_absolute() else data_yaml.parent / root

ROOT = Path(__file__).resolve().parent.parent


def summary(metric):
    p, r = float(metric.mp), float(metric.mr)
    return {"precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0,
            "map50": float(metric.map50), "map75": float(metric.map75), "map50_95": float(metric.map)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ROOT / "runs" / "sagarnetra_gpu_v2" / "weights" / "best.pt"))
    ap.add_argument("--data", default=str(ROOT / "data" / "yolo" / "data.yaml"))
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.001, help="Ultralytics' standard low threshold for mAP")
    ap.add_argument("--device", default="")
    ap.add_argument("--out", default=str(ROOT / "docs" / "review" / "eval"))
    args = ap.parse_args()

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    model = YOLO(args.weights)
    t0 = time.time()
    m = model.val(data=args.data, imgsz=args.imgsz, conf=args.conf, batch=8, device=args.device or None,
                  split="val", plots=True, project=str(out), name="ultralytics", exist_ok=True, verbose=False)
    wall = time.time() - t0

    names = m.names
    per_class = []
    for i, c in enumerate(m.box.ap_class_index):
        c = int(c)
        per_class.append({
            "class_index": c, "class_name": names[c],
            "box_precision": float(m.box.p[i]), "box_recall": float(m.box.r[i]),
            "box_map50": float(m.box.ap50[i]), "box_map50_95": float(m.box.ap[i]),
            "mask_precision": float(m.seg.p[i]), "mask_recall": float(m.seg.r[i]),
            "mask_map50": float(m.seg.ap50[i]), "mask_map50_95": float(m.seg.ap[i]),
        })
    # instance counts per class from the validation labels
    counts = {}
    for lbl in (dataset_root(args.data) / "labels" / "val").glob("*.txt"):
        for line in lbl.read_text().splitlines():
            if line.strip():
                k = int(line.split()[0])
                counts[k] = counts.get(k, 0) + 1
    for pc in per_class:
        pc["val_instances"] = counts.get(pc["class_index"], 0)

    result = {
        "weights": Path(args.weights).name,
        "imgsz": args.imgsz,
        "val_images": len(list((dataset_root(args.data) / "images" / "val").glob("*"))),
        "val_instances": sum(counts.values()),
        "box": summary(m.box),
        "mask": summary(m.seg),
        "speed_ms_per_image": {k: round(v, 2) for k, v in m.speed.items()},
        "wall_seconds": round(wall, 1),
        "per_class": per_class,
    }
    (out / "metrics.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != "per_class"}, indent=2))


if __name__ == "__main__":
    main()
