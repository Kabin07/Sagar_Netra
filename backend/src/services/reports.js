import { withTransaction } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { isAdmin } from '../auth/middleware.js';
import { InferenceError } from './inference.js';
import { detectionSeverity, reportSeverity } from './severity.js';

export const LOCATION_SOURCES = ['browser_gps', 'map_click', 'manual', 'exif', 'sensor'];
export const SOURCE_CHANNELS = ['citizen', 'professional'];
export const REVIEW_STATUSES = ['new', 'assigned', 'resolved'];
export const DEBRIS_STATUSES = ['detected', 'confirmed', 'false_positive', 'removed'];

/**
 * Whitelist for reports.details. Keys map to the professional / citizen form fields
 * that have no dedicated column. Unknown keys are rejected rather than stored blindly.
 */
export const DETAIL_FIELDS = {
  bottom_time_min: { type: 'number', min: 0, max: 1440 },
  declared_type: { type: 'class' },
  extent_m2: { type: 'number', min: 0, max: 10_000_000 },
  debris_state: { type: 'enum', values: ['snagged', 'drifting', 'partially', 'unknown'] },
  retrieval: { type: 'enum', values: ['diver', 'liftbag', 'vessel', 'rov', 'specialist'] },
  hazards: { type: 'set', values: ['marine_life_entangled', 'actively_ghost_fishing', 'navigation_hazard', 'reef_damage'] },
  operator: { type: 'string', max: 200 },
  organisation: { type: 'string', max: 200 },
  vessel: { type: 'string', max: 200 },
  transect_id: { type: 'string', max: 200 },
  sea_state: { type: 'enum', values: ['calm', 'slight', 'moderate', 'rough'] },
  current: { type: 'enum', values: ['none', 'mild', 'strong'] },
  language: { type: 'enum', values: ['en', 'hi', 'ta', 'ml'] },
  location_note: { type: 'string', max: 300 },
};

