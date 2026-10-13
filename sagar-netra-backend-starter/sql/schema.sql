CREATE TABLE IF NOT EXISTS user_types (
 user_type_id SERIAL PRIMARY KEY, type_name VARCHAR(50) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
 user_id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
 email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 user_type_id INT NOT NULL REFERENCES user_types(user_type_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS debris_types (
 id SERIAL PRIMARY KEY, type_name VARCHAR(100) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
 report_id BIGSERIAL PRIMARY KEY, reported_by BIGINT NOT NULL REFERENCES users(user_id),
 upload_time TIMESTAMPTZ NOT NULL DEFAULT NOW(), image_url TEXT,
 report_lat DOUBLE PRECISION NOT NULL CHECK(report_lat BETWEEN -90 AND 90),
 report_long DOUBLE PRECISION NOT NULL CHECK(report_long BETWEEN -180 AND 180),
 depth DOUBLE PRECISION CHECK(depth IS NULL OR depth >= 0),
 water_temp DOUBLE PRECISION, visibility DOUBLE PRECISION CHECK(visibility IS NULL OR visibility >= 0),
 comments TEXT
);
CREATE TABLE IF NOT EXISTS debris (
 id BIGSERIAL PRIMARY KEY, debris_type_id INT NOT NULL REFERENCES debris_types(id),
 report_id BIGINT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
 status VARCHAR(30) NOT NULL DEFAULT 'detected'
   CHECK(status IN ('detected','reviewed','resolved','false_positive')),
 confidence DOUBLE PRECISION CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
 bbox JSONB, mask_url TEXT, comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_reported_by ON reports(reported_by);
CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(upload_time DESC);
CREATE INDEX IF NOT EXISTS idx_reports_coords ON reports(report_lat,report_long);
CREATE INDEX IF NOT EXISTS idx_debris_report ON debris(report_id);
INSERT INTO user_types(type_name) VALUES ('admin'),('diver'),('researcher') ON CONFLICT DO NOTHING;
INSERT INTO debris_types(type_name) VALUES
('rov'),('plant'),('animal_fish'),('animal_starfish'),('animal_shells'),('animal_crab'),
('animal_eel'),('animal_etc'),('trash_clothing'),('trash_pipe'),('trash_bottle'),('trash_bag'),
('trash_snack_wrapper'),('trash_can'),('trash_cup'),('trash_container'),('trash_unknown_instance'),
('trash_branch'),('trash_wreckage'),('trash_tarp'),('trash_rope'),('trash_net')
ON CONFLICT DO NOTHING;
