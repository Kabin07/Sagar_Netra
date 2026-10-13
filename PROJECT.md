# SAGAR-NETRA

**AI-powered ghost-net and marine debris detection for Indian coastal waters**

*Sagar* (सागर) — ocean · *Netra* (नेत्र) — eye

---

## 1. Executive summary

SAGAR-NETRA is an end-to-end system that lets anyone — a fisherman, a beachgoer, or a
government survey team — photograph marine debris and have it automatically identified,
geolocated, prioritised, and routed to the coastal authority responsible for clearing it.

The core is a **YOLOv8n-seg instance-segmentation model** trained on real underwater
imagery. It does not merely say "there is trash here"; it returns a **pixel mask** for
each object, which is what makes it possible to estimate how much debris there is and
therefore how urgently a boat should be dispatched.

**Current status: working prototype.** The detection model is trained and measured. Both
frontends are wired to a Node.js/Express + PostgreSQL backend and a private Python
inference service running `best.pt` (see README.md). The WhatsApp dispatch layer is
specified but not yet implemented.

| | |
|---|---|
| **Model** | YOLOv8n-seg, 3.26M parameters, 11.5 GFLOPs |
| **Training data** | TrashCan 1.0 — 7,212 real underwater images, 22 classes |
| **Performance** | Mask mAP50 **0.541** · Box mAP50 **0.560** |
| **Ghost-net class** | Mask mAP50 **0.502**, recall **0.697** |
| **Speed** | **15.4 ms/image (~65 FPS)** on an RTX 3050 laptop GPU |
| **Training cost** | ~40 minutes, single consumer laptop |

---

## 2. The problem

**Ghost nets** are fishing nets that have been lost, abandoned, or discarded at sea.
Unlike most marine litter, they keep doing the job they were built for: they continue to
catch and kill fish, turtles, dolphins and seabirds for years or decades after the boat
that lost them has gone. This is called *ghost fishing*.

They are also uniquely difficult to deal with:

- **They drift.** A net reported yesterday is not where it was yesterday.
- **They are nearly invisible.** Monofilament in turbid water is hard for a human
  observer to see, let alone a satellite.
- **They are sprawling and shapeless.** A net is not a compact object, which — as
  Section 6 explains — has direct consequences for how you must model it.
- **Nobody is reliably reporting them.** Fishermen see them constantly. There is
  generally no fast, low-friction way to tell anyone who can act.

India has roughly **7,500 km of coastline** and one of the world's largest marine
fisheries sectors, which means an enormous number of potential observers already on the
water every day — and no channel to collect what they see.

> **Verify before quoting.** Commonly cited figures include an FAO/UNEP estimate of
> ~640,000 tonnes of fishing gear entering the ocean annually. Check the primary source
> and date before putting any number on a slide — a judge who knows the literature will
> ask, and a wrong figure undermines otherwise solid work.

### The gap SAGAR-NETRA addresses

The bottleneck is not *cleanup capability*. It is **detection, reporting, and
prioritisation**. Authorities cannot dispatch a boat to a net nobody has reported, and
cannot prioritise between twenty reports without knowing which is a drifting 200 m² net
and which is a single plastic bottle.

---

## 3. Solution overview

```
   ┌──────────────┐         ┌──────────────┐
   │ Citizen PWA  │         │  Authority   │
   │              │         │   console    │
   │ fisherman    │         │ ROV / survey │
   │ takes photo  │         │ team upload  │
   └──────┬───────┘         └──────┬───────┘
          │                        │
          └───────────┬────────────┘
                      ▼
        ╔═════════════════════════════╗
        ║  LAYER 1 — OpenCV           ║  restore the image
        ║  white balance + CLAHE      ║
        ╠═════════════════════════════╣
        ║  LAYER 2 — YOLOv8n-seg      ║  what, where, how much
        ║  22-class instance seg      ║
        ╠═════════════════════════════╣
        ║  LAYER 3 — GIS              ║  where to send the boat
        ║  geotag · cluster · score   ║
        ╚══════════════┬══════════════╝
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   WhatsApp alert            Operations console
   citizen + response unit   map · queue · triage
```

---

## 4. System architecture

### Layer 1 — Image restoration (OpenCV)

Underwater images suffer two specific, physically-caused problems: **colour cast**
(water absorbs red light first, so everything trends blue-green with depth) and **low
contrast** (backscatter from suspended particles washes out edges).

| Technique | Purpose |
|---|---|
| Gray-world white balance | Neutralises the blue-green cast by equalising per-channel means |
| CLAHE | Restores local contrast without amplifying noise globally |
| Percentile contrast stretch | Expands the usable dynamic range |

