# SAGAR-NETRA — Marine Debris Detection & Reporting

YOLOv8n-seg instance segmentation for ghost-net / debris detection in coastal waters,
with a full reporting system: accounts, report submission with GPS or manual
coordinates, real model inference, PostgreSQL persistence and map views.

```
 Browser (static pages, no build step)        Node.js / Express  (backend/)          Python  (inference/)
 ┌──────────────────────────────┐   cookie    ┌──────────────────────────────┐ token ┌───────────────────────┐
 │ /professional/  dive reports │ ──session─▶ │ /api  auth · reports · RBAC  │ ────▶ │ service.py            │
 │ /citizen/       phone PWA    │             │ uploads → private storage    │ HTTP  │ best.pt loaded once   │
 │ /authority/     admin console│ ◀──JSON──── │ detections → PostgreSQL      │ ◀──── │ YOLOv8n-seg, 22 cls   │
 └──────────────────────────────┘             └──────────────┬───────────────┘       └───────────────────────┘
                                                             ▼                        127.0.0.1 only
                                                   PostgreSQL (UTF-8)
```

| Part | Where | Notes |
|---|---|---|
| Frontends | `frontend/` | The existing static HTML apps (no React/Vite in this repo). Served by the backend on the same origin; shared API client in `frontend/shared/sn-client.js`. |
| API | `backend/` | Express 5, `pg`, bcrypt, JWT bound to a revocable DB session in an httpOnly `SameSite=Strict` cookie (Bearer header also accepted). |
| Database | `backend/db/migrations/` | Versioned SQL; applied automatically on start or with `npm run db:migrate`. |
| Inference | `inference/service.py` | Standard-library HTTP server around Ultralytics; no extra Python packages beyond `inference/requirements.txt`. |
| Model | `runs/sagarnetra_seaclear_v3/weights/best.pt` | 22 classes, imgsz 640, trained on TrashCan + SeaClear (see *Results — TrashCan + SeaClear*). Earlier checkpoints `runs/sagarnetra_gpu_v2/weights/best.pt` and `runs/sagarnetra_5k_finetune-3/weights/best.pt` are kept for rollback via `SN_MODEL_PATH`. |

---

## Quick start (Windows PowerShell)

Requirements: **Node.js 20+**, **Python 3.10+** with `ultralytics`, `opencv-python`, `numpy`, `torch`
(already present in this machine's Python 3.12), and **PostgreSQL** — either a normal install
or the bundled embedded server (`npm run db:local`, no admin rights needed).

```powershell
cd E:\sagar-netra-main
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1     # npm install + creates .env files (never overwrites)
```

**Database — pick one:**

```powershell
# A) embedded PostgreSQL 17 (data in backend\.pgdata). Keep this window open:
cd backend; npm run db:local
#    copy the printed DATABASE_URL=... line into backend\.env

# B) system PostgreSQL (https://www.postgresql.org/download/windows/ or: winget install PostgreSQL.PostgreSQL.17)
#    the database MUST be UTF-8 (Tamil/Hindi/Malayalam text); Windows installers often default to WIN1252:
psql -U postgres -c "CREATE DATABASE sagar_netra ENCODING 'UTF8' TEMPLATE template0;"
#    then in backend\.env:  DATABASE_URL=postgresql://postgres:<password>@localhost:5432/sagar_netra
```

**Start the services** (each in its own window — or `scripts\windows\start-all.ps1` opens all three):

```powershell
python inference\service.py                 # 1. model service  → 127.0.0.1:8001 (reads inference\.env)
cd backend; npm run db:migrate              # 2. schema + seed (optional: npm start also migrates)
cd backend; npm start                       # 3. API + frontends → http://127.0.0.1:4000
```

Open <http://127.0.0.1:4000/> — the first page asks which portal you want (Citizen, Dive & survey, Coastal authority), then shows sign-in / create-account for it (with a Back button; the browser Back button works too). Admin accounts cannot be created there. Every page (reporting, citizen app, operations
console) is locked until you are signed in and sends you to `/login/` otherwise; after signing in you return to the
page you asked for (admins land on the operations console). Pages must be opened **through the server** — opening
the HTML files from disk shows only a "sign-in required" notice.
To test from a phone on the same Wi-Fi set `HOST=0.0.0.0` in `backend\.env` (browser GPS on phones
requires HTTPS; manual coordinates always work).

