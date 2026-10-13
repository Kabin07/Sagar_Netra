import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { Checker, parseId } from '../validation.js';
import { DEBRIS_STATUSES } from '../services/reports.js';

/** Authorised access to stored images / masks, plus detection review. */
export function filesRouter({ reports, storage }) {
  const r = Router();
  const send = (res, next, { key, mime }) => {
    res.set({
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    const stream = storage.get(key);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.removeHeader('Content-Disposition');
        res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Stored file unavailable' });
      } else next(err);
    });
    stream.pipe(res);
  };

  r.get('/images/:id', requireAuth, async (req, res, next) => {
    send(res, next, await reports.imageFile(parseId(req.params.id, 'image id'), req.user, 'original'));
  });

  r.get('/images/:id/annotated', requireAuth, async (req, res, next) => {
    send(res, next, await reports.imageFile(parseId(req.params.id, 'image id'), req.user, 'annotated'));
  });

  r.get('/debris/:id/mask', requireAuth, async (req, res, next) => {
    send(res, next, await reports.maskFile(parseId(req.params.id, 'detection id'), req.user));
  });

  r.patch('/debris/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'detection id');
    const b = req.body || {};
    const c = new Checker();
    const status = c.oneOf('status', b.status, DEBRIS_STATUSES);
    const comment = Object.prototype.hasOwnProperty.call(b, 'comment') ? c.string('comment', b.comment, { max: 2000 }) : undefined;
    for (const k of Object.keys(b)) if (!['status', 'comment'].includes(k)) c.fail(k, 'cannot be updated');
    if (status == null && comment === undefined) c.fail('status', 'status or comment is required');
    c.throwIfAny('Invalid update');
    res.json({ detection: await reports.updateDebris(id, req.user, { status, comment }) });
  });

  return r;
}
