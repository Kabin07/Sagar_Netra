import { badRequest } from './errors.js';

/** Collects field errors so the client sees every problem at once. */
export class Checker {
  constructor() { this.errors = {}; }
  fail(field, msg) { if (!this.errors[field]) this.errors[field] = msg; return undefined; }
  throwIfAny(message = 'Validation failed') {
    if (Object.keys(this.errors).length) throw badRequest(message, this.errors);
  }

  string(field, v, { required = false, min = 0, max = 1000, trim = true, pattern } = {}) {
    if (v === undefined || v === null || v === '') {
      return required ? this.fail(field, 'is required') : null;
    }
    if (typeof v !== 'string') return this.fail(field, 'must be a string');
    const s = trim ? v.trim() : v;
    if (required && !s) return this.fail(field, 'is required');
    if (s.length < min) return this.fail(field, `must be at least ${min} characters`);
    if (s.length > max) return this.fail(field, `must be at most ${max} characters`);
    if (pattern && !pattern.test(s)) return this.fail(field, 'has an invalid format');
    return s || null;
  }

  /** Accepts numbers or numeric strings (multipart forms send strings). */
  number(field, v, { required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return required ? this.fail(field, 'is required') : null;
    }
    if (typeof v !== 'number' && typeof v !== 'string') return this.fail(field, 'must be a number');
    const n = Number(v);
    if (!Number.isFinite(n)) return this.fail(field, 'must be a finite number');
    if (integer && !Number.isInteger(n)) return this.fail(field, 'must be an integer');
    if (n < min || n > max) return this.fail(field, `must be between ${min} and ${max}`);
    return n;
  }

  oneOf(field, v, allowed, { required = false, fallback = null } = {}) {
    if (v === undefined || v === null || v === '') return required ? this.fail(field, 'is required') : fallback;
    if (!allowed.includes(v)) return this.fail(field, `must be one of: ${allowed.join(', ')}`);
    return v;
  }

  date(field, v, { required = false, maxFutureMs = 24 * 3600 * 1000 } = {}) {
    if (v === undefined || v === null || v === '') return required ? this.fail(field, 'is required') : null;
    if (typeof v !== 'string') return this.fail(field, 'must be an ISO-8601 date string');
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return this.fail(field, 'must be an ISO-8601 date string');
    if (d.getTime() > Date.now() + maxFutureMs) return this.fail(field, 'cannot be in the future');
    if (d.getUTCFullYear() < 1950) return this.fail(field, 'is implausibly old');
    return d;
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseId(v, name = 'id') {
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) throw badRequest(`Invalid ${name}`);
  return Number(v);
}

/** Latitude/longitude validation shared by create and update. */
export function checkCoordinates(c, lat, lng, { required = true } = {}) {
  return {
    lat: c.number('latitude', lat, { required, min: -90, max: 90 }),
    lng: c.number('longitude', lng, { required, min: -180, max: 180 }),
  };
}
