"""Self-test of the deployed inference service on held-out ghost-net frames (demo_inputs_net/).
Frame-level check against ground-truth labels: is each labelled class found (conf >= 0.25)?"""
import json, os, statistics, time, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
env = dict(l.split("=", 1) for l in (ROOT / "inference/.env").read_text().splitlines() if "=" in l and not l.startswith("#"))
token = env["SN_INFERENCE_TOKEN"].strip()
names = json.loads((ROOT / "inference/classes.json").read_text())
rows, lat = [], []
for img in sorted((ROOT / "demo_inputs_net").glob("*.jpg")):
    gt = {names[int(l.split()[0])] for l in (ROOT / "data/yolo/labels/val" / (img.stem + ".txt")).read_text().splitlines() if l.strip()}
    req = urllib.request.Request("http://127.0.0.1:8001/v1/segment?conf=0.25", data=img.read_bytes(), method="POST",
                                 headers={"X-Inference-Token": token, "Content-Type": "application/octet-stream"})
    t0 = time.perf_counter(); out = json.load(urllib.request.urlopen(req)); lat.append((time.perf_counter() - t0) * 1000)
    pred = {}
    for d in out["detections"]:
        pred[d["class_name"]] = max(pred.get(d["class_name"], 0), d["confidence"])
    rows.append({"image": img.name, "gt": sorted(gt), "pred": pred})
net_frames = [r for r in rows if "trash_net" in r["gt"]]
hit = [r for r in net_frames if "trash_net" in r["pred"]]
fp = [r for r in rows if "trash_net" not in r["gt"] and "trash_net" in r["pred"]]
gt_total = sum(len(r["gt"]) for r in rows); gt_found = sum(1 for r in rows for c in r["gt"] if c in r["pred"])
pred_total = sum(len(r["pred"]) for r in rows); pred_right = sum(1 for r in rows for c in r["pred"] if c in r["gt"])
summary = {
    "frames": len(rows), "frames_with_net_gt": len(net_frames), "net_frames_detected": len(hit),
    "net_frame_recall": round(len(hit) / max(1, len(net_frames)), 3),
    "mean_net_confidence_when_detected": round(statistics.mean(r["pred"]["trash_net"] for r in hit), 3) if hit else None,
    "frames_with_false_net": len(fp),
    "class_presence_recall": round(gt_found / gt_total, 3), "class_presence_precision": round(pred_right / max(1, pred_total), 3),
    "latency_ms_median": round(statistics.median(lat), 1), "latency_ms_p95": round(sorted(lat)[int(0.95 * (len(lat) - 1))], 1),
}
(Path(__file__).parent / "selftest.json").write_text(json.dumps({"summary": summary, "frames": rows}, indent=2))
print(json.dumps(summary, indent=2))
