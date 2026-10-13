"""
Run SAGAR-NETRA inference and write annotated images (masks + boxes + labels).

Defaults to sampling held-out val images, so what you show in the demo is data
the model never trained on.
"""
import argparse, random, shutil
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(ROOT / "runs" / "sagarnetra_v8nseg" / "weights" / "best.pt"))
    ap.add_argument("--source", default=None, help="image/dir/video; default = sample of val set")
    ap.add_argument("--n", type=int, default=8, help="how many val images to sample")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--device", default="0")
    ap.add_argument("--out", default=str(ROOT / "demo_outputs"))
    args = ap.parse_args()

    out = Path(args.out).resolve()   # absolute: Ultralytics re-roots relative project paths into runs/
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    source = args.source
    if source is None:
        val_dir = ROOT / "data" / "yolo" / "images" / "val"
        imgs = sorted(p for p in val_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
        random.seed(0)
        picked = random.sample(imgs, min(args.n, len(imgs)))
        stage = out / "_inputs"
        stage.mkdir(exist_ok=True)
        for p in picked:
            shutil.copy2(p, stage / p.name)
        source = str(stage)
        print(f"[i] sampled {len(picked)} held-out val images")

    model = YOLO(args.weights)
    results = model.predict(
        source=source,
        conf=args.conf,
        device=args.device,
        save=True,
        project=str(out),
        name="annotated",
        exist_ok=True,
        retina_masks=True,   # full-res masks, much cleaner on screen
        line_width=2,
    )

    print("\n=== DETECTIONS ===")
    total = 0
    for r in results:
        n = 0 if r.boxes is None else len(r.boxes)
        total += n
        names = []
        if n:
            names = [f"{r.names[int(c)]} {float(s):.2f}"
                     for c, s in zip(r.boxes.cls, r.boxes.conf)]
        print(f"{Path(r.path).name:40s} {n:2d}  {', '.join(names) if names else '(none)'}")
    print(f"\n[OK] {total} detections across {len(results)} images")
    print(f"[OK] annotated images: {out / 'annotated'}")


if __name__ == "__main__":
    main()
