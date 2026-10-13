# SAGAR-NETRA — Marine Debris Detection Baseline

YOLOv8n-seg instance segmentation for ghost-net / debris detection in coastal waters.

## What this is

A **clear-water baseline**. Trained on TrashCan 1.0 (Hong, Fulton & Sattar, Univ. of
Minnesota) — 7,212 real underwater images with instance-segmentation masks, captured
largely in the Sea of Japan via ROV.

The `instance_version` class set is used deliberately: it contains **`trash_net`** and
**`trash_rope`** as distinct classes, which map directly onto the ghost-net problem,
rather than collapsing them into a generic "plastic" bucket.

## Known limitation (state this before you're asked)

TrashCan is predominantly **clear-to-moderate visibility** water. Indian coastal
waters — especially near river mouths and during monsoon — are significantly more
turbid, with heavy backscatter and a strong green-blue color cast. This model will
degrade there. Domain adaptation (CycleGAN-based turbid-water style transfer, or
underwater image restoration as a preprocessing stage) is the documented next step,
not something this baseline claims to solve.

## Setup

```
.venv/                    # python 3.13 + torch(cu124) + ultralytics
data/dataset/             # extracted TrashCan 1.0
data/yolo/                # converted to YOLOv8-seg format
  images/{train,val}/
  labels/{train,val}/     # <cls> x1 y1 x2 y2 ... (normalized polygons)
  data.yaml
scripts/
runs/                     # training output
demo_model/               # frozen weights for the demo
```

## Pipeline

```bash
# 1. convert COCO -> YOLO-seg  (once)
.venv/Scripts/python.exe scripts/convert_trashcan_to_yolo.py data/dataset data/yolo

# 2. train
.venv/Scripts/python.exe scripts/train.py --epochs 15

# 3. inference on held-out val images
.venv/Scripts/python.exe scripts/predict.py

# 4. freeze weights for the demo
.venv/Scripts/python.exe scripts/package_demo.py
```

## Live demo snippet

```python
from ultralytics import YOLO
model = YOLO("demo_model/best.pt")
r = model.predict("some_image.jpg", conf=0.25, retina_masks=True, save=True)
```

## Talking points

- **Transfer learning**, not from scratch: starts from COCO-pretrained YOLOv8n-seg,
  so 15 epochs on ~6k images is enough for a working detector.
- **Segmentation, not just boxes**: a ghost net is a thin, non-convex, sprawling
  object. A bounding box around a drifting net is mostly water; the mask is what
  gives you usable area/extent for cleanup tasking.
- **Nano model on purpose**: ~3.4M params, targeted at eventual onboard AUV/ROV
  deployment where compute and power are constrained.

---

## Results (15 epochs, YOLOv8n-seg, RTX 3050 6GB, ~40 min)

Official TrashCan split, 1147 val images / 2585 instances.

| Metric | Box | Mask |
|---|---|---|
| mAP50 | 0.560 | 0.541 |
| mAP50-95 | 0.399 | 0.310 |

Selected per-class (mAP50 box / mask):

| Class | Box | Mask | Recall |
|---|---|---|---|
| rov | 0.929 | 0.943 | 0.891 |
| trash_pipe | 0.899 | 0.894 | 0.952 |
| trash_container | 0.785 | 0.762 | 0.728 |
| trash_branch | 0.800 | 0.800 | 0.750 |
| trash_wreckage | 0.754 | 0.754 | 0.657 |
| trash_can | 0.719 | 0.720 | 0.583 |
| trash_bag | 0.688 | 0.681 | 0.707 |
| **trash_net** | **0.523** | **0.502** | **0.697** |
| trash_rope | 0.428 | 0.124 | 0.379 |

Inference: **15.4 ms/image (~65 FPS)** on RTX 3050 laptop GPU.

## Caveats to state up front (do not let a judge find these first)

1. **The official split leaks across videos.** 113 of 115 val videos also appear in
   train — TrashCan splits *frames*, not *clips*, so val frames are near-duplicates
   of training frames. Reported mAP is therefore optimistic. Numbers stay comparable
   to the published baseline, but they are not a clean generalization estimate.
   A video-disjoint re-split is the fix.

2. **Ghost-net classes are rare.** trash_net has 94 train instances, trash_rope 88,
   out of 9,540. The model reaches 0.50 mask mAP50 on nets anyway, but that rests on
   very few distinct scenes.

3. **trash_rope mask quality is poor (0.124).** Thin, wiry structures survive the box
   head but collapse in the mask head, which predicts masks at 1/4 resolution
   (mask_ratio=4). Raising mask resolution or imgsz would be the first thing to try.

4. **Large nets fragment into duplicate detections.** A single sprawling net can fire
   as several overlapping instances (see vid_000055_frame0000055). NMS assumes
   compact objects. Lower IoU threshold or class-wise mask merging would help.

5. **Clear water only.** TrashCan is Sea-of-Japan ROV footage. Indian coastal turbidity
   is the documented gap; CycleGAN domain adaptation is the planned next step.

6. **Undertrained on purpose.** mAP was still climbing at epoch 15 (0.13 -> 0.56, no
   plateau). This is a time-boxed baseline, not a converged model. More epochs would
   improve it — a strength of the result, not a weakness, if framed correctly.

## Live demo

```python
from ultralytics import YOLO
model = YOLO(r"demo_model/best.pt")
model.predict("demo_inputs_net/vid_000052_frame0000082.jpg", verbose=False)  # WARM UP FIRST
r = model.predict("demo_inputs_net/vid_000052_frame0000082.jpg",
                  conf=0.25, retina_masks=True, save=True)[0]
```

**Warm up the model before presenting.** First inference is ~2800 ms (CUDA context
init); every call after is ~15 ms.

**Best demo frames** (clean, high-confidence net masks):
`vid_000052_frame0000082.jpg` (trash_net 0.99), `_0000080` (0.97), `_0000078` (0.96).
Avoid `vid_000055_frame0000055.jpg` — correct but visually cluttered with duplicates.