### Hosting the database on Supabase (monitor everything in the Supabase dashboard)

The backend works with any PostgreSQL, including Supabase. Nothing in the browser talks to Supabase directly —
the publishable (`sb_publishable_…`) key is **not needed** and must not be put in the frontend: all reads and writes
go through the authenticated Node API, which connects to Supabase's Postgres as the table owner.

1. **Get the connection string.** Supabase Dashboard → **Connect** → *Session pooler* (port **5432**). It looks like
   `postgresql://postgres.ptwanumkmraoqnsqrmdu:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
   (copy the exact host from the dashboard — it may be `aws-0-…` or `aws-1-…`).
   Do **not** use `db.ptwanumkmraoqnsqrmdu.supabase.co`: it is IPv6-only and unreachable from IPv4-only networks
   (verified from this machine). Do not use port 6543 (transaction pooler).
2. **Download the CA certificate**: Project Settings → Database → *SSL Configuration* → Download certificate →
   save as `backend\certs\supabase-ca.crt`.
3. **Edit `backend\.env`** (your password goes only here; URL-encode `@ # / :` in it):
   ```
   DATABASE_URL=postgresql://postgres.ptwanumkmraoqnsqrmdu:<db-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   PGSSL=true
   PGSSL_CA=./certs/supabase-ca.crt
   PG_POOL_MAX=10
   ```
4. **Create the schema and verify connectivity:**
   ```powershell
   cd backend
   npm run db:check -- --migrate     # TLS, encoding, migrations, ER tables, class seed, RLS, API-role lockout
   npm start
   ```
   The Supabase CLI (`supabase login / init / link`) is optional; migrations are applied by the backend itself, so
   there is a single source of truth in `backend/db/migrations/`.
5. **Monitor** in the Supabase dashboard:
   - *Table Editor*, schema **public**: the ER tables `user_types`, `users`, `reports`, `debris_types`, `debris`
     (+ `report_images`, `user_sessions`).
   - *Table Editor*, schema **monitoring** (read-only views, no password hashes): `system_summary`,
     `users_overview` (role, report count, last login), `reports_overview`, `debris_overview`,
     `debris_type_counts`, `inference_failures`.
   - *SQL Editor*, e.g. `select * from monitoring.system_summary;`

**Security on Supabase.** Supabase publishes every `public` table through its REST/GraphQL API to the `anon` and
`authenticated` roles (the publishable key). Migration `004` enables Row Level Security on all tables and revokes
every privilege from those roles (also for future tables), and the `monitoring` schema is not API-exposed — so the
publishable key cannot read users, password hashes or reports. `npm run db:check` verifies this, and
`backend/test/hosted.test.js` reproduces Supabase's role setup to test it. Uploaded images stay in `UPLOAD_DIR` on the
backend machine (only references are in the database).

### Administrators

Registration can never grant `admin` (requests asking for it get HTTP 403). New accounts are `diver`
by default; `researcher` and `citizen` may also be self-selected. Create or promote an admin with
direct database access:

```powershell
cd backend
$env:SN_ADMIN_PASSWORD = "<a strong password>"; npm run admin:create -- --email admin@example.org --name "Coastal Admin"; Remove-Item Env:SN_ADMIN_PASSWORD
npm run admin:create -- --email someone@example.org --promote      # promote an existing account
```

(Without `SN_ADMIN_PASSWORD` the script prompts for the password with hidden input.)

**Changing a password.** Signed in: open `/login/` → *Change password* (asks for the current password; your other
sessions are signed out). Forgotten password, with access to `backend\.env`:

```powershell
cd backend; npm run user:set-password -- --email admin@sagarnetra.test     # prompts twice, input hidden
```

Demo accounts: `npm run seed:demo` creates one account per role (passwords in the git-ignored
`backend\demo-accounts.local.txt`). Admins can then
change other users' roles with `PATCH /api/users/:id/role`.

---