> **State this correctly.** Layer 1 is **preprocessing, not a detector.** Describing
> OpenCV as an "AI detection layer" is factually wrong and invites a correction. Its real
> significance is that it directly attacks turbidity — the single largest weakness of the
> current model (Section 8).

### Layer 2 — Detection (YOLOv8n-seg)

Instance segmentation across 22 classes. Returns, per object: class label, confidence,
bounding box, and a **pixel mask**.

**Why segmentation instead of plain object detection.** A ghost net is thin, non-convex
and sprawling. Its bounding box is mostly water — a box around a drifting net tells you
almost nothing about how much net is actually there. The mask gives true pixel extent,
which is what feeds the severity score. This is the single most important design
decision in the project, and it is defensible on physical grounds, not aesthetic ones.

**Why the nano model.** 3.26M parameters and 11.5 GFLOPs, running at ~65 FPS on a laptop
GPU. The deployment target is eventually an onboard AUV/ROV or a phone, where compute and
power are constrained. Choosing nano is a deployment decision, not a compromise forced by
lack of time.

**Why transfer learning.** Training starts from COCO-pretrained weights (381 of 417
layers transferred). The backbone already understands edges, textures and object-ness
from 118k images; only the head is re-specialised. This is why 15 epochs on 6k images
produces a working detector at all — from scratch this would need hundreds of epochs and
far more data.

### Layer 3 — Geospatial aggregation (GIS)

| Function | Description |
|---|---|
| Geotagging | GPS from the phone, or EXIF from survey imagery |
| Severity scoring | Mask pixel area → estimated m² → priority band |
| Clustering | Multiple sightings of one net collapse into a single incident *(specified, not yet implemented)* |
| Routing | Match incident to nearest response unit |

---

## 5. Dataset

**TrashCan 1.0** — Hong, Fulton & Sattar, University of Minnesota (2020).
Open-access via the UMN DRUM repository. No API key required.

| | |
|---|---|
| Images | 7,212 (6,065 train / 1,147 val) |
| Annotations | 12,128 instance masks |
| Classes | 22 |
| Source | ROV footage, largely Sea of Japan (JAMSTEC) |
| Format | COCO instance-segmentation JSON → converted to YOLO polygons |

**Why this dataset over a Roboflow alternative.** TrashCan is the *original academic
source*. Most "Marine Debris" datasets on Roboflow Universe are re-annotated derivatives
of it, frequently bounding-box only. Since instance segmentation is central to this
project, going to the primary source is both more rigorous and — because it needs no API
key — easier.

**Why the `instance_version` and not `material_version`.** The instance version keeps
`trash_net` and `trash_rope` as distinct classes. The material version collapses them
into generic `trash_plastic`, which would eliminate the ghost-net framing entirely.

**Class list (22):** `rov`, `plant`, `animal_fish`, `animal_starfish`, `animal_shells`,
`animal_crab`, `animal_eel`, `animal_etc`, `trash_clothing`, `trash_pipe`,
`trash_bottle`, `trash_bag`, `trash_snack_wrapper`, `trash_can`, `trash_cup`,
`trash_container`, `trash_unknown_instance`, `trash_branch`, `trash_wreckage`,
`trash_tarp`, `trash_rope`, `trash_net`

### Conversion

TrashCan ships COCO JSON; YOLOv8-seg requires per-image `.txt` files of normalised
polygons. A custom converter (`scripts/convert_trashcan_to_yolo.py`) handles this,
including multi-part polygons and RLE-encoded masks.

**Result: 12,128 of 12,128 annotations converted, zero dropped.** Ultralytics'
independent label scan reported **"0 corrupt"** across all 1,147 validation images.

---

## 6. Results

15 epochs · batch 8 · 640 px · AMP · RTX 3050 6 GB · ~40 minutes

### Overall

| Metric | Box | Mask |
|---|---|---|
| mAP50 | 0.560 | 0.541 |
| mAP50-95 | 0.399 | 0.310 |

Progression was monotonic with **no plateau** — mAP50 rose 0.130 → 0.560 across 15
epochs and was still climbing at the end. The model is **undertrained, not overfit**.
Framed correctly this is a strength: it is a deliberately time-boxed baseline with
obvious headroom, not a converged ceiling.

### Per class

| Class | Box mAP50 | Mask mAP50 | Recall | Instances (val) |
|---|---|---|---|---|
| rov | 0.929 | 0.943 | 0.891 | 681 |
| trash_pipe | 0.899 | 0.894 | 0.952 | 42 |
| trash_branch | 0.800 | 0.800 | 0.750 | 68 |
| trash_container | 0.785 | 0.762 | 0.728 | 103 |
| trash_wreckage | 0.754 | 0.754 | 0.657 | 35 |
| trash_can | 0.719 | 0.720 | 0.583 | 93 |
| trash_bag | 0.688 | 0.681 | 0.707 | 181 |
| trash_bottle | 0.651 | 0.651 | 0.692 | 26 |
| animal_eel | 0.629 | 0.640 | 0.576 | 84 |
| **trash_net** | **0.523** | **0.502** | **0.697** | **33** |
| trash_rope | 0.428 | **0.124** | 0.379 | 29 |

