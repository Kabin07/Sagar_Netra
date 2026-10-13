import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

const num = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric config value: ${v}`);
  return n;
};
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes)$/i.test(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const resolveFrom = (base, p) => (path.isAbsolute(p) ? p : path.resolve(base, p));

/**
 * Build the runtime configuration. `overrides` lets tests inject values without
 * touching process.env; everything else comes from backend/.env or the environment.
 */
export function loadConfig(overrides = {}) {
  dotenv.config({ path: path.join(BACKEND_ROOT, '.env'), quiet: true });
  const env = { ...process.env, ...overrides };

  const config = {
    env: env.NODE_ENV || 'development',
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 4000),
    trustProxy: num(env.TRUST_PROXY, 0),
    databaseUrl: env.DATABASE_URL,
    pgSsl: bool(env.PGSSL, false),
    // CA bundle used to verify the server certificate (Supabase: Dashboard → Database → SSL → download).
    pgSslCa: env.PGSSL_CA ? resolveFrom(BACKEND_ROOT, env.PGSSL_CA) : null,
    // Only set false as a last resort: traffic stays encrypted but the server is not authenticated.
    pgSslRejectUnauthorized: bool(env.PGSSL_REJECT_UNAUTHORIZED, true),
    pgPoolMax: num(env.PG_POOL_MAX, 10),
    jwtSecret: env.JWT_SECRET,
    sessionHours: num(env.SESSION_HOURS, 8),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    clientOrigins: list(env.CLIENT_ORIGINS),
    serveFrontend: bool(env.SERVE_FRONTEND, true),
    frontendDir: resolveFrom(BACKEND_ROOT, env.FRONTEND_DIR || '../frontend'),
    storageDriver: env.STORAGE_DRIVER || 'local',
    uploadDir: resolveFrom(BACKEND_ROOT, env.UPLOAD_DIR || './storage'),
    maxUploadMb: num(env.MAX_UPLOAD_MB, 15),
    maxFilesPerReport: num(env.MAX_FILES_PER_REPORT, 10),
    inferenceUrl: (env.INFERENCE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
    inferenceToken: env.INFERENCE_TOKEN || '',
    inferenceTimeoutMs: num(env.INFERENCE_TIMEOUT_MS, 120000),
    inferenceConf: num(env.INFERENCE_CONF, 0.25),
    inferenceImgsz: env.INFERENCE_IMGSZ ? num(env.INFERENCE_IMGSZ) : null, // null = model's training size
    authRateLimit: num(env.AUTH_RATE_LIMIT, 20),         // per IP per 15 min
    apiRateLimit: num(env.API_RATE_LIMIT, 1000),         // per IP per 15 min
    reportRateLimit: num(env.REPORT_RATE_LIMIT, 60),     // report submissions per IP per 15 min
    logRequests: bool(env.LOG_REQUESTS, env.NODE_ENV !== 'test'),
  };
  return config;
}

export function validateConfig(config) {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (!config.jwtSecret || config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 random characters');
  if (!config.inferenceToken || config.inferenceToken.length < 24) problems.push('INFERENCE_TOKEN must be at least 24 random characters (and match SN_INFERENCE_TOKEN of the inference service)');
  if (config.inferenceConf < 0.01 || config.inferenceConf > 0.95) problems.push('INFERENCE_CONF must be between 0.01 and 0.95');
  if (config.maxFilesPerReport < 1 || config.maxFilesPerReport > 50) problems.push('MAX_FILES_PER_REPORT must be 1-50');
  return problems;
}
