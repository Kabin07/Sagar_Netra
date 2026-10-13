"""Train SAGAR-NETRA YOLOv8 instance-segmentation model on a larger dataset.

Place this file in the project's scripts/ directory (replacing train.py is also OK).
The default settings are conservative for Windows systems without an NVIDIA CUDA GPU.
"""
import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def default_weights():
    candidates = [
        ROOT / "demo_model" / "best.pt",
        ROOT / "runs" / "sagarnetra_v8nseg" / "weights" / "best.pt",
    ]
    for path in candidates:
        if path.is_file():
            return str(path)
    return "yolov8n-seg.pt"  # COCO-pretrained fallback


def main():
    parser = argparse.ArgumentParser(description="Fine-tune SAGAR-NETRA on the expanded dataset")
    parser.add_argument("--data", default=str(ROOT / "data" / "yolo" / "data.yaml"))
    parser.add_argument("--weights", default=None,
                        help="checkpoint .pt; defaults to demo_model/best.pt, then previous run, then yolov8n-seg.pt")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=512)
    parser.add_argument("--batch", type=int, default=2)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--device", default="cpu", help="Use cpu by default; use 0 only with a supported NVIDIA CUDA GPU")
    parser.add_argument("--name", default="sagarnetra_5k_finetune")
    parser.add_argument("--patience", type=int, default=12)
    args = parser.parse_args()

    data_yaml = Path(args.data).resolve()
    if not data_yaml.is_file():
        raise FileNotFoundError(f"Dataset YAML not found: {data_yaml}\nCheck --data and data/yolo/data.yaml.")

    weights = args.weights or default_weights()
    print(f"Dataset YAML : {data_yaml}")
    print(f"Starting weights: {weights}")
    print(f"Device={args.device}, epochs={args.epochs}, imgsz={args.imgsz}, batch={args.batch}, workers={args.workers}")
    if weights != "yolov8n-seg.pt":
        print("IMPORTANT: fine-tuning assumes the checkpoint's class IDs have the same meaning as labels in data.yaml.")

    model = YOLO(weights)
    model.train(
        task="segment",
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        workers=args.workers,
        device=args.device,
        project=str(ROOT / "runs"),
        name=args.name,
        exist_ok=False,       # avoids overwriting an earlier run
        pretrained=True,
        patience=args.patience,
        save=True,
        save_period=5,        # periodic checkpoints in addition to best.pt / last.pt
        cache=False,          # avoids filling RAM with thousands of images
        amp=(args.device != "cpu"),
        seed=0,
        deterministic=True,
        plots=True,
        val=True,
        close_mosaic=10,
    )

    best = ROOT / "runs" / args.name / "weights" / "best.pt"
    last = ROOT / "runs" / args.name / "weights" / "last.pt"
    print("\nTraining finished.")
    print(f"Best checkpoint: {best}")
    print(f"Last checkpoint: {last}")
    print("Run validation with: yolo segment val model=\"" + str(best) + "\" data=\"" + str(data_yaml) + "\"")


if __name__ == "__main__":
    main()