export function parseDetails(c, raw, classNames) {
  if (raw === undefined || raw === null || raw === '') return {};
  let obj = raw;
  if (typeof raw === 'string') {
    if (raw.length > 20000) return c.fail('details', 'is too large');
    try { obj = JSON.parse(raw); } catch { return c.fail('details', 'must be a JSON object'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return c.fail('details', 'must be a JSON object');
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const spec = DETAIL_FIELDS[key];
    const f = `details.${key}`;
    if (!spec) { c.fail(f, 'is not a recognised field'); continue; }
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    switch (spec.type) {
      case 'number': { const n = c.number(f, value, spec); if (n !== undefined && n !== null) out[key] = n; break; }
      case 'string': { const s = c.string(f, value, { max: spec.max }); if (s) out[key] = s; break; }
      case 'enum': { const v = c.oneOf(f, value, spec.values); if (v) out[key] = v; break; }
      case 'class': { const v = c.oneOf(f, value, classNames); if (v) out[key] = v; break; }
      case 'set':
        if (!Array.isArray(value) || value.some((v) => !spec.values.includes(v))) c.fail(f, `must be a list drawn from: ${spec.values.join(', ')}`);
        else out[key] = [...new Set(value)];
        break;
      default: break;
    }
  }
  return out;
}

export class ReportService {
  constructor({ db, storage, inference, config }) {
    this.db = db;
    this.storage = storage;
    this.inference = inference;
    this.config = config;
    this._classes = null;
  }

  /** debris_types keyed by model class index (cached; reference data). */
  async classMap() {
    if (!this._classes) {
      const { rows } = await this.db.query('SELECT id, type_name, class_index, category FROM debris_types ORDER BY class_index');
      this._classes = new Map(rows.map((r) => [r.class_index, r]));
    }
    return this._classes;
  }

  async classNames() {
    return [...(await this.classMap()).values()].map((t) => t.type_name);
  }

  /** Images left in 'processing' by a crash/restart would otherwise never resolve. */
  async recoverInterrupted() {
    const { rows } = await this.db.query(
      `UPDATE report_images SET inference_status = 'failed', inference_error = 'Interrupted before completion (server restarted); retry analysis'
        WHERE inference_status = 'processing' RETURNING report_id`,
    );
    for (const id of new Set(rows.map((r) => r.report_id))) await this.refreshReportStatus(id);
    return rows.length;
  }

  // ───────────────────────────── create ─────────────────────────────

  /**
   * 1. store files  2. insert report + image rows (one transaction)
   * 3. run inference per image and persist detections per image (one transaction each)
   * 4. set report inference_status / severity from what actually happened.
   */
  async createReport(user, fields, images) {
    const storedKeys = [];
    let report;
    try {
      for (const img of images) {
        img.storageKey = await this.storage.put(img.buffer, { kind: 'images', ext: img.ext });
        storedKeys.push(img.storageKey);
      }
      report = await withTransaction(this.db, async (client) => {
        const { rows: [r] } = await client.query(
          `INSERT INTO reports (reported_by, report_lat, report_long, depth, water_temp, visibility, comments,
                                site_name, observed_at, position_accuracy_m, location_source, source_channel,
                                details, inference_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'processing')
           RETURNING report_id`,
          [user.user_id, fields.lat, fields.lng, fields.depth, fields.water_temp, fields.visibility, fields.comments,
            fields.site_name, fields.observed_at, fields.position_accuracy_m, fields.location_source, fields.source_channel,
            JSON.stringify(fields.details)],
        );
        const imageIds = [];
        for (const [position, img] of images.entries()) {
          const { rows: [row] } = await client.query(
            `INSERT INTO report_images (report_id, position, storage_key, original_filename, mime_type, size_bytes, sha256)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING image_id`,
            [r.report_id, position, img.storageKey, img.originalName, img.mime, img.size, img.sha256],
          );
          imageIds.push(row.image_id);
        }
        await client.query('UPDATE reports SET image_url = $2 WHERE report_id = $1', [r.report_id, `/api/images/${imageIds[0]}`]);
        return { report_id: r.report_id, imageIds };
      });
    } catch (err) {
      await Promise.all(storedKeys.map((k) => this.storage.delete(k).catch(() => {})));
      throw err;
    }

    const imageJobs = report.imageIds.map((id, i) => ({ image_id: id, buffer: images[i].buffer }));
    await this.analyseImages(report.report_id, imageJobs);
    return report.report_id;
  }

  /** Run inference for each image sequentially (the model serialises anyway). */
  async analyseImages(reportId, jobs) {
    for (const job of jobs) {
      await this.analyseImage(job.image_id, job.buffer);
    }
    await this.refreshReportStatus(reportId);
  }

  async analyseImage(imageId, buffer) {
    const classMap = await this.classMap();
    let result;
    try {
      result = await this.inference.segment(buffer, classMap);
    } catch (err) {
      const message = err instanceof InferenceError ? err.message : 'Unexpected inference error';
      if (!(err instanceof InferenceError)) console.error('[inference]', err);
      await this.db.query(
        `UPDATE report_images SET inference_status = 'failed', inference_error = $2, analysed_at = now() WHERE image_id = $1`,
        [imageId, message.slice(0, 500)],
      );
      return { ok: false, error: message };
    }

    // Write derived files first; if the DB transaction fails they are removed again.
    const written = [];
    try {
      const annotatedKey = await this.storage.put(result.annotated, { kind: 'annotated', ext: 'jpg' });
      written.push(annotatedKey);
      for (const d of result.detections) {
        if (d.mask) {
          d.maskKey = await this.storage.put(d.mask.png, { kind: 'masks', ext: 'png' });
          written.push(d.maskKey);
        }
      }
      await withTransaction(this.db, async (client) => {
        const { rows: [img] } = await client.query('SELECT report_id FROM report_images WHERE image_id = $1 FOR UPDATE', [imageId]);
        if (!img) throw new HttpError(404, 'Image disappeared during analysis');
        for (const d of result.detections) {
          const { rows: [{ id }] } = await client.query(`SELECT nextval(pg_get_serial_sequence('debris', 'id')) AS id`);
          await client.query(
            `INSERT INTO debris (id, debris_type_id, report_id, image_id, confidence, bbox, mask_key, mask_url, mask_area_px, mask_area_frac)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [id, d.debrisTypeId, img.report_id, imageId, d.confidence, JSON.stringify(d.bbox),
              d.maskKey ?? null, d.maskKey ? `/api/debris/${id}/mask` : null,
              d.mask?.areaPx ?? null, d.mask?.areaFrac ?? null],
          );
        }
        await client.query(
          `UPDATE report_images
              SET inference_status = 'completed', inference_error = NULL, annotated_key = $2,
                  width = $3, height = $4, inference_ms = $5, model_sha256 = $6, model_imgsz = $7,
                  model_conf = $8, analysed_at = now()
            WHERE image_id = $1`,
          [imageId, annotatedKey, result.width, result.height, result.inferenceMs, result.model.sha256,
            result.model.imgsz, result.model.conf],
        );
      });
      return { ok: true, count: result.detections.length };
    } catch (err) {
      await Promise.all(written.map((k) => this.storage.delete(k).catch(() => {})));
      console.error('[inference] persisting results failed:', err.message);
      await this.db.query(
        `UPDATE report_images SET inference_status = 'failed', inference_error = 'Saving detections failed', analysed_at = now() WHERE image_id = $1`,
        [imageId],
      ).catch(() => {});
      return { ok: false, error: 'Saving detections failed' };
    }
  }

  /** Derive report inference_status + severity from its images and detections. */
  async refreshReportStatus(reportId) {
    const { rows: imgs } = await this.db.query('SELECT inference_status FROM report_images WHERE report_id = $1', [reportId]);
    const counts = imgs.reduce((acc, r) => ({ ...acc, [r.inference_status]: (acc[r.inference_status] || 0) + 1 }), {});
    let status = 'pending';
    if (counts.processing) status = 'processing';
    else if (counts.completed === imgs.length && imgs.length) status = 'completed';
    else if (counts.failed === imgs.length && imgs.length) status = 'failed';
    else if (counts.completed && counts.failed) status = 'partial';
    const { rows: dets } = await this.db.query(
      `SELECT dt.type_name, d.mask_area_frac, d.status FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id WHERE d.report_id = $1`,
      [reportId],
    );
    const severity = reportSeverity(dets, { anyCompleted: Boolean(counts.completed) });
    await this.db.query('UPDATE reports SET inference_status = $2, severity = $3, updated_at = now() WHERE report_id = $1', [reportId, status, severity]);
  }

  /** Retry analysis for images that failed (or never ran). */
  async reprocess(reportId, user) {
    await this.assertAccess(reportId, user);
    const { rows } = await this.db.query(
      `UPDATE report_images SET inference_status = 'processing', inference_error = NULL
        WHERE report_id = $1 AND inference_status IN ('failed', 'pending')
        RETURNING image_id, storage_key`,
      [reportId],
    );
    if (!rows.length) throw new HttpError(409, 'No failed images to re-analyse');
    await this.db.query(`UPDATE reports SET inference_status = 'processing' WHERE report_id = $1`, [reportId]);
    const jobs = [];
    for (const r of rows) {
      try {
        jobs.push({ image_id: r.image_id, buffer: await this.storage.getBuffer(r.storage_key) });
      } catch {
        await this.db.query(`UPDATE report_images SET inference_status = 'failed', inference_error = 'Stored image file is missing' WHERE image_id = $1`, [r.image_id]);
      }
    }
    await this.analyseImages(reportId, jobs);
  }

  // ───────────────────────────── read ─────────────────────────────

  /** Throws 404 (not 403) so report ids of other users are not disclosed. */
  async assertAccess(reportId, user) {
    const { rows } = await this.db.query('SELECT reported_by FROM reports WHERE report_id = $1', [reportId]);
    if (!rows[0] || (rows[0].reported_by !== user.user_id && !isAdmin(user))) throw notFound('Report not found');
    return rows[0];
  }

  async getReport(reportId, user) {
    await this.assertAccess(reportId, user);
    const { rows: [r] } = await this.db.query(
      `SELECT r.*, u.name AS reporter_name FROM reports r JOIN users u ON u.user_id = r.reported_by WHERE r.report_id = $1`,
      [reportId],
    );
    const { rows: images } = await this.db.query(
      'SELECT * FROM report_images WHERE report_id = $1 ORDER BY position',
      [reportId],
    );
    const detections = await this.getDetections(reportId);
    return { ...serializeReport(r), images: images.map(serializeImage), detections, summary: summarize(detections) };
  }

  async getDetections(reportId) {
    const { rows } = await this.db.query(
      `SELECT d.*, dt.type_name, dt.class_index, dt.category
         FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id
        WHERE d.report_id = $1
        ORDER BY (dt.category = 'trash') DESC, d.confidence DESC, d.id`,
      [reportId],
    );
    return rows.map(serializeDetection);
  }

  /** Paginated history. Admins see everything (optionally ?mine=true); others only their own. */
  async listReports(user, { page, limit, reviewStatus, mine }) {
    const where = [];
    const params = [];
    if (!isAdmin(user) || mine) { params.push(user.user_id); where.push(`r.reported_by = $${params.length}`); }
    if (reviewStatus) { params.push(reviewStatus); where.push(`r.review_status = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: [{ total }] } = await this.db.query(`SELECT count(*)::int AS total FROM reports r ${whereSql}`, params);
    params.push(limit, (page - 1) * limit);
    const { rows } = await this.db.query(
      `SELECT r.*, u.name AS reporter_name,
              (SELECT count(*)::int FROM report_images i WHERE i.report_id = r.report_id) AS image_count,
              (SELECT coalesce(json_agg(json_build_object(
                         'id', d.id, 'type_name', dt.type_name, 'category', dt.category, 'class_index', dt.class_index,
                         'confidence', d.confidence, 'status', d.status, 'mask_area_frac', d.mask_area_frac)
                       ORDER BY (dt.category = 'trash') DESC, d.confidence DESC), '[]'::json)
                 FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id
                WHERE d.report_id = r.report_id) AS dets
         FROM reports r JOIN users u ON u.user_id = r.reported_by
         ${whereSql}
        ORDER BY r.upload_time DESC, r.report_id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      reports: rows.map((r) => {
        const dets = r.dets.map((d) => ({ ...d, is_debris: d.category === 'trash', severity: detectionSeverity(d.type_name, d.mask_area_frac) }));
        const { dets: _omit, ...rest } = r;
        return { ...serializeReport(rest), image_count: r.image_count, summary: summarize(dets) };
      }),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** Lightweight, database-backed coordinates for map markers. */
  async markers(user, { limit }) {
    const params = [limit];
    const own = isAdmin(user) ? '' : 'WHERE r.reported_by = $2';
    if (own) params.push(user.user_id);
    const { rows } = await this.db.query(
      `SELECT r.report_id, r.report_lat, r.report_long, r.site_name, r.severity, r.review_status,
              r.inference_status, r.source_channel, r.upload_time, r.location_source,
              (SELECT dt.type_name FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id
                WHERE d.report_id = r.report_id AND d.status <> 'false_positive'
                ORDER BY (dt.category = 'trash') DESC, d.confidence DESC LIMIT 1) AS top_class,
              (SELECT max(d.confidence) FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id
                WHERE d.report_id = r.report_id AND dt.category = 'trash' AND d.status <> 'false_positive') AS top_debris_confidence
         FROM reports r ${own}
        ORDER BY r.upload_time DESC LIMIT $1`,
      params,
    );
    return rows.map((r) => ({
      report_id: r.report_id,
      latitude: r.report_lat,
      longitude: r.report_long,
      site_name: r.site_name,
      severity: r.severity,
      review_status: r.review_status,
      inference_status: r.inference_status,
      source_channel: r.source_channel,
      location_source: r.location_source,
      upload_time: r.upload_time,
      top_class: r.top_class,
      top_debris_confidence: r.top_debris_confidence,
    }));
  }

  // ───────────────────────────── update / delete ─────────────────────────────

  async updateReport(reportId, user, patch) {
    await this.assertAccess(reportId, user);
    if (patch.review_status !== undefined && !isAdmin(user)) throw new HttpError(403, 'Only administrators can change the review status');
    const columns = {
      site_name: 'site_name', comments: 'comments', depth: 'depth', water_temp: 'water_temp', visibility: 'visibility',
      lat: 'report_lat', lng: 'report_long', position_accuracy_m: 'position_accuracy_m', location_source: 'location_source',
      observed_at: 'observed_at', details: 'details', review_status: 'review_status',
    };
    const sets = [];
    const params = [reportId];
    for (const [key, col] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      params.push(key === 'details' ? JSON.stringify(patch[key]) : patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw new HttpError(400, 'No updatable fields supplied');
    await this.db.query(`UPDATE reports SET ${sets.join(', ')}, updated_at = now() WHERE report_id = $1`, params);
    return this.getReport(reportId, user);
  }

  async deleteReport(reportId, user) {
    await this.assertAccess(reportId, user);
    const keys = await withTransaction(this.db, async (client) => {
      const { rows: imgs } = await client.query('SELECT storage_key, annotated_key FROM report_images WHERE report_id = $1', [reportId]);
      const { rows: masks } = await client.query('SELECT mask_key FROM debris WHERE report_id = $1 AND mask_key IS NOT NULL', [reportId]);
      await client.query('DELETE FROM reports WHERE report_id = $1', [reportId]); // cascades to images + debris
      return [...imgs.flatMap((i) => [i.storage_key, i.annotated_key]), ...masks.map((m) => m.mask_key)].filter(Boolean);
    });
    await Promise.all(keys.map((k) => this.storage.delete(k).catch(() => {})));
  }

  async updateDebris(debrisId, user, { status, comment }) {
    const { rows } = await this.db.query(
      'SELECT d.report_id, r.reported_by FROM debris d JOIN reports r ON r.report_id = d.report_id WHERE d.id = $1',
      [debrisId],
    );
    if (!rows[0] || (rows[0].reported_by !== user.user_id && !isAdmin(user))) throw notFound('Detection not found');
    await this.db.query(
      `UPDATE debris SET status = COALESCE($2, status), comment = CASE WHEN $3::boolean THEN $4 ELSE comment END, updated_at = now()
        WHERE id = $1`,
      [debrisId, status ?? null, comment !== undefined, comment ?? null],
    );
    await this.refreshReportStatus(rows[0].report_id);
    const { rows: [d] } = await this.db.query(
      `SELECT d.*, dt.type_name, dt.class_index, dt.category FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id WHERE d.id = $1`,
      [debrisId],
    );
    return serializeDetection(d);
  }

  // ───────────────────────────── files ─────────────────────────────

  async imageFile(imageId, user, variant) {
    const { rows } = await this.db.query(
      `SELECT i.storage_key, i.annotated_key, i.mime_type, r.reported_by
         FROM report_images i JOIN reports r ON r.report_id = i.report_id WHERE i.image_id = $1`,
      [imageId],
    );
    const row = rows[0];
    if (!row || (row.reported_by !== user.user_id && !isAdmin(user))) throw notFound('Image not found');
    if (variant === 'annotated') {
      if (!row.annotated_key) throw notFound('No annotated image (analysis not completed)');
      return { key: row.annotated_key, mime: 'image/jpeg' };
    }
    return { key: row.storage_key, mime: row.mime_type };
  }

  async maskFile(debrisId, user) {
    const { rows } = await this.db.query(
      'SELECT d.mask_key, r.reported_by FROM debris d JOIN reports r ON r.report_id = d.report_id WHERE d.id = $1',
      [debrisId],
    );
    const row = rows[0];
    if (!row || (row.reported_by !== user.user_id && !isAdmin(user))) throw notFound('Detection not found');
    if (!row.mask_key) throw notFound('This detection has no mask');
    return { key: row.mask_key, mime: 'image/png' };
  }
}

// ───────────────────────────── serialisers ─────────────────────────────

export function serializeReport(r) {
  return {
    report_id: r.report_id,
    reported_by: r.reported_by,
    reporter_name: r.reporter_name,
    upload_time: r.upload_time,
    observed_at: r.observed_at,
    site_name: r.site_name,
    latitude: r.report_lat,
    longitude: r.report_long,
    position_accuracy_m: r.position_accuracy_m,
    location_source: r.location_source,
    source_channel: r.source_channel,
    depth: r.depth,
    water_temp: r.water_temp,
    visibility: r.visibility,
    comments: r.comments,
    details: r.details,
    review_status: r.review_status,
    inference_status: r.inference_status,
    severity: r.severity,
    image_url: r.image_url,
    updated_at: r.updated_at,
  };
}

function serializeImage(i) {
  return {
    image_id: i.image_id,
    position: i.position,
    url: `/api/images/${i.image_id}`,
    annotated_url: i.annotated_key ? `/api/images/${i.image_id}/annotated` : null,
    original_filename: i.original_filename,
    mime_type: i.mime_type,
    size_bytes: i.size_bytes,
    width: i.width,
    height: i.height,
    inference_status: i.inference_status,
    inference_error: i.inference_error,
    inference_ms: i.inference_ms,
    model_sha256: i.model_sha256,
    model_imgsz: i.model_imgsz,
    model_conf: i.model_conf,
    analysed_at: i.analysed_at,
  };
}

export function serializeDetection(d) {
  return {
    id: d.id,
    report_id: d.report_id,
    image_id: d.image_id,
    debris_type_id: d.debris_type_id,
    class_index: d.class_index,
    type_name: d.type_name,
    category: d.category,
    is_debris: d.category === 'trash',
    confidence: d.confidence,
    bbox: d.bbox,
    mask_url: d.mask_url,
    mask_area_px: d.mask_area_px,
    mask_area_frac: d.mask_area_frac,
    severity: detectionSeverity(d.type_name, d.mask_area_frac),
    status: d.status,
    comment: d.comment,
    created_at: d.created_at,
  };
}

function summarize(dets) {
  const active = dets.filter((d) => d.status !== 'false_positive');
  const debris = active.filter((d) => d.is_debris);
  const top = debris[0] || active[0] || null;
  return {
    detection_count: active.length,
    debris_count: debris.length,
    classes: [...new Set(active.map((d) => d.type_name))],
    debris_area_frac: Number(debris.reduce((s, d) => s + (d.mask_area_frac || 0), 0).toFixed(6)),
    top: top && { type_name: top.type_name, confidence: top.confidence, is_debris: top.is_debris, severity: top.severity },
  };
}
