import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashPassword, publicUser, verifyPassword } from '../auth/sessions.js';
import { HttpError, notFound } from '../errors.js';
import { parseId } from '../validation.js';

export function usersRouter({ db, config }) {
  const r = Router();
  const passwordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many password attempts; try again later' },
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  /** Change your own password. Requires the current one; signs out your other sessions. */
  r.post('/me/password', passwordLimiter, requireAuth, async (req, res) => {
    const { current_password: current, new_password: next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string' || !current) {
      throw new HttpError(400, 'current_password and new_password are required');
    }
    if (next.length < 10 || next.length > 128) throw new HttpError(400, 'New password must be 10-128 characters');
    if (next === current) throw new HttpError(400, 'New password must differ from the current one');
    const { rows } = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
    if (!rows[0] || !(await verifyPassword(current.slice(0, 128), rows[0].password_hash))) {
      throw new HttpError(403, 'Current password is incorrect');
    }
    await db.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [req.user.user_id, await hashPassword(next)]);
    const { rowCount } = await db.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL',
      [req.user.user_id, req.sessionId],
    );
    res.json({ ok: true, other_sessions_signed_out: rowCount });
  });

  /** Admin-only role management (promote/demote). There is no public path to admin. */
  r.patch('/:id/role', requireRole('admin'), async (req, res) => {
    const userId = parseId(req.params.id, 'user id');
    const role = req.body?.role;
    if (typeof role !== 'string') throw new HttpError(400, 'role is required');
    if (userId === req.user.user_id && role !== 'admin') {
      throw new HttpError(400, 'Administrators cannot demote themselves');
    }
    const { rows } = await db.query(
      `UPDATE users u SET user_type_id = ut.user_type_id FROM user_types ut
        WHERE u.user_id = $1 AND ut.type_name = $2
        RETURNING u.user_id, u.name, u.email, u.user_type_id, u.created_at, ut.type_name AS role`,
      [userId, role],
    );
    if (!rows[0]) {
      const exists = await db.query('SELECT 1 FROM user_types WHERE type_name = $1', [role]);
      if (!exists.rows[0]) throw new HttpError(400, 'Unknown role');
      throw notFound('User not found');
    }
    res.json({ user: publicUser(rows[0]) });
  });

  return r;
}
