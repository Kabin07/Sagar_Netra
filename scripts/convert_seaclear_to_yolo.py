"""
Convert the SeaClear Marine Debris dataset (COCO JSON, 40 classes) -> YOLOv8-seg with the
22 SAGAR-NETRA / TrashCan classes, so it can be added to TrashCan training data.

SeaClear: Đuraš et al., "A dataset for detection and segmentation of underwater marine debris
in shallow waters", Scientific Data 11:921 (2024). CC BY 4.0, data.4tu.nl DOI
10.4121/4f1dff25-e157-4399-a5d4-478055461689. Images sit in <site>/<camera>/ folders; file
names are unique across the archive.

Mapping choices (see CLASS_MAP): debris without a TrashCan counterpart (tires, bricks, boots,
...) becomes trash_unknown_instance so the app still flags it as debris; the ROV tether
(rov_cable) is labelled rov so the model learns it is not rope; urchins and sponges join
animal_etc.

Sites listed in --holdout go to images/test_sites (a never-seen-location test); the rest go
to images/train. Polygons are handled exactly as in convert_trashcan_to_yolo.py.

    python scripts/convert_seaclear_to_yolo.py data/seaclear/extract data/seaclear_yolo
"""
import argparse
import json
import os
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_trashcan_to_yolo import extract_polygons, poly_area  # noqa: E402

NAMES = json.loads((Path(__file__).resolve().parent.parent / "inference" / "classes.json").read_text())
NAMES = NAMES if isinstance(NAMES, list) else [NAMES[str(i)] for i in range(len(NAMES))]

CLASS_MAP = {
    "net_plastic": "trash_net",
    "rope_fiber": "trash_rope", "rope_plastic": "trash_rope",
    "bottle_plastic": "trash_bottle", "bottle_glass": "trash_bottle",
    "can_metal": "trash_can",
    "cup_plastic": "trash_cup", "cup_ceramic": "trash_cup",
    "bag_plastic": "trash_bag",
    "clothing_fiber": "trash_clothing",
    "snack_wrapper_plastic": "trash_snack_wrapper", "snack_wrapper_paper": "trash_snack_wrapper",
    "container_plastic": "trash_container", "container_middle_size_metal": "trash_container",
    "jar_glass": "trash_container",
    "pipe_plastic": "trash_pipe", "tube_cement": "trash_pipe",
    "tarp_plastic": "trash_tarp",
    "wreckage_metal": "trash_wreckage",
    "branch_wood": "trash_branch",
    "unknown_instance": "trash_unknown_instance",
    "tire_rubber": "trash_unknown_instance", "brick_clay": "trash_unknown_instance",
    "boot_rubber": "trash_unknown_instance", "sanitaries_plastic": "trash_unknown_instance",
    "furniture_wood": "trash_unknown_instance", "cardboard_paper": "trash_unknown_instance",
    "lid_plastic": "trash_unknown_instance", "cable_metal": "trash_unknown_instance",
    "rov_tortuga": "rov", "rov_bluerov": "rov", "rov_vehicle_leg": "rov", "rov_cable": "rov",
    "plant": "plant",
    "animal_fish": "animal_fish",
    "animal_starfish": "animal_starfish",
    "animal_shells": "animal_shells",
    "animal_etc": "animal_etc", "animal_urchin": "animal_etc", "animal_sponge": "animal_etc",
}


def place(src, dst):
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser(description="SeaClear COCO -> YOLOv8-seg with SAGAR-NETRA classes")
    ap.add_argument("src", help="extracted SeaClear folder (contains dataset.json and <site>/ folders)")
    ap.add_argument("out", help="output YOLO dataset directory")
    ap.add_argument("--holdout", nargs="*", default=["Jakljan", "Slano"],
                    help="sites kept out of training, written to images/test_sites")
    args = ap.parse_args()

    src, out = Path(args.src).resolve(), Path(args.out).resolve()
    coco = json.loads((src / "dataset.json").read_text(encoding="utf-8"))
    cat2idx = {}
    for c in coco["categories"]:
        if c["name"] not in CLASS_MAP:
            raise SystemExit(f"unmapped SeaClear class: {c['name']}")
        cat2idx[c["id"]] = NAMES.index(CLASS_MAP[c["name"]])

    where = {p.name: p for p in src.rglob("*.jpg")}
    anns = defaultdict(list)
    for a in coco["annotations"]:
        anns[a["image_id"]].append(a)

    if out.exists():
        shutil.rmtree(out)
    counts = {"train": Counter(), "test_sites": Counter()}
    n_img = Counter()
    missing = skipped = 0
    for im in coco["images"]:
        path = where.get(Path(im["file_name"]).name)
        if path is None:
            missing += 1
            continue
        site = path.relative_to(src).parts[0]
        split = "test_sites" if site in args.holdout else "train"
        h, w = im["height"], im["width"]
        lines = []
        for a in anns.get(im["id"], []):
            if a.get("iscrowd", 0):
                continue
            polys = extract_polygons(a, h, w)
            if not polys:
                skipped += 1
                continue
            poly = max(polys, key=poly_area)
            coords = []
            for i in range(0, len(poly) - 1, 2):
                coords += [f"{min(max(poly[i] / w, 0.0), 1.0):.6f}", f"{min(max(poly[i + 1] / h, 0.0), 1.0):.6f}"]
            if len(coords) >= 6:
                cls = cat2idx[a["category_id"]]
                lines.append(f"{cls} " + " ".join(coords))
                counts[split][cls] += 1
        # prefix keeps names distinct from TrashCan's vid_* files when both are trained together
        name = f"seaclear_{site}_{path.name}".replace(" ", "_")
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        place(path, out / "images" / split / name)
        (out / "labels" / split / f"{Path(name).stem}.txt").write_text("\n".join(lines), encoding="utf-8")
        n_img[split] += 1

    names_yaml = "".join(f"  {i}: {n}\n" for i, n in enumerate(NAMES))
    (out / "test_sites.yaml").write_text(
        f"# SeaClear held-out sites {args.holdout}: never-seen-location test\n"
        f"path: {out.as_posix()}\ntrain: images/test_sites\nval: images/test_sites\n\n"
        f"nc: {len(NAMES)}\nnames:\n{names_yaml}", encoding="utf-8")
    print(f"images train {n_img['train']}  test_sites {n_img['test_sites']}  "
          f"missing {missing}  unusable segmentations {skipped}")
    for i, n in enumerate(NAMES):
        print(f"  {n:24s} train {counts['train'][i]:5d}  test_sites {counts['test_sites'][i]:5d}")


if __name__ == "__main__":
    main()
