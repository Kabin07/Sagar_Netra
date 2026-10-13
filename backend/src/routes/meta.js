import { Router } from 'express';

export function metaRouter({ db, inference }) {
  const r = Router();

  r.get('/health', async (_req, res) => {
    let database = 'connected';
    try {
      await db.query('SELECT 1');
    } catch {
      database = 'unreachable';
    }
    const inf = await inference.health();
    const ok = database === 'connected';
    res.status(ok ? 200 : 503).json({
      status: ok ? (inf.ok ? 'ok' : 'degraded') : 'error',
      database,
      inference: inf.reachable
        ? { reachable: true, model_loaded: Boolean(inf.model_loaded), error: inf.error || null, num_classes: inf.num_classes, imgsz: inf.imgsz }
        : { reachable: false, model_loaded: false, error: inf.error },
    });
  });

  r.get('/user-types', async (_req, res) => {
    const { rows } = await db.query('SELECT user_type_id, type_name FROM user_types ORDER BY user_type_id');
    res.json({ user_types: rows });
  });

  r.get('/debris-types', async (_req, res) => {
    const { rows } = await db.query('SELECT id, type_name, class_index, category FROM debris_types ORDER BY class_index');
    res.json({ debris_types: rows });
  });

  return r;
}
