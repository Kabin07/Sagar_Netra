import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth/middleware.js';
import { HttpError } from '../errors.js';
import { Checker, checkCoordinates, parseId } from '../validation.js';
import { validateImageFile } from '../services/images.js';
import {
  LOCATION_SOURCES, REVIEW_STATUSES, SOURCE_CHANNELS, parseDetails,
} from '../services/reports.js';

export function reportsRouter({ reports, config }) {
  const r = Router();
  r.use(requireAuth);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.floor(config.maxUploadMb * 1024 * 1024),
      files: config.maxFilesPerReport,
      fields: 40,
      fieldSize: 64 * 1024,
      parts: config.maxFilesPerReport + 40,
    },
  });
  const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.reportRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many report submissions; try again later' },
  });

  // POST /api/reports — multipart: images[] + metadata fields
  r.post('/', submitLimiter, upload.array('images', config.maxFilesPerReport), async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw new HttpError(400, 'At least one image is required (multipart field "images")');
    const images = files.map((f) => ({ ...validateImageFile(f), buffer: f.buffer }));

    const b = req.body || {};
    const c = new Checker();
    const { lat, lng } = checkCoordinates(c, b.latitude, b.longitude);
    const fields = {
      lat,
      lng,
      depth: c.number('depth', b.depth, { min: 0, max: 11000 }),
      water_temp: c.number('water_temp', b.water_temp, { min: -5, max: 50 }),
      visibility: c.number('visibility', b.visibility, { min: 0, max: 1000 }),
      position_accuracy_m: c.number('position_accuracy_m', b.position_accuracy_m, { min: 0, max: 100000 }),
      comments: c.string('comments', b.comments, { max: 5000 }),
      site_name: c.string('site_name', b.site_name, { max: 200 }),
      observed_at: c.date('observed_at', b.observed_at),
      location_source: c.oneOf('location_source', b.location_source, LOCATION_SOURCES, { fallback: 'manual' }),
      source_channel: c.oneOf('source_channel', b.source_channel, SOURCE_CHANNELS, { fallback: 'professional' }),
      details: parseDetails(c, b.details, await reports.classNames()),
    };
    c.throwIfAny('Invalid report');

    const reportId = await reports.createReport(req.user, fields, images);
    const report = await reports.getReport(reportId, req.user);
    res.status(201).json({ report, inference: inferenceSummary(report) });
  });

  r.get('/', async (req, res) => {
    const c = new Checker();
    const page = c.number('page', req.query.page, { min: 1, max: 100000, integer: true }) ?? 1;
    const limit = c.number('limit', req.query.limit, { min: 1, max: 100, integer: true }) ?? 20;
    const reviewStatus = c.oneOf('review_status', req.query.review_status, REVIEW_STATUSES);
    c.throwIfAny('Invalid query');
    res.json(await reports.listReports(req.user, { page, limit, reviewStatus, mine: req.query.mine === 'true' }));
  });

  r.get('/markers', async (req, res) => {
    const c = new Checker();
    const limit = c.number('limit', req.query.limit, { min: 1, max: 2000, integer: true }) ?? 500;
    c.throwIfAny('Invalid query');
    res.json({ markers: await reports.markers(req.user, { limit }) });
  });

  r.get('/:id', async (req, res) => {
    res.json({ report: await reports.getReport(parseId(req.params.id, 'report id'), req.user) });
  });

  r.get('/:id/detections', async (req, res) => {
    const id = parseId(req.params.id, 'report id');
    await reports.assertAccess(id, req.user);
    res.json({ detections: await reports.getDetections(id) });
  });

  r.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id, 'report id');
    const b = req.body || {};
    const c = new Checker();
    const patch = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (has('latitude') || has('longitude')) {
      const { lat, lng } = checkCoordinates(c, b.latitude, b.longitude);
      Object.assign(patch, { lat, lng });
    }
    if (has('site_name')) patch.site_name = c.string('site_name', b.site_name, { max: 200 });
    if (has('comments')) patch.comments = c.string('comments', b.comments, { max: 5000 });
    if (has('depth')) patch.depth = c.number('depth', b.depth, { min: 0, max: 11000 });
    if (has('water_temp')) patch.water_temp = c.number('water_temp', b.water_temp, { min: -5, max: 50 });
    if (has('visibility')) patch.visibility = c.number('visibility', b.visibility, { min: 0, max: 1000 });
    if (has('position_accuracy_m')) patch.position_accuracy_m = c.number('position_accuracy_m', b.position_accuracy_m, { min: 0, max: 100000 });
    if (has('location_source')) patch.location_source = c.oneOf('location_source', b.location_source, LOCATION_SOURCES, { required: true });
    if (has('observed_at')) patch.observed_at = c.date('observed_at', b.observed_at);
    if (has('details')) patch.details = parseDetails(c, b.details, await reports.classNames());
    if (has('review_status')) patch.review_status = c.oneOf('review_status', b.review_status, REVIEW_STATUSES, { required: true });
    const unknown = Object.keys(b).filter((k) => !['latitude', 'longitude', 'site_name', 'comments', 'depth', 'water_temp', 'visibility',
      'position_accuracy_m', 'location_source', 'observed_at', 'details', 'review_status'].includes(k));
    for (const k of unknown) c.fail(k, 'cannot be updated');
    c.throwIfAny('Invalid update');
    res.json({ report: await reports.updateReport(id, req.user, patch) });
  });

  r.delete('/:id', async (req, res) => {
    await reports.deleteReport(parseId(req.params.id, 'report id'), req.user);
    res.status(204).end();
  });

  // Retry analysis for images whose inference failed (e.g. service was down).
  r.post('/:id/reprocess', async (req, res) => {
    const id = parseId(req.params.id, 'report id');
    await reports.reprocess(id, req.user);
    const report = await reports.getReport(id, req.user);
    res.json({ report, inference: inferenceSummary(report) });
  });

  return r;
}

function inferenceSummary(report) {
  const failed = report.images.filter((i) => i.inference_status === 'failed');
  return {
    status: report.inference_status,
    images_total: report.images.length,
    images_analysed: report.images.filter((i) => i.inference_status === 'completed').length,
    errors: failed.map((i) => ({ image_id: i.image_id, filename: i.original_filename, error: i.inference_error })),
  };
}
