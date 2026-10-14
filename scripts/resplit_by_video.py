"""
Re-split a TrashCan YOLO dataset so that every video is entirely in train or entirely in val.

TrashCan's official split divides *frames*: 113 of its 115 val videos also appear in train,
so val frames are near-duplicates of training frames and val mAP is optimistic. This script
pools both splits, groups images by video id (the `vid_000052` prefix of the file name),
and searches random video assignments for one whose val share is close to the target and
whose per-class instance shares are balanced, with every class present in val.

Images and labels are hard-linked (copied if linking fails), so the source is untouched.

    python scripts/resplit_by_video.py C:/path/to/yolo data/yolo_vsplit
    python scripts/resplit_by_video.py SRC OUT --val-frac 0.16 --min-class-share 0.10 --seed 0
"""
import argparse
import json
import os
import random
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import yaml

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def video_id(stem):
    parts = stem.split("_")
    return "_".join(parts[:2]) if len(parts) >= 2 and parts[0] == "vid" else stem


def collect(src):
    """{video: [(image_path, label_path, Counter(class -> instances))]} over train + val."""
    videos = defaultdict(list)
    for split in ("train", "val"):
        for img in sorted((src / "images" / split).iterdir()):
            if img.suffix.lower() not in IMG_EXT:
                continue
            lbl = src / "labels" / split / f"{img.stem}.txt"
            counts = Counter()
            if lbl.exists():
                for line in lbl.read_text().splitlines():
                    if line.strip():
                        counts[int(line.split()[0])] += 1
            videos[video_id(img.stem)].append((img, lbl if lbl.exists() else None, counts))
    return videos


def score(val_videos, stats, totals, n_images, val_frac, min_share):
    """Lower is better: image-share error plus mean and worst per-class share error.

    None when any class has less than `min_share` of its instances in val.
    """
    imgs = sum(stats[v][0] for v in val_videos)
    cls = Counter()
    for v in val_videos:
        cls.update(stats[v][1])
    shares = {c: cls[c] / totals[c] for c in totals}
    if any(s < min_share for s in shares.values()):
        return None
    dev = [abs(s - val_frac) for s in shares.values()]
    return abs(imgs / n_images - val_frac) * 4 + sum(dev) / len(dev) + max(dev)


def search(videos, val_frac, trials, seed, min_share):
    stats = {v: (len(items), sum((it[2] for it in items), Counter())) for v, items in videos.items()}
    totals = sum((s[1] for s in stats.values()), Counter())
    n_images = sum(s[0] for s in stats.values())
    names = sorted(videos)
    rng = random.Random(seed)
    best, best_err = None, float("inf")
    for _ in range(trials):
        rng.shuffle(names)
        chosen, imgs = [], 0
        for v in names:
            if imgs >= val_frac * n_images:
                break
            chosen.append(v)
            imgs += stats[v][0]
        err = score(chosen, stats, totals, n_images, val_frac, min_share)
        if err is not None and err < best_err:
            best, best_err = set(chosen), err
    if best is None:
        raise SystemExit("no assignment met --min-class-share; raise --trials or lower it")
    return best, best_err, stats, totals


def place(src_file, dst_file):
    dst_file.parent.mkdir(parents=True, exist_ok=True)
    if dst_file.exists():
        dst_file.unlink()
    try:
        os.link(src_file, dst_file)
    except OSError:
        shutil.copy2(src_file, dst_file)


def main():
    ap = argparse.ArgumentParser(description="Video-disjoint re-split of a TrashCan YOLO dataset")
    ap.add_argument("src", help="YOLO dataset with images/{train,val} and labels/{train,val}")
    ap.add_argument("out", help="output dataset directory")
    ap.add_argument("--val-frac", type=float, default=0.16, help="target share of images in val")
    ap.add_argument("--min-class-share", type=float, default=0.10,
                    help="every class must have at least this share of its instances in val")
    ap.add_argument("--trials", type=int, default=200000)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    src, out = Path(args.src).resolve(), Path(args.out).resolve()
    src_yaml = yaml.safe_load((src / "data.yaml").read_text(encoding="utf-8"))
    names = src_yaml["names"]
    videos = collect(src)
    val_videos, err, stats, totals = search(videos, args.val_frac, args.trials, args.seed, args.min_class_share)

    if out.exists():
        shutil.rmtree(out)
    for v, items in videos.items():
        split = "val" if v in val_videos else "train"
        for img, lbl, _ in items:
            place(img, out / "images" / split / img.name)
            dst_lbl = out / "labels" / split / f"{img.stem}.txt"
            if lbl:
                place(lbl, dst_lbl)
            else:
                dst_lbl.parent.mkdir(parents=True, exist_ok=True)
                dst_lbl.write_text("")

    (out / "data.yaml").write_text(
        "# TrashCan 1.0 (instance version), re-split by video: no video is in both train and val.\n"
        f"# Made by scripts/resplit_by_video.py (val-frac {args.val_frac}, seed {args.seed}).\n"
        f"path: {out.as_posix()}\ntrain: images/train\nval: images/val\n\n"
        f"nc: {len(names)}\nnames:\n" + "".join(f"  {i}: {names[i]}\n" for i in sorted(names)),
        encoding="utf-8")

    val_cls = sum((stats[v][1] for v in val_videos), Counter())
    n_val = sum(stats[v][0] for v in val_videos)
    n_all = sum(s[0] for s in stats.values())
    report = {
        "source": str(src), "seed": args.seed, "val_frac_target": args.val_frac, "score": round(err, 4),
        "videos": {"train": len(videos) - len(val_videos), "val": len(val_videos)},
        "images": {"train": n_all - n_val, "val": n_val},
        "val_videos": sorted(val_videos),
        "per_class": {names[c]: {"total": totals[c], "val": val_cls[c],
                                 "val_share": round(val_cls[c] / totals[c], 3)} for c in sorted(totals)},
    }
    (out / "split.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"videos train/val: {report['videos']['train']}/{report['videos']['val']}  "
          f"images train/val: {report['images']['train']}/{n_val} ({n_val / n_all:.1%} val)")
    for name, pc in report["per_class"].items():
        print(f"  {name:24s} {pc['val']:4d} / {pc['total']:5d}  ({pc['val_share']:.0%})")


if __name__ == "__main__":
    main()
