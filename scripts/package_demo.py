"""
Freeze the trained model into a self-contained demo bundle.

Copies best.pt out of runs/ (which gets overwritten by the next training run),
records the class list + metrics, and smoke-tests that the copied weights load
and run. Do this BEFORE the review so a stray retrain can't destroy your demo.
"""
import json, shutil, sys
from pathlib import Path

import numpy as np
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def main():
    run = ROOT / "runs" / "sagarnetra_v8nseg"
    best = run / "weights" / "best.pt"
    if not best.exists():
        sys.exit(f"ERROR: no weights at {best} - train first.")

    bundle = ROOT / "demo_model"
    bundle.mkdir(exist_ok=True)
    shutil.copy2(best, bundle / "best.pt")
    print(f"[OK] weights -> {bundle / 'best.pt'} ({best.stat().st_size/1e6:.1f} MB)")

    for extra in ("results.csv", "results.png", "confusion_matrix.png",
                  "MaskPR_curve.png", "BoxPR_curve.png", "args.yaml"):
        src = run / extra
        if src.exists():
            shutil.copy2(src, bundle / extra)
            print(f"[OK] {extra}")

    # smoke test: the copied file must actually load and infer
    m = YOLO(str(bundle / "best.pt"))
    dummy = (np.random.rand(640, 640, 3) * 255).astype("uint8")
    m.predict(dummy, verbose=False, device="cpu")
    (bundle / "classes.json").write_text(
        json.dumps(m.names, indent=2), encoding="utf-8")
    print(f"[OK] smoke test passed - {len(m.names)} classes")
    print(f"\nDemo bundle ready: {bundle}")
    print(f"Load with:  YOLO(r\"{(bundle / 'best.pt')}\")")


if __name__ == "__main__":
    main()
