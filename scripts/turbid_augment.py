"""
Make a "turbid water" copy of a YOLO-seg dataset split, to train and test for murky coastal
water (e.g. Indian river mouths and monsoon coasts) without underwater photos from there.

Per image, with random strength, it applies an underwater image-formation model
    out = img * t + veil * (1 - t),   t = per-channel transmission over a smooth "distance" map
plus a green / brown / yellow-green / teal colour cast, low light, blur, suspended particles
("marine snow") and sensor noise. Object positions are unchanged, so labels are copied as-is.

    # turbid copy of half the training images (added to training alongside the originals)
    python scripts/turbid_augment.py SRC_IMAGES SRC_LABELS OUT --fraction 0.5 --seed 1
    # turbid test set: every image, different seed
    python scripts/turbid_augment.py C:/.../yolo/images/val C:/.../yolo/labels/val data/turbid_val --seed 99

OUT gets images/<split>/ and labels/<split>/ (split = --split, default "val").
"""
import argparse
import random
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

# veil colours in BGR (0-1) and per-channel attenuation exponents (larger = fades faster)
WATER = {
    "green":        ((0.30, 0.55, 0.25), (0.6, 0.8, 1.6)),
    "brown":        ((0.18, 0.38, 0.45), (1.5, 0.9, 0.7)),
    "yellow_green": ((0.20, 0.55, 0.45), (1.3, 0.8, 1.0)),
    "teal":         ((0.50, 0.50, 0.20), (0.7, 0.8, 1.8)),
}


def smooth_noise(h, w, rng, scale):
    """Low-frequency random field in [0, 1]."""
    small = rng.random((max(2, h // scale), max(2, w // scale))).astype(np.float32)
    field = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    field = cv2.GaussianBlur(field, (0, 0), sigmaX=max(h, w) / 12)
    return (field - field.min()) / (np.ptp(field) + 1e-6)


def turbid(img, rng):
    h, w = img.shape[:2]
    x = img.astype(np.float32) / 255.0
    veil, k = WATER[rng.choice(list(WATER))]
    veil = np.array(veil, np.float32) * rng.uniform(0.6, 1.1)

    # "distance" map: farther towards the top of the frame, plus smooth patchiness
    grad = np.linspace(1.0, 0.3, h, dtype=np.float32)[:, None] * np.ones((1, w), np.float32)
    dist = 0.6 * grad + 0.4 * smooth_noise(h, w, rng, 32)
    t0 = rng.uniform(0.25, 0.75)                        # overall clarity: lower = murkier
    base_t = np.clip(t0 ** (0.5 + dist), 0.05, 1.0)     # 0..1 transmission
    t = np.stack([base_t ** kc for kc in k], axis=-1)
    x = x * t + veil * (1.0 - t)

    x *= rng.uniform(0.55, 1.0)                         # less light at depth / overcast
    if rng.random() < 0.8:
        x = cv2.GaussianBlur(x, (0, 0), sigmaX=rng.uniform(0.4, 2.2))

    # suspended particles: small soft bright specks, denser when murkier
    n = int(rng.uniform(0, 600) * (1.0 - t0))
    if n:
        snow = np.zeros((h, w), np.float32)
        ys, xs = rng.integers(0, h, n), rng.integers(0, w, n)
        snow[ys, xs] = rng.uniform(0.3, 1.0, n)
        snow = cv2.GaussianBlur(snow, (0, 0), sigmaX=rng.uniform(0.6, 1.5))
        snow /= snow.max() + 1e-6
        x = x + snow[..., None] * rng.uniform(0.15, 0.45) * (veil + 0.4)

    x += rng.normal(0, rng.uniform(0.0, 0.03), x.shape).astype(np.float32)
    return (np.clip(x, 0, 1) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description="Turbid-water copy of a YOLO-seg image/label folder")
    ap.add_argument("images", help="source images folder")
    ap.add_argument("labels", help="source labels folder")
    ap.add_argument("out", help="output dataset root")
    ap.add_argument("--split", default="val", help="sub-folder name under OUT/images and OUT/labels")
    ap.add_argument("--fraction", type=float, default=1.0, help="share of images to convert")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--prefix", default="turbid_", help="prepended to file names (keeps them distinct)")
    args = ap.parse_args()

    src_i, src_l, out = Path(args.images), Path(args.labels), Path(args.out)
    imgs = sorted(p for p in src_i.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    random.Random(args.seed).shuffle(imgs)
    imgs = sorted(imgs[: round(len(imgs) * args.fraction)])
    (out / "images" / args.split).mkdir(parents=True, exist_ok=True)
    (out / "labels" / args.split).mkdir(parents=True, exist_ok=True)

    def one(i_p):
        i, p = i_p
        rng = np.random.default_rng([args.seed, i])
        img = cv2.imread(str(p))
        if img is None:
            return
        name = args.prefix + p.name
        cv2.imwrite(str(out / "images" / args.split / (Path(name).stem + ".jpg")), turbid(img, rng),
                    [cv2.IMWRITE_JPEG_QUALITY, 92])
        lbl = src_l / f"{p.stem}.txt"
        dst = out / "labels" / args.split / f"{Path(name).stem}.txt"
        if lbl.exists():
            shutil.copy2(lbl, dst)
        else:
            dst.write_text("")

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(one, enumerate(imgs)))
    print(f"{len(imgs)} turbid images -> {out / 'images' / args.split}")


if __name__ == "__main__":
    main()