## Configuration

All deployment-specific values come from environment files that are **git-ignored**:

| File | Key settings |
|---|---|
| `backend/.env` (from `.env.example`) | `DATABASE_URL`, `PGSSL`, `PGSSL_CA`, `JWT_SECRET` (32+ chars), `INFERENCE_URL`, `INFERENCE_TOKEN`, `INFERENCE_CONF` (0.25), `INFERENCE_IMGSZ` (empty = 512 from checkpoint), `UPLOAD_DIR`, `MAX_UPLOAD_MB` (15), `MAX_FILES_PER_REPORT` (10), `HOST`/`PORT`, `COOKIE_SECURE`, `CLIENT_ORIGINS`, rate limits |
| `inference/.env` (from `.env.example`) | `SN_INFERENCE_TOKEN` (= `INFERENCE_TOKEN`), `SN_MODEL_PATH`, `SN_INFERENCE_HOST` (keep `127.0.0.1`), `SN_INFERENCE_PORT`, `SN_DEVICE`, `SN_MAX_SIDE` |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

---

## Database

`001_er_core.sql` implements the ER diagram (`user_types` 1─N `users` 1─N `reports` 1─N `debris` N─1 `debris_types`).
`002_reporting_extensions.sql` adds what the frontends and the model need, rather than discarding data:

| Addition | Why |
|---|---|
| `report_images` (1 report → N images) | the professional form's *one incident, many photos* mode; each detection references the image it came from |
| `reports.site_name, observed_at, position_accuracy_m, location_source, source_channel` | fields collected by the forms; `location_source` records whether coordinates are a browser (surface) fix, map pick, manual entry, EXIF or a dive/ROV sensor — a browser fix is never presented as the underwater position |
| `reports.details` (JSONB, whitelisted keys) | long-tail survey fields: bottom time, declared type, extent, state, retrieval, hazards, operator, organisation, vessel, transect, sea state, current, language |
| `reports.review_status, inference_status, severity` | authority triage workflow; honest model status (`completed / partial / failed`) |
| `debris_types.class_index, category` | pins every name to the model index; `trash / animal / plant / rov` so non-debris classes are kept and labelled, never assumed to be trash |
| `debris.image_id, mask_key, mask_area_px, mask_area_frac` | mask files + statistics |
| `user_sessions` | logout really revokes a token |

`003_seed_reference_data.sql` seeds user types and the 22 classes (`ON CONFLICT`, idempotent). Applied
migrations are tracked in `schema_migrations` with checksums; editing an applied migration is refused.
Coordinates, depth, temperature, visibility and confidence have CHECK constraints in addition to API validation.

### Detection storage format

- **bbox** (`debris.bbox`, JSONB): `{"format":"xyxy","units":"px","x1","y1","x2","y2","image_width","image_height","normalized":[x1,y1,x2,y2]}` —
  pixel corners in the **original uploaded image**, origin top-left; `normalized` divides by width/height (0–1).
- **mask**: single-channel PNG (255 = object) stored in the image storage, served at `debris.mask_url` = `/api/debris/:id/mask`.
  It is at the analysed resolution (images with a side > 1920 px are downscaled before inference); `mask_area_frac` is resolution-independent.
  Mask coverage is a fraction of the frame — **not** a calibrated area in m².
- **annotated overlay**: the model's own rendering, `/api/images/:id/annotated`.
- **confidence**: exactly the model's score; never edited by reviews.

## How a report flows

1. Authenticated `POST /api/reports` (multipart). Files are checked by **magic bytes** (JPEG/PNG/WebP), extension and
   declared MIME must agree, size/count limits apply; metadata is validated (lat −90…90, lng −180…180, etc.).
2. Images are written to private storage under random server-generated keys; report + image rows are committed.
3. Each image is sent to the inference service (token-authenticated, loopback only). Its output is validated strictly —
   unknown class indices, a class name that differs from `debris_types` for that index, out-of-range confidences or boxes
   fail the image (no silent remapping).