### Inference speed

| Stage | Time |
|---|---|
| Preprocess | 0.2 ms |
| Inference | **3.3 ms** |
| Postprocess | 3.5 ms |
| End-to-end (single image, incl. I/O) | ~15.4 ms → **~65 FPS** |

First call after load is ~2,800 ms — that is CUDA context initialisation, not model
speed. **Warm the model up before any live demo.**

---

## 7. The frontends

Full detail in **`FRONTEND.md`**.

### Citizen PWA — `frontend/citizen/`

Mobile-first installable web app for fishermen and the public.

- Native camera capture via `capture` file input — **works over plain HTTP**, unlike
  `getUserMedia` which requires HTTPS. This is what makes a local-network phone demo
  possible.
- Original / Enhanced toggle showing Layer 1 restoration live
- GPS tagging with manual fallback
- Four languages: English, Hindi, Tamil, Malayalam
- Report history and offline app shell

**Why a PWA rather than a native app:** no build toolchain, distributed as a URL, opens
on any judge's phone, and wraps into a store build later (Capacitor/TWA) with no rewrite.

### Authority console — `frontend/authority/`

Desktop web console for coastal authorities and professional survey teams.

**Operations tab** — Leaflet GIS map with pins sized by estimated debris area and
coloured by severity; triage queue filterable by status, ghost-nets-only, and
citizen-vs-professional source; detail panel with confidence, coordinates, estimated
area, provenance and a `New → Assigned → Resolved` workflow; live KPI bar.

**Field Survey tab** — batch drag-and-drop upload for ROV pilots, dive teams and patrol
crews, with Layer 1 enhancement applied per image.

---

## 8. Limitations — state these before a judge finds them

Honesty here is worth more than polish. Each item below is real.

1. **The official train/val split leaks.** TrashCan splits *frames*, not *video clips* —
   **113 of 115 validation videos also appear in training**. Validation frames are
   near-duplicates of training frames. Reported mAP is therefore **optimistic** and
   partly measures memorisation. The numbers remain comparable to the published
   baseline, but they are not a clean generalisation estimate. Fix: a video-disjoint
   re-split.

2. **Clear water only.** TrashCan is Sea-of-Japan ROV footage in clear-to-moderate
   visibility. Indian coastal waters — especially near river mouths and during monsoon —
   are far more turbid. **This model will degrade there.** This is the single largest gap
   between the prototype and deployment.

3. **Ghost-net classes are rare.** `trash_net` has 94 training instances and
   `trash_rope` 88, out of 9,540. The model still reaches 0.50 mask mAP50 on nets, but
   that rests on very few distinct scenes.

4. **Rope segmentation is poor (mask mAP50 0.124).** Thin, wiry structures survive the
   box head but collapse in the mask head, which predicts masks at ¼ resolution
   (`mask_ratio=4`). First remedies: raise mask resolution or input size.

5. **Large nets fragment into duplicate detections.** A single sprawling net can fire as
   several overlapping instances. NMS assumes compact objects. Remedies: lower IoU
   threshold, or class-wise mask merging.

6. **Severity scoring is uncalibrated.** Mask pixel area is converted to m² using a fixed
   assumed scale. Real conversion needs camera altitude/depth or a reference object in
   frame.

7. **WhatsApp is not connected.** The authority console shows the payload as a preview, not sent.

8. **Authentication exists but is basic.** Accounts, bcrypt, revocable sessions and an
   admin-only console are implemented; email verification, password reset and HTTPS
   termination are not.

---

## 9. Roadmap

| Priority | Item | Rationale |
|---|---|---|
| 1 | ~~Backend connecting frontends to `best.pt`~~ | Done: Express + PostgreSQL + inference service |
| 2 | WhatsApp Cloud API dispatch | Closes the loop to fishermen and authorities |
| 3 | Video-disjoint re-split | Produces an honest generalisation number |
| 4 | **CycleGAN turbid-water domain adaptation** | Directly addresses limitation #2 |
| 5 | Longer training / larger backbone | mAP had not plateaued |
| 6 | Offline store-and-forward (Background Sync) | Boats lack connectivity |
| 7 | Live ROV/drone stream inference | 65 FPS headroom already exists |
| 8 | Duplicate-sighting clustering | Prevents dispatching three boats to one net |
| 9 | Authentication and role separation | Prerequisite for any real deployment |

