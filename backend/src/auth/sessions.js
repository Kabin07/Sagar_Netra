import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export const COOKIE_NAME = 'sn_session';
const BCRYPT_COST = 12;
// Used when the email is unknown so login time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', BCRYPT_COST);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);
export const verifyPassword = (password, hash) => bcrypt.compare(password, hash || DUMMY_HASH);

/** Create a server-side session row and the signed JWT that references it. */
export async function createSession(db, config, userId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.sessionHours * 3600 * 1000);
  await db.query('INSERT INTO user_sessions(session_id, user_id, expires_at) VALUES ($1, $2, $3)', [sessionId, userId, expiresAt]);
  const token = jwt.sign({ sid: sessionId }, config.jwtSecret, {
    subject: String(userId),
    algorithm: 'HS256',
    expiresIn: Math.floor(config.sessionHours * 3600),
  });
  return { token, expiresAt };
}

export function cookieOptions(config, expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/** Resolve a token to the active user, or null if invalid / expired / revoked. */
export async function resolveToken(db, config, token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  if (!payload?.sid || !payload?.sub) return null;
  const { rows } = await db.query(
    `SELECT u.user_id, u.name, u.email, u.user_type_id, u.created_at, ut.type_name AS role, s.session_id
       FROM user_sessions s
       JOIN users u       ON u.user_id = s.user_id
       JOIN user_types ut ON ut.user_type_id = u.user_type_id
      WHERE s.session_id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [payload.sid, payload.sub],
  );
  return rows[0] || null;
}

export async function revokeSession(db, sessionId) {
  await db.query('UPDATE user_sessions SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
}

export const publicUser = (u) => ({
  user_id: u.user_id,
  name: u.name,
  email: u.email,
  user_type_id: u.user_type_id,
  role: u.role,
  created_at: u.created_at,
});