4. Masks/overlays are stored and detections inserted **in one transaction per image**.
5. If inference fails (service down, timeout, undecodable image, bad output) the report is still saved, the image is
   marked `failed` with the reason, **no detections are recorded**, and the UI says so and offers *Retry analysis*
   (`POST /api/reports/:id/reprocess`). Images left `processing` by a crash are marked failed on the next start.

## API

All private routes need the session cookie or `Authorization: Bearer <token>`. Ordinary users only ever see their own
reports (others' ids return 404); admins see all.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/health` | public | DB + inference status |
| `POST /api/auth/register` | public, rate-limited | `{name,email,password,role?}` role ∈ diver/researcher/citizen |
| `POST /api/auth/login` | public, rate-limited | `{email,password}` → cookie + `{user, token}` |
| `POST /api/auth/logout` | user | revokes the session |
| `POST /api/users/me/password` | user, rate-limited | `{current_password,new_password}`; signs out other sessions |
| `GET /api/users/me` | user | current user (never includes the hash) |
| `PATCH /api/users/:id/role` | admin | `{role}` |
| `GET /api/user-types`, `GET /api/debris-types` | public | reference data |
| `POST /api/reports` | user | multipart: `images` (1–10), `latitude`, `longitude`, optional `site_name`, `observed_at` (ISO), `depth`, `water_temp`, `visibility`, `position_accuracy_m`, `location_source`, `source_channel`, `comments`, `details` (JSON) |
| `GET /api/reports?page=&limit=&review_status=&mine=` | user | paginated history (limit ≤ 100) |
| `GET /api/reports/markers?limit=` | user | lightweight DB coordinates for maps |
| `GET /api/reports/:id` | owner/admin | report + images + detections |
| `GET /api/reports/:id/detections` | owner/admin | detections |
| `PATCH /api/reports/:id` | owner/admin | metadata; `review_status` admin only |
| `DELETE /api/reports/:id` | owner/admin | deletes rows and stored files |
| `POST /api/reports/:id/reprocess` | owner/admin | retry failed analyses |
| `PATCH /api/debris/:id` | owner/admin | `{status: detected/confirmed/false_positive/removed, comment}` |
| `GET /api/images/:id`, `/api/images/:id/annotated`, `/api/debris/:id/mask` | owner/admin | stored files |

### Example requests (Windows PowerShell 5.1 — verified)

```powershell
cd E:\sagar-netra-main
$api = "http://127.0.0.1:4000/api"
Invoke-RestMethod "$api/health"
$reg = Invoke-RestMethod -Method Post "$api/auth/register" -ContentType "application/json" `
  -Body (@{ name = "Test Diver"; email = "diver@example.org"; password = "a long password" } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($reg.token)" }      # or use /auth/login to get a token later
# multipart upload (Windows PowerShell 5.1 has no -Form, so use curl.exe)
$r = curl.exe -s -H "Authorization: Bearer $($reg.token)" -F "images=@demo_inputs_net\vid_000052_frame0000082.jpg" `
  -F latitude=14.0175 -F longitude=74.3289 -F location_source=sensor -F depth=18.5 -F "site_name=Netrani Island" "$api/reports" | ConvertFrom-Json
$r.inference; $r.report.detections | Select-Object type_name, confidence, mask_area_frac
Invoke-RestMethod "$api/reports?limit=5" -Headers $h
Invoke-RestMethod "$api/reports/markers" -Headers $h
Invoke-WebRequest "$api/debris/$($r.report.detections[0].id)/mask" -Headers $h -OutFile mask.png -UseBasicParsing
Invoke-RestMethod -Method Patch "$api/debris/$($r.report.detections[0].id)" -Headers $h -ContentType "application/json" -Body '{"status":"confirmed"}'
Invoke-RestMethod -Method Post "$api/auth/logout" -Headers $h   # the token stops working immediately
```

## Tests

```powershell
cd backend; npm test                                   # 64 tests: unit, end-to-end (real PostgreSQL + real model), Supabase-style permissions
cd ..; python -m unittest inference/test_service.py -v # service output == direct ultralytics prediction
```

`npm test` starts a throw-away embedded PostgreSQL and spawns `inference/service.py` itself (set `PYTHON` to choose the
interpreter). To use your own server set `TEST_DATABASE_URL` (database name must contain `test`; its schema is wiped)
and optionally `TEST_INFERENCE_URL` / `TEST_INFERENCE_TOKEN`. The end-to-end tests need `demo_inputs_net/` (git-ignored
sample frames) and the trained checkpoint. They cover registration/login/hashing/logout, admin self-assignment refusal,
auth on every private route, cross-user isolation, coordinate and file-type validation, safe storage, persistence,
genuine model output (compared with a direct model call), class mapping, bbox/mask persistence, restart survival,
DB-backed markers, and failed/partial inference producing no fake results.

## Security notes

- Passwords: bcrypt cost 12; login responses identical for unknown email / wrong password.
- Sessions: 8 h JWT referencing a `user_sessions` row; httpOnly + SameSite=Strict cookie; set `COOKIE_SECURE=true`
  behind HTTPS. Cookie-authenticated state-changing requests from foreign `Origin`s are rejected.
- Rate limits on auth (20 / 15 min / IP), report submission and the API overall. Set `TRUST_PROXY` behind a proxy.
- Uploads are stored outside the web root and only served through authorised routes; client filenames are metadata only.
- Parameterised SQL everywhere; helmet CSP (`unsafe-inline` is required by the existing single-file pages).
- The inference service binds to 127.0.0.1 and requires the shared token. Do not expose port 8001.
- Not yet implemented: email verification / password reset, HTTPS termination (use a reverse proxy), object-storage
  driver (implement `put/get/getBuffer/delete` in `backend/src/services/storage/`), WhatsApp dispatch (the console only
  previews the payload).

## Repository layout (system parts)

```
backend/            Express API (src/), migrations (db/), CLI scripts (scripts/), tests (test/)
inference/          service.py, classes.json, requirements.txt, test_service.py
frontend/           login/ (sign-in page), professional/, citizen/, authority/ (API-backed), shared/sn-client.js
scripts/windows/    setup.ps1, start-db.ps1, start-inference.ps1, start-backend.ps1, start-all.ps1
legacy/             superseded FastAPI prototype and pre-integration copies of the pages
```

---

# Model: training results and caveats

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

## Results — TrashCan + SeaClear (`sagarnetra_seaclear_v3`, current model)

**Why another model.** TrashCan's official split shares videos between train and val (113 of 115
val videos), so its val scores measure *familiar scenes*. On a video-disjoint re-split
(`scripts/resplit_by_video.py`: 261/51 videos, every class ≥10% in val) a TrashCan-only YOLOv8n
reaches only **0.18 box / 0.17 mask mAP50**, and on SeaClear sites it never saw, **0.006 mask
mAP50**: models trained on TrashCan alone mostly recognise familiar footage. Adding SeaClear
(Đuraš et al., *Scientific Data* 11:921, 2024, CC BY 4.0; 8,610 shallow-water ROV images,
converted by `scripts/convert_seaclear_to_yolo.py`, adding 960 net and 2,036 rope instances)
kept the TrashCan score (0.19 / 0.17) and raised unseen-site mask mAP50 about tenfold.

`sagarnetra_seaclear_v3` = `sagarnetra_gpu_v2` fine-tuned on TrashCan official train + SeaClear
(sites Jakljan and Slano held out, 545 images), 60 epochs, imgsz 640, batch 16, AdamW lr0=0.001,
cosine LR, mosaic off for the last 10 epochs; best epoch 46, 2.9 h on an RTX 4050. The
dataset file is `docs/review/eval_v3/training/data.yaml` (copy it to `data/` and adjust the paths).

```
.venv\Scripts\python.exe scripts\train.py --data data\final_trashcan_seaclear.yaml ^
  --weights runs\sagarnetra_gpu_v2\weights\best.pt --epochs 60 --imgsz 640 --batch 16 --workers 4 ^
  --device 0 --patience 60 --cos-lr --close-mosaic 10 --optimizer AdamW --lr0 0.001 ^
  --warmup-epochs 1 --name sagarnetra_seaclear_v3
```

| | gpu_v2 | **seaclear_v3** |
|---|---|---|
| TrashCan official val, box / mask mAP50 | 0.701 / 0.682 | 0.683 / 0.665 |
| SeaClear unseen sites, debris image recall / F1 (conf 0.25) | 0.235 / 0.369 | **0.677 / 0.770** |
| SeaClear unseen sites, debris pixel IoU | 0.046 | **0.162** |
| SeaClear unseen sites, mask mAP50 | 0.010 | **0.024** |
| TrashCan val, ghost-net image recall / precision / false alarms | 0.862 / 0.758 / 8 | **0.931 / 0.818 / 6** |
| TrashCan val, debris image specificity | **0.782** | 0.723 |
| TrashCan val, debris pixel IoU | **0.695** | 0.632 |

Adopted because every photo the app receives comes from a location the model has not seen, and
ghost nets are the main target; the cost is ~2 points on TrashCan-style footage and more false
alarms on clean TrashCan frames. Outlining and classifying debris at new sites remains weak
(mask mAP50 0.02): the gain there is in noticing debris. A model trained from COCO weights on the
same data scored higher at unseen sites (0.068 mask mAP50, 0.74 debris recall), so training a
fresh model on all data is the next experiment. Evaluation JSON in `docs/review/eval_v3/`.

## Results — GPU fine-tune (`sagarnetra_gpu_v2`, previous model)

`runs/sagarnetra_5k_finetune-3/weights/best.pt` fine-tuned on TrashCan 1.0 (instance
version, official split) on an RTX 4050 Laptop GPU: imgsz 640, batch 16, AdamW lr0=0.001,
cosine LR, 1 warmup epoch. Early-stopped at epoch 124 (patience 30); best epoch 94, 2.7 h.

```
.venv\Scripts\python.exe scripts\train.py --weights runs\sagarnetra_5k_finetune-3\weights\best.pt ^
  --epochs 150 --imgsz 640 --batch 16 --workers 4 --device 0 --patience 30 --cos-lr ^
  --close-mosaic 15 --optimizer AdamW --lr0 0.001 --warmup-epochs 1 --name sagarnetra_gpu_v2
```

The default `--optimizer auto` picks SGD lr0=0.01 for a run this long, a from-scratch rate:
fine-tuning with it dropped val mask mAP50 from 0.51 to 0.16 within three epochs.

Val set: 1147 images. *Unseen videos* = the 34 val images (88 instances, 2 videos) whose
video never appears in train — tiny, but the only leak-free check available. All numbers
from `scripts/evaluate.py` / `scripts/binary_metrics.py`; JSON in `docs/review/eval_v2/`.

| | previous (imgsz 512) | **gpu_v2 (640)** | YOLO11s-seg (640, not adopted) |
|---|---|---|---|
| Box mAP50 / mAP50-95 | 0.576 / 0.403 | **0.701 / 0.517** | 0.701 / 0.519 |
| Mask mAP50 / mAP50-95 | 0.545 / 0.314 | **0.682 / 0.412** | 0.693 / 0.421 |
| Mask mAP50, unseen videos | 0.345 | **0.476** | 0.390 |
| Debris image recall / specificity (conf 0.25) | 0.865 / 0.752 | **0.924 / 0.782** | 0.934 / 0.820 |
| Ghost-net image precision / recall (conf 0.25) | 0.641 / 0.862 | **0.758 / 0.862** | 0.765 / 0.897 |
| Debris pixel IoU (conf 0.25) | 0.585 | **0.695** | 0.692 |
| GPU inference per image | 3.6 ms | **2.4 ms** | 5.4 ms |

Biggest per-class gains (mask mAP50): trash_net 0.45 → 0.81, trash_cup 0.34 → 0.91,
trash_rope 0.30 → 0.62, animal_starfish 0.36 → 0.67, trash_clothing 0.32 → 0.60,
animal_fish 0.27 → 0.54. Small drops: trash_wreckage 0.96 → 0.89 (35 instances),
animal_crab 0.30 → 0.29.

YOLO11s-seg (from COCO weights, 10M params) is ~1 point ahead on the leaky val set but
9 points behind on unseen videos and 2× slower, so it was not adopted. A video-disjoint
re-split is needed to choose between the two reliably.

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
