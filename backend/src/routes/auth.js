import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Checker, EMAIL_RE } from '../validation.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import {
  COOKIE_NAME, cookieOptions, createSession, hashPassword, publicUser, revokeSession, verifyPassword,
} from '../auth/sessions.js';

/** Roles a person may pick for themselves. `admin` is never self-assignable. */
export const SELF_SERVICE_ROLES = ['diver', 'researcher', 'citizen'];
export const DEFAULT_ROLE = 'diver';

export function authRouter({ db, config }) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts; try again later' },
  });

  r.post('/register', limiter, async (req, res) => {
    const c = new Checker();
    const b = req.body || {};
    const name = c.string('name', b.name, { required: true, min: 2, max: 100 });
    const email = c.string('email', b.email, { required: true, max: 255, pattern: EMAIL_RE });
    const password = c.string('password', b.password, { required: true, min: 10, max: 128, trim: false });
    if (b.role !== undefined && b.role !== null && b.role !== '' && !SELF_SERVICE_ROLES.includes(b.role)) {
      // Explicit refusal (not silent downgrade) so privilege-escalation attempts are visible.
      throw new HttpError(403, `Role "${String(b.role).slice(0, 30)}" cannot be self-assigned`);
    }
    c.throwIfAny();
    const role = b.role || DEFAULT_ROLE;

    const hash = await hashPassword(password);
    let user;
    try {
      const { rows } = await db.query(
        `INSERT INTO users (name, email, password_hash, user_type_id)
         SELECT $1, $2, $3, user_type_id FROM user_types WHERE type_name = $4
         RETURNING user_id, name, email, user_type_id, created_at`,
        [name, email.toLowerCase(), hash, role],
      );
      if (!rows[0]) throw new Error(`user type "${role}" missing — run npm run db:migrate`);
      user = { ...rows[0], role };
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
      throw err;
    }
    const { token, expiresAt } = await createSession(db, config, user.user_id);
    res.cookie(COOKIE_NAME, token, cookieOptions(config, expiresAt));
    res.status(201).json({ user: publicUser(user), token, expires_at: expiresAt });
  });

  r.post('/login', limiter, async (req, res) => {
    const b = req.body || {};
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || !b.email || !b.password) {
      throw new HttpError(400, 'Email and password are required');
    }
    const { rows } = await db.query(
      `SELECT u.user_id, u.name, u.email, u.user_type_id, u.created_at, u.password_hash, ut.type_name AS role
         FROM users u JOIN user_types ut ON ut.user_type_id = u.user_type_id WHERE u.email = $1`,
      [b.email.trim().toLowerCase().slice(0, 255)],
    );
    const ok = await verifyPassword(b.password.slice(0, 128), rows[0]?.password_hash);
    if (!rows[0] || !ok) throw new HttpError(401, 'Invalid email or password');
    const { token, expiresAt } = await createSession(db, config, rows[0].user_id);
    res.cookie(COOKIE_NAME, token, cookieOptions(config, expiresAt));
    res.json({ user: publicUser(rows[0]), token, expires_at: expiresAt });
  });

  r.post('/logout', requireAuth, async (req, res) => {
    await revokeSession(db, req.sessionId);
    res.clearCookie(COOKIE_NAME, cookieOptions(config));
    res.json({ ok: true });
  });

  return r;
}
