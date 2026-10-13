-- 001 · Core schema from the SAGAR-NETRA ER diagram.
--
--   User_Type 1 ── N User        (has)
--   User      1 ── N Report      (submits)
--   Report    1 ── N Debris      (contains)
--   Debris_Type 1 ── N Debris    (belongs to)
--
-- Deviations from the diagram, all deliberate:
--   * The diagram names the report key `image_id`; it is `report_id` here because a
--     report can carry several images (see 002_reporting_extensions.sql, report_images).
--   * `debris` gains confidence / bbox / mask_url / created_at for model output.

CREATE TABLE user_types (
  user_type_id  SERIAL PRIMARY KEY,
  type_name     VARCHAR(50) NOT NULL UNIQUE
                CHECK (type_name ~ '^[a-z][a-z_]{1,49}$')
);

CREATE TABLE users (
  user_id        BIGSERIAL PRIMARY KEY,
  name           VARCHAR(100) NOT NULL CHECK (length(btrim(name)) >= 2),
  email          VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash  TEXT NOT NULL,
  user_type_id   INT NOT NULL REFERENCES user_types(user_type_id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_user_type ON users(user_type_id);

CREATE TABLE reports (
  report_id    BIGSERIAL PRIMARY KEY,
  reported_by  BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  upload_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
  image_url    TEXT,                     -- cover image (first image); all images live in report_images
  report_lat   DOUBLE PRECISION NOT NULL CHECK (report_lat BETWEEN -90 AND 90),
  report_long  DOUBLE PRECISION NOT NULL CHECK (report_long BETWEEN -180 AND 180),
  depth        DOUBLE PRECISION CHECK (depth IS NULL OR depth BETWEEN 0 AND 11000),          -- metres
  water_temp   DOUBLE PRECISION CHECK (water_temp IS NULL OR water_temp BETWEEN -5 AND 50),  -- °C
  visibility   DOUBLE PRECISION CHECK (visibility IS NULL OR visibility BETWEEN 0 AND 1000), -- metres
  comments     TEXT CHECK (comments IS NULL OR length(comments) <= 5000)
);
CREATE INDEX idx_reports_reported_by ON reports(reported_by, upload_time DESC);
CREATE INDEX idx_reports_upload_time ON reports(upload_time DESC);
CREATE INDEX idx_reports_coords      ON reports(report_lat, report_long);

CREATE TABLE debris_types (
  id         SERIAL PRIMARY KEY,
  type_name  VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE debris (
  id              BIGSERIAL PRIMARY KEY,
  debris_type_id  INT NOT NULL REFERENCES debris_types(id) ON DELETE RESTRICT,
  report_id       BIGINT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  status          VARCHAR(30) NOT NULL DEFAULT 'detected'
                  CHECK (status IN ('detected', 'confirmed', 'false_positive', 'removed')),
  confidence      DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  bbox            JSONB NOT NULL,        -- see README "Bounding-box format"
  mask_url        TEXT,                  -- authorised route serving the stored mask PNG
  comment         TEXT CHECK (comment IS NULL OR length(comment) <= 2000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_debris_report ON debris(report_id);
CREATE INDEX idx_debris_type   ON debris(debris_type_id);
