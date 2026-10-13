-- 002 · Extensions required by the existing frontends and the real model integration.
--
-- Each addition exists because a frontend collects the data or the pipeline needs it;
-- nothing the user enters is silently discarded.

-- ── Sessions: server-side record so logout really revokes a token ─────────────
CREATE TABLE user_sessions (
  session_id  UUID PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);

-- ── Debris types: pin each name to its model class index ──────────────────────
-- The model emits class indices 0..21; storing the index makes the mapping explicit
-- and lets the backend refuse any output whose index/name pair disagrees with the DB.
ALTER TABLE debris_types
  ADD COLUMN class_index SMALLINT UNIQUE CHECK (class_index BETWEEN 0 AND 255),
  ADD COLUMN category    VARCHAR(20) CHECK (category IN ('trash', 'animal', 'plant', 'rov'));

-- ── Reports: fields captured by the professional / citizen frontends ──────────
ALTER TABLE reports
  ADD COLUMN site_name            VARCHAR(200),
  ADD COLUMN observed_at          TIMESTAMPTZ,              -- dive / sighting time (≠ upload_time)
  ADD COLUMN position_accuracy_m  DOUBLE PRECISION CHECK (position_accuracy_m IS NULL OR position_accuracy_m BETWEEN 0 AND 100000),
  -- How the coordinates were obtained. A browser fix is the device's SURFACE position,
  -- never assumed to be the underwater / ROV position.
  ADD COLUMN location_source      VARCHAR(20) NOT NULL DEFAULT 'manual'
                                  CHECK (location_source IN ('browser_gps', 'map_click', 'manual', 'exif', 'sensor')),
  ADD COLUMN source_channel       VARCHAR(20) NOT NULL DEFAULT 'professional'
                                  CHECK (source_channel IN ('citizen', 'professional')),
  -- Long-tail survey fields (bottom time, hazards, vessel, transect, ...). Keys are
  -- whitelisted and type-checked by the API before they are stored.
  ADD COLUMN details              JSONB NOT NULL DEFAULT '{}'::jsonb
                                  CHECK (jsonb_typeof(details) = 'object'),
  ADD COLUMN review_status        VARCHAR(20) NOT NULL DEFAULT 'new'
                                  CHECK (review_status IN ('new', 'assigned', 'resolved')),
  ADD COLUMN inference_status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                                  CHECK (inference_status IN ('pending', 'processing', 'completed', 'partial', 'failed')),
  ADD COLUMN severity             VARCHAR(10)
                                  CHECK (severity IS NULL OR severity IN ('none', 'low', 'med', 'high')),
  ADD COLUMN updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX idx_reports_review_status ON reports(review_status);

-- ── Report images: one report (incident) → many photos ────────────────────────
CREATE TABLE report_images (
  image_id           BIGSERIAL PRIMARY KEY,
  report_id          BIGINT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  position           SMALLINT NOT NULL CHECK (position >= 0),
  storage_key        TEXT NOT NULL UNIQUE,          -- opaque key in the storage backend
  original_filename  VARCHAR(255),
  mime_type          VARCHAR(50) NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256             CHAR(64) NOT NULL,
  width              INTEGER CHECK (width IS NULL OR width > 0),
  height             INTEGER CHECK (height IS NULL OR height > 0),
  annotated_key      TEXT,                          -- model's rendered overlay (JPEG)
  inference_status   VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (inference_status IN ('pending', 'processing', 'completed', 'failed')),
  inference_error    TEXT,
  inference_ms       REAL,
  model_sha256       CHAR(64),
  model_imgsz        SMALLINT,
  model_conf         REAL,
  analysed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id, position)
);
CREATE INDEX idx_report_images_report ON report_images(report_id);

-- ── Debris: link each detection to the image it came from + mask statistics ───
ALTER TABLE debris
  ADD COLUMN image_id        BIGINT REFERENCES report_images(image_id) ON DELETE CASCADE,
  ADD COLUMN mask_key        TEXT,                  -- storage key of the mask PNG
  ADD COLUMN mask_area_px    INTEGER CHECK (mask_area_px IS NULL OR mask_area_px >= 0),
  ADD COLUMN mask_area_frac  REAL CHECK (mask_area_frac IS NULL OR mask_area_frac BETWEEN 0 AND 1),
  ADD COLUMN updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX idx_debris_image ON debris(image_id);
