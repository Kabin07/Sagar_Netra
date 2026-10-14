# SAGAR-NETRA — Frontend Documentation

AI-powered ghost-net and marine debris detection for Indian coastal waters.

Two frontends, one detection backend.

---

## 1. System architecture

```
                    ┌─────────────────────────────┐
   Citizen PWA ────▶ │                             │
   (phone camera)    │   Layer 1  OpenCV           │  white balance + CLAHE
                    │   Layer 2  YOLOv8n-seg      │  22-class instance seg
   Authority console │   Layer 3  GIS aggregation  │  geotag, cluster, score
   (survey upload) ─▶ │                             │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
             WhatsApp alert              Operations console
          (citizen + response unit)      (map, queue, triage)
```

### The three layers, stated precisely

| Layer | Technology | What it actually does |
|---|---|---|
| **1 — Restoration** | OpenCV | Gray-world white balance + CLAHE contrast equalisation. Undoes the blue-green colour cast and low contrast of underwater imagery. **This is preprocessing, not a detector.** |
| **2 — Detection** | YOLOv8n-seg | Instance segmentation over 22 TrashCan classes. Returns class, confidence, and a pixel mask per instance. |
| **3 — Geospatial** | Leaflet / GIS | Geotags each report, clusters duplicate sightings of the same object, scores severity from mask area, routes to the nearest response unit. |

> **Say it this way in a review.** Layer 1 is not a second AI model — describing OpenCV as "AI detection" invites a correction. Its real value is that it directly attacks the turbidity gap, which is the model's main documented weakness.

---

## 2. Citizen app — installable PWA

**Path:** `frontend/citizen/`
**Audience:** fishermen, beachgoers, general public
**Form factor:** mobile-first, installs to the home screen

### Why a PWA rather than a native app

| | PWA | Native (React Native / Flutter) |
|---|---|---|
| Build toolchain | none | Android Studio / Xcode, hours of setup |
| Distribution | a URL | app store review |
| Install | "Add to Home Screen" | store download |
| Camera | full access via capture input | full access |
| Demo risk | opens on any judge's phone | needs a device with your build |

A PWA can be wrapped into a store build later (Capacitor / TWA) with no rewrite. For a time-boxed prototype it is the correct call, not a compromise.

### Features

- **Native camera capture** — uses `<input type="file" accept="image/*" capture="environment">`. This opens the phone's real camera app and, unlike `getUserMedia`, **works over plain HTTP**, so it functions on a local-network demo without HTTPS.
- **Live enhancement preview** — Original / Enhanced toggle showing exactly what Layer 1 does to the image. Runs client-side in canvas.
- **GPS tagging** — auto-captures coordinates and accuracy, with a manual location field as fallback when permission is denied.
- **Four languages** — English, Hindi, Tamil, Malayalam.
- **Report history** — persisted in `localStorage` with status badges.
- **Offline shell** — service worker caches the app so it opens without a network.

### Files

```
frontend/citizen/
├── index.html          complete app (HTML + CSS + JS, no dependencies)
├── manifest.json       PWA metadata
├── sw.js               service worker, offline shell
├── icon.svg
└── icon-maskable.svg
```

---

## 3. Authority console — desktop webapp

**Path:** `frontend/authority/`
**Audience:** coastal authorities, Coast Guard, CMFRI survey units, ROV pilots

### Tab 1 — Operations

- **Live GIS map** (Leaflet + OpenStreetMap tiles, darkened with CSS; no API key) with pins **sized by estimated debris area** and **coloured by severity**.
- **Triage queue** with filters: status, ghost-nets-only, citizen vs professional source.
- **Detail panel** — image, class, confidence bar, coordinates, estimated area, severity, provenance, and status workflow (`New → Assigned → Resolved`).
- **WhatsApp alert payload** — shows the exact message that would be dispatched to the response unit and the reporting citizen.
- **Live KPIs** — active reports, ghost nets outstanding, awaiting triage, resolved, total estimated debris area.

### Tab 2 — Field Survey

For professionals who *capture* rather than only review — ROV pilots, dive teams, patrol crews.

- Drag-and-drop **batch upload**
- Each image runs Layer 1 enhancement client-side for immediate preview
- Per-image result tile: class, confidence, estimated area, severity

### Files

```
frontend/authority/
└── index.html          complete console (Leaflet from CDN)
```

---

## 4. Running it

A static server is all that is required — there is no build step.

```bash
python -m http.server 5180 --directory C:/Users/ielev/sagar-netra/frontend
```

| App | URL |
|---|---|
| Citizen PWA | http://localhost:5180/citizen/ |
| Authority console | http://localhost:5180/authority/ |

**To demo the citizen app on a real phone**, serve on your LAN and open `http://<your-laptop-ip>:5180/citizen/` on the phone (same Wi-Fi). Camera capture works over HTTP. Note that **geolocation and service-worker install require HTTPS** on a phone — the app degrades gracefully to the manual location field, so the demo still works.

---

## 5. What is real and what is simulated

| Component | Status |
|---|---|
| YOLOv8n-seg trained model | **Real.** `runs/sagarnetra_gpu_v2/weights/best.pt`, served by `inference/service.py` |
| Detection results shown in all three frontends | **Real.** Every result comes from the model via the backend; nothing is simulated. If the backend or model is unavailable the apps say so (report not sent, or saved with "analysis failed" and a retry button). |
| Accounts, report history, map pins | **Real.** PostgreSQL via the Express API (`backend/`); see README.md |
| Layer 1 enhancement in the frontends | **Real**, preview only. The model analyses the original image (enhancing first lowered recall). |
| Severity / pin size | Heuristic from class + mask coverage (% of frame). Not a calibrated area in m². |
| WhatsApp dispatch | **Not connected.** The console shows a preview payload labelled "not sent". |

All pages use `frontend/shared/sn-client.js` (session-cookie auth, JSON API, upload progress) and are served
by the backend at `http://127.0.0.1:4000/` — see README.md for setup. Pre-integration copies are in `legacy/`.

---

## 6. Known gaps

1. **Severity is a heuristic**, not calibrated (see above).
2. **No offline submission queue.** The service worker caches the app shell (never `/api/`), but a report still needs a live connection. Background Sync is the next step for boats.
3. **Duplicate clustering is not implemented.**
4. **Browser GPS on phones needs HTTPS**; manual coordinates always work.

---

## 7. Roadmap

| Priority | Item |
|---|---|
| 2 | WhatsApp Cloud API integration (test number → verified business number) |
| 3 | Offline store-and-forward for boats via Background Sync |
| 4 | CycleGAN turbid-water domain adaptation |
| 5 | Video / live ROV stream inference (model already runs at ~65 FPS) |
| 6 | Duplicate-sighting clustering across reports |
