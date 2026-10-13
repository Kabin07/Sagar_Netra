-- 004 · Hosting hardening (Supabase-safe) + read-only monitoring views.
--
-- On Supabase every table in `public` is reachable through the auto-generated REST
-- API (PostgREST) by the `anon` / `authenticated` roles — i.e. by anyone holding the
-- PUBLISHABLE key, which is designed to be public. SAGAR-NETRA never uses that API:
-- all access goes through the Node backend, connected as the table owner. So:
--   * Row Level Security is enabled on every table with NO policies → the API roles
--     can read/write nothing (the owner used by the backend is unaffected).
--   * All privileges are revoked from the API roles, now and for future tables.
-- On a plain PostgreSQL server the API roles do not exist and those steps are skipped;
-- enabling RLS is harmless there because the backend connects as the table owner.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_types','users','user_sessions','reports','report_images',
                           'debris_types','debris','schema_migrations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ── Monitoring views ──────────────────────────────────────────────────────────
-- A separate schema that the Supabase Data API does not expose. Browse it in the
-- Supabase dashboard (Table Editor → schema "monitoring") or any SQL client.
-- No view exposes password hashes or session tokens.
CREATE SCHEMA monitoring;

CREATE VIEW monitoring.system_summary AS
SELECT
  (SELECT count(*) FROM users)                                              AS users,
  (SELECT count(*) FROM users u JOIN user_types t USING (user_type_id) WHERE t.type_name = 'admin') AS admins,
  (SELECT count(*) FROM reports)                                            AS reports,
  (SELECT count(*) FROM reports WHERE review_status = 'new')                AS reports_awaiting_triage,
  (SELECT count(*) FROM reports WHERE inference_status IN ('failed','partial')) AS reports_with_failed_analysis,
  (SELECT count(*) FROM report_images)                                      AS images,
  (SELECT count(*) FROM debris)                                             AS detections,
  (SELECT count(*) FROM debris d JOIN debris_types t ON t.id = d.debris_type_id WHERE t.category = 'trash') AS debris_detections,
  (SELECT count(*) FROM debris d JOIN debris_types t ON t.id = d.debris_type_id WHERE t.type_name = 'trash_net') AS ghost_net_detections,
  (SELECT count(*) FROM user_sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_sessions,
  (SELECT max(upload_time) FROM reports)                                    AS last_report_at;

CREATE VIEW monitoring.users_overview AS
SELECT u.user_id, u.name, u.email, t.type_name AS role, u.created_at,
       count(DISTINCT r.report_id)                                  AS reports,
       max(r.upload_time)                                           AS last_report_at,
       (SELECT count(*) FROM user_sessions s
         WHERE s.user_id = u.user_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
       (SELECT max(s.created_at) FROM user_sessions s WHERE s.user_id = u.user_id) AS last_login_at
  FROM users u
  JOIN user_types t USING (user_type_id)
  LEFT JOIN reports r ON r.reported_by = u.user_id
 GROUP BY u.user_id, t.type_name;

CREATE VIEW monitoring.reports_overview AS
SELECT r.report_id, r.upload_time, r.observed_at,
       u.user_id AS reported_by, u.name AS reporter_name, u.email AS reporter_email,
       r.site_name, r.report_lat, r.report_long, r.location_source, r.source_channel,
       r.depth, r.water_temp, r.visibility, r.comments,
       r.review_status, r.inference_status, r.severity,
       (SELECT count(*) FROM report_images i WHERE i.report_id = r.report_id) AS images,
       (SELECT count(*) FROM debris d WHERE d.report_id = r.report_id)        AS detections,
       (SELECT count(*) FROM debris d JOIN debris_types t ON t.id = d.debris_type_id
         WHERE d.report_id = r.report_id AND t.category = 'trash')            AS debris_items,
       (SELECT t.type_name FROM debris d JOIN debris_types t ON t.id = d.debris_type_id
         WHERE d.report_id = r.report_id ORDER BY (t.category = 'trash') DESC, d.confidence DESC LIMIT 1) AS top_class
  FROM reports r JOIN users u ON u.user_id = r.reported_by;

CREATE VIEW monitoring.debris_overview AS
SELECT d.id AS debris_id, d.report_id, d.image_id, t.class_index, t.type_name, t.category,
       d.confidence, d.status, d.comment, d.mask_area_frac, d.bbox, d.created_at,
       r.report_lat, r.report_long, r.site_name, u.name AS reporter_name, u.email AS reporter_email
  FROM debris d
  JOIN debris_types t ON t.id = d.debris_type_id
  JOIN reports r      ON r.report_id = d.report_id
  JOIN users u        ON u.user_id = r.reported_by;

CREATE VIEW monitoring.debris_type_counts AS
SELECT t.class_index, t.type_name, t.category,
       count(d.id)                                         AS detections,
       count(d.id) FILTER (WHERE d.status = 'confirmed')   AS confirmed,
       count(d.id) FILTER (WHERE d.status = 'false_positive') AS false_positives,
       count(d.id) FILTER (WHERE d.status = 'removed')     AS removed,
       round(avg(d.confidence)::numeric, 3)                AS mean_confidence
  FROM debris_types t LEFT JOIN debris d ON d.debris_type_id = t.id
 GROUP BY t.id
 ORDER BY t.class_index;

CREATE VIEW monitoring.inference_failures AS
SELECT i.image_id, i.report_id, i.original_filename, i.inference_status, i.inference_error,
       i.analysed_at, u.email AS reporter_email
  FROM report_images i
  JOIN reports r ON r.report_id = i.report_id
  JOIN users u   ON u.user_id = r.reported_by
 WHERE i.inference_status <> 'completed';

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA monitoring FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA monitoring FROM %I', r);
    END IF;
  END LOOP;
END $$;
