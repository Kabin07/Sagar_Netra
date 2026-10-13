"""Figures for the project review PDF (written to docs/review/assets/)."""
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = HERE / "assets"
ASSETS.mkdir(exist_ok=True)

INK, MUT, LINE = "#000000", "#444444", "#cccccc"
# Monochrome: black / greys only
TEAL, CORAL, AMBER, GREEN, VIOLET, SLATE = "#111111", "#111111", "#555555", "#888888", "#555555", "#bbbbbb"
plt.rcParams.update({"font.family": "Arial", "font.size": 9, "axes.edgecolor": LINE, "axes.labelcolor": INK,
                     "xtick.color": MUT, "ytick.color": MUT, "axes.titleweight": "bold", "axes.titlesize": 10})

# ── 1. training curve (fine-tune run) ─────────────────────────────────────
rows = list(csv.DictReader(open(ROOT / "runs/sagarnetra_5k_finetune-3/results.csv")))
ep = [int(r["epoch"]) for r in rows]
fig, ax = plt.subplots(figsize=(6.6, 2.5), dpi=200)
ax.plot(ep, [float(r["metrics/mAP50(B)"]) for r in rows], color=TEAL, lw=1.8, label="Box mAP50")
ax.plot(ep, [float(r["metrics/mAP50(M)"]) for r in rows], color=VIOLET, lw=1.8, label="Mask mAP50")
ax.plot(ep, [float(r["metrics/mAP50-95(B)"]) for r in rows], color=TEAL, lw=1.2, ls="--", label="Box mAP50-95")
ax.plot(ep, [float(r["metrics/mAP50-95(M)"]) for r in rows], color=VIOLET, lw=1.2, ls="--", label="Mask mAP50-95")
ax.set_xlabel("Fine-tuning epoch"); ax.set_ylabel("Validation score"); ax.set_ylim(0.2, 0.65)
ax.grid(alpha=.35, color=LINE); ax.spines[["top", "right"]].set_visible(False)
ax.legend(ncol=4, fontsize=7.5, frameon=False, loc="lower center", bbox_to_anchor=(0.5, 1.0))
fig.tight_layout(); fig.savefig(ASSETS / "training_curve.png"); plt.close(fig)

# ── 2. per-class mask mAP50 from the fresh evaluation ─────────────────────
m = json.loads((HERE / "eval/metrics.json").read_text())
pcs = sorted(m["per_class"], key=lambda c: c["mask_map50"])
col = lambda n: TEAL if n.startswith("trash_") else (SLATE if n == "rov" else GREEN)
fig, ax = plt.subplots(figsize=(6.6, 4.3), dpi=200)
y = range(len(pcs))
ax.barh(y, [c["mask_map50"] for c in pcs], color=[col(c["class_name"]) for c in pcs], height=.68)
ax.set_yticks(list(y)); ax.set_yticklabels([f'{c["class_name"]}  (n={c["val_instances"]})' for c in pcs], fontsize=7.4)
for i, c in enumerate(pcs):
    ax.text(c["mask_map50"] + .01, i, f'{c["mask_map50"]:.2f}', va="center", fontsize=6.8, color=INK)
ax.axvline(m["mask"]["map50"], color=CORAL, lw=1, ls="--")
ax.text(m["mask"]["map50"] + .01, len(pcs) - .4, f'overall {m["mask"]["map50"]:.3f}', color=CORAL, fontsize=7.2)
ax.set_xlim(0, 1.08); ax.set_xlabel("Mask mAP50 on 1,147 held-out validation images")
ax.spines[["top", "right"]].set_visible(False); ax.grid(axis="x", alpha=.35, color=LINE)
from matplotlib.patches import Patch
ax.legend(handles=[Patch(color=TEAL, label="debris (trash_*)"), Patch(color=GREEN, label="marine life / plant"), Patch(color=SLATE, label="ROV")],
          frameon=False, fontsize=7.4, loc="lower right")
fig.tight_layout(); fig.savefig(ASSETS / "per_class_map.png"); plt.close(fig)

# ── 3. system architecture ────────────────────────────────────────────────
fig, ax = plt.subplots(figsize=(7.2, 3.0), dpi=200)
ax.set_xlim(0, 112); ax.set_ylim(0, 44); ax.axis("off")

def box(x, y, w, h, title, lines, color):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4,rounding_size=1.6", fc="white", ec=color, lw=1.4))
    ax.add_patch(FancyBboxPatch((x, y + h - 5.2), w, 5.2, boxstyle="round,pad=0.4,rounding_size=1.6", fc=color, ec=color, lw=1.4))
    ax.text(x + w / 2, y + h - 2.6, title, ha="center", va="center", color="white", fontsize=7.4, fontweight="bold")
    for i, t in enumerate(lines):
        ax.text(x + 1.4, y + h - 8.4 - i * 3.3, t, ha="left", va="center", color=INK, fontsize=5.9)

def arrow(x1, y1, x2, y2, label="", dy=1.4):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1), arrowprops=dict(arrowstyle="-|>", color=MUT, lw=1.1))
    if label:
        ax.text((x1 + x2) / 2, (y1 + y2) / 2 + dy, label, ha="center", va="bottom" if dy > 0 else "top", fontsize=5.4, color=MUT, linespacing=1.1)

box(0.5, 6, 25, 34, "Web frontends", ["Login + portal chooser", "Citizen app (PWA)", "Dive & survey reporting", "Authority console (admin)",
                                   "Leaflet + OpenStreetMap", "GPS / map / manual coords", "Upload progress"], TEAL)
box(41, 6, 29, 34, "Node.js / Express API", ["Auth: bcrypt + JWT session", "httpOnly SameSite cookie", "Role-based access control",
                                             "Upload validation (magic bytes)", "Report + detection service", "Private image storage",
                                             "Rate limits, CSP, Helmet"], VIOLET)
box(86, 24, 25.5, 16, "Python inference", ["YOLOv8n-seg best.pt", "loaded once, 22 classes", "127.0.0.1, token-auth"], CORAL)
box(86, 2, 25.5, 18, "PostgreSQL / Supabase", ["ER tables + migrations", "RLS, API roles revoked", "monitoring.* views"], GREEN)
arrow(27, 26, 39.5, 26, "images +\nmetadata")
arrow(39.5, 20, 27, 20, "report +\ndetections", dy=-1.4)
arrow(71.5, 34, 84.5, 34, "image bytes")
arrow(84.5, 29, 71.5, 29, "class, conf,\nbbox, mask", dy=-1.4)
arrow(71.5, 11, 84.5, 11, "SQL over TLS")
fig.savefig(ASSETS / "architecture.png", bbox_inches="tight", pad_inches=0.05); plt.close(fig)
print("figures written to", ASSETS)
