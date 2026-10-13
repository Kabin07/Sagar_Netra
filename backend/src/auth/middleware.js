import { COOKIE_NAME, resolveToken } from './sessions.js';
import { HttpError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Accepts the session cookie (browser frontends) or an `Authorization: Bearer`
 * header (API clients). Sets req.user = { user_id, role, ... } when valid.
 */
export function authenticate({ db, config }) {
  return async (req, _res, next) => {
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const cookie = req.cookies?.[COOKIE_NAME];
    const token = bearer || cookie;
    req.user = null;
    if (!token) return next();

    // CSRF defence-in-depth for cookie sessions (the cookie is already SameSite=Strict):
    // a state-changing request carrying an Origin header must come from an allowed origin.
    if (!bearer && !SAFE_METHODS.has(req.method)) {
      const origin = req.get('origin');
      if (origin && !isAllowedOrigin(origin, req, config)) {
        return next(new HttpError(403, 'Cross-origin request rejected'));
      }
    }
    try {
      const user = await resolveToken(db, config, token);
      if (user) {
        req.user = user;
        req.sessionId = user.session_id;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function isAllowedOrigin(origin, req, config) {
  if (config.clientOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Insufficient permissions'));
  next();
};

export const isAdmin = (user) => user?.role === 'admin';
