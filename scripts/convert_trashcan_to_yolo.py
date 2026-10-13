"""
Convert TrashCan 1.0 (COCO instance-segmentation JSON) -> YOLOv8-seg format.

TrashCan ships COCO-style annotations. YOLOv8-seg wants, per image, a .txt with
one line per instance:   <class_idx> x1 y1 x2 y2 ... xn yn   (all normalized 0-1)

Handles both polygon segmentations (list of lists) and RLE masks (dict with
'counts'), which TrashCan mixes. Class list is read from the JSON rather than
hardcoded, so it stays correct if the release changes.
"""
import json, sys, shutil
from pathlib import Path
from collections import defaultdict

import numpy as np


def poly_area(p):
    """Shoelace area of a flat [x1,y1,x2,y2,...] polygon."""
    x = np.array(p[0::2], dtype=np.float64)
    y = np.array(p[1::2], dtype=np.float64)
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def rle_to_polygons(seg, h, w):
    """Decode an RLE mask to polygon(s) via contour tracing."""
    try:
        from pycocotools import mask as maskutils
        import cv2
    except ImportError:
        return []
    if isinstance(seg["counts"], list):
        rle = maskutils.frPyObjects(seg, h, w)
    else:
        rle = seg
    m = maskutils.decode(rle)
    if m.ndim == 3:
        m = m[..., 0]
    contours, _ = cv2.findContours(
        m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    out = []
    for c in contours:
        c = c.reshape(-1, 2)
        if len(c) >= 3:
            out.append(c.flatten().tolist())
    return out


def extract_polygons(ann, h, w):
    """Normalize any TrashCan segmentation field into a list of flat polygons."""
    seg = ann.get("segmentation")
    if not seg:
        return []
    if isinstance(seg, dict):
        return rle_to_polygons(seg, h, w)
    if isinstance(seg, list):
        # list of polygons, or a single flat polygon
        if seg and isinstance(seg[0], (int, float)):
            return [seg] if len(seg) >= 6 else []
        return [p for p in seg if isinstance(p, list) and len(p) >= 6]
    return []


def convert_split(json_path, img_src_dir, out_img_dir, out_lbl_dir, cat2idx):
    with open(json_path, "r", encoding="utf-8") as f:
        coco = json.load(f)

    images = {im["id"]: im for im in coco["images"]}
    anns_by_img = defaultdict(list)
    for a in coco["annotations"]:
        anns_by_img[a["image_id"]].append(a)

    out_img_dir.mkdir(parents=True, exist_ok=True)
    out_lbl_dir.mkdir(parents=True, exist_ok=True)

    n_img = n_inst = n_skip_rle = n_missing = 0
    for img_id, im in images.items():
        fname = Path(im["file_name"]).name
        src = img_src_dir / fname
        if not src.exists():
            n_missing += 1
            continue

        h, w = im["height"], im["width"]
        lines = []
        for a in anns_by_img.get(img_id, []):
            if a.get("iscrowd", 0):
                continue
            polys = extract_polygons(a, h, w)
            if not polys:
                n_skip_rle += 1
                continue
            # YOLO-seg carries one polygon per instance -> keep the largest part
            poly = max(polys, key=poly_area)
            cls = cat2idx.get(a["category_id"])
            if cls is None:
                continue
            coords = []
            for i in range(0, len(poly) - 1, 2):
                x = min(max(poly[i] / w, 0.0), 1.0)
                y = min(max(poly[i + 1] / h, 0.0), 1.0)
                coords += [f"{x:.6f}", f"{y:.6f}"]
            if len(coords) >= 6:
                lines.append(f"{cls} " + " ".join(coords))
                n_inst += 1

        shutil.copy2(src, out_img_dir / fname)
        (out_lbl_dir / (Path(fname).stem + ".txt")).write_text(
            "\n".join(lines), encoding="utf-8"
        )
        n_img += 1

    return n_img, n_inst, n_skip_rle, n_missing


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "yolo")

    # locate the instance_version dir wherever it sits inside the archive
    cands = list(root.rglob("instance_version"))
    if not cands:
        cands = list(root.rglob("*instance*"))
        cands = [c for c in cands if c.is_dir()]
    if not cands:
        sys.exit(f"ERROR: could not find instance_version under {root}")
    base = cands[0]
    print(f"[i] using dataset root: {base}")

    splits = {}
    for split in ("train", "val"):
        js = list(base.glob(f"*{split}*.json"))
        imd = base / split
        if not js:
            sys.exit(f"ERROR: no {split} json in {base}")
        if not imd.is_dir():
            alt = [d for d in base.iterdir() if d.is_dir() and split in d.name]
            if not alt:
                sys.exit(f"ERROR: no {split} image dir in {base}")
            imd = alt[0]
        splits[split] = (js[0], imd)
        print(f"[i] {split}: {js[0].name}  images={imd}")

    # build class index from the train json (COCO ids are not contiguous)
    with open(splits["train"][0], "r", encoding="utf-8") as f:
        cats = json.load(f)["categories"]
    cats = sorted(cats, key=lambda c: c["id"])
    cat2idx = {c["id"]: i for i, c in enumerate(cats)}
    names = [c["name"] for c in cats]
    print(f"[i] {len(names)} classes: {names}")

    for split, (js, imd) in splits.items():
        n_img, n_inst, n_rle, n_miss = convert_split(
            js, imd, out / "images" / split, out / "labels" / split, cat2idx
        )
        print(
            f"[OK] {split}: {n_img} images, {n_inst} instances"
            f"{f', {n_rle} unusable segs' if n_rle else ''}"
            f"{f', {n_miss} missing files' if n_miss else ''}"
        )

    yaml = (
        f"# SAGAR-NETRA - TrashCan 1.0 (instance version), YOLOv8-seg format\n"
        f"path: {out.resolve().as_posix()}\n"
        f"train: images/train\n"
        f"val: images/val\n\n"
        f"nc: {len(names)}\n"
        f"names:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(names))
    )
    (out / "data.yaml").write_text(yaml, encoding="utf-8")
    print(f"[OK] wrote {out / 'data.yaml'}")


if __name__ == "__main__":
    main()