### On WhatsApp integration

The Meta WhatsApp Cloud API **test number** works without business verification but only
messages 5 pre-registered numbers. Business-initiated messages outside a 24-hour window
require pre-approved templates, and inbound messaging needs a public HTTPS webhook.

**Build it with a dry-run mode that logs the exact payload.** A live demo that depends on
a third-party API, a public tunnel and template approval is fragile; the payload view in
the authority console already demonstrates the design without that risk.

---

## 10. Tech stack

| Layer | Technology |
|---|---|
| Model | Ultralytics YOLOv8n-seg 8.4.127 |
| Framework | PyTorch 2.6.0 + CUDA 12.4 |
| Preprocessing | OpenCV (server) / Canvas (client preview) |
| Language | Python 3.13 |
| Hardware | NVIDIA RTX 3050 Laptop, 6 GB |
| Citizen app | PWA — HTML/CSS/JS, service worker, no framework |
| Authority console | HTML/CSS/JS + Leaflet 1.9.4 |
| Maps | Leaflet + OpenStreetMap tiles (no API key; dark style via CSS filter) |
| Backend | Node.js/Express 5 + PostgreSQL; Python inference service |
| Planned messaging | WhatsApp Cloud API |

---

## 11. Reproducing the model

```bash
# 1. environment
python -m venv .venv
.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\python.exe -m pip install ultralytics

# 2. convert TrashCan COCO -> YOLO-seg
.venv\Scripts\python.exe scripts\convert_trashcan_to_yolo.py data\dataset data\yolo

# 3. train
.venv\Scripts\python.exe scripts\train.py --epochs 15

# 4. inference
.venv\Scripts\python.exe scripts\predict.py

# 5. freeze weights for demo
.venv\Scripts\python.exe scripts\package_demo.py
```

### Frontends

```bash
python -m http.server 5180 --directory frontend
```

- Citizen PWA — http://localhost:5180/citizen/
- Authority console — http://localhost:5180/authority/

### Live demo snippet

```python
from ultralytics import YOLO
model = YOLO("demo_model/best.pt")
model.predict("warmup.jpg", verbose=False)          # WARM UP FIRST
r = model.predict("image.jpg", conf=0.25, retina_masks=True, save=True)[0]
```

---

## 12. Project structure

```
sagar-netra/
├── scripts/
│   ├── convert_trashcan_to_yolo.py   COCO -> YOLO-seg converter
│   ├── train.py                      fine-tuning
│   ├── predict.py                    inference + mask rendering
│   └── package_demo.py               freeze weights for demo
├── frontend/
│   ├── citizen/                      mobile PWA
│   └── authority/                    desktop console
├── demo_model/
│   ├── best.pt                       trained weights (6.8 MB)
│   ├── results.csv / results.png     training curves
│   ├── confusion_matrix.png
│   └── classes.json
├── data/
│   ├── dataset/                      original TrashCan extract
│   └── yolo/                         converted + data.yaml
├── runs/                             training output, annotated images
├── PROJECT.md                        this document
├── FRONTEND.md                       frontend documentation
└── README.md                         model results and caveats
```

---

## 13. References

1. Hong, J., Fulton, M., & Sattar, J. (2020). *TrashCan: A Semantically-Segmented
   Dataset towards Visual Detection of Marine Debris.* University of Minnesota.
   Dataset: UMN DRUM, handle `11299/214865`.
2. Jocher, G., et al. *Ultralytics YOLOv8.* https://github.com/ultralytics/ultralytics
3. Zhu, J.-Y., et al. (2017). *Unpaired Image-to-Image Translation using
   Cycle-Consistent Adversarial Networks (CycleGAN).* ICCV.
4. Meta. *WhatsApp Cloud API documentation.*
   https://developers.facebook.com/docs/whatsapp/cloud-api

Imagery in the training set is credited to JAMSTEC via the TrashCan dataset.

---

## 14. One-paragraph pitch

> Ghost nets keep killing marine life for decades after they are lost, they drift, and
> they are almost invisible in turbid water — yet the people who see them most often,
> fishermen, have no way to report them to anyone who can act. SAGAR-NETRA closes that
> loop. A fisherman photographs a net on a phone; OpenCV restores the underwater colour
> and contrast; a YOLOv8 segmentation model identifies it and measures its true extent
> from the pixel mask rather than a bounding box; and a GIS layer geotags, prioritises
> and routes it to the nearest coastal authority, with a WhatsApp alert closing the loop
> back to both parties. The model runs at 65 FPS on a laptop GPU and is small enough to
> deploy onboard an ROV. It is trained and measured today on clear-water data; adapting
> it to India's turbid coastal waters is the next documented step.
