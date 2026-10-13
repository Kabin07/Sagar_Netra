import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authenticate } from './auth/middleware.js';
import { errorHandler } from './errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { metaRouter } from './routes/meta.js';
import { reportsRouter } from './routes/reports.js';
import { filesRouter } from './routes/files.js';

/**
 * Build the Express app from already-constructed dependencies so tests can create
 * several app instances (e.g. to simulate a backend restart) against one database.
 */
export function createApp({ config, db, storage, inference, reports }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // The existing frontends are single-file pages with inline <script>/<style>.
        'script-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        'img-src': ["'self'", 'data:', 'blob:', 'https://unpkg.com',
          'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'upgrade-insecure-requests': null, // allow plain-HTTP LAN demos
      },
    },
    crossOriginEmbedderPolicy: false,
    // OpenStreetMap blocks tile requests that carry no Referer (tile usage policy), which
    // Helmet's default "no-referrer" causes. Send only the origin to other sites.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  if (config.clientOrigins.length) {
    // Only needed when a frontend is served from a different origin than this API.
    app.use('/api', cors({ origin: config.clientOrigins, credentials: true }));
  }
  if (config.logRequests) {
    app.use('/api', (req, res, next) => {
      const t0 = Date.now();
      res.on('finish', () => console.log(`[api] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`));
      next();
    });
  }
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: config.apiRateLimit, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', authenticate({ db, config }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use('/api', metaRouter({ db, inference }));
  app.use('/api/auth', authRouter({ db, config }));
  app.use('/api/users', usersRouter({ db, config }));
  app.use('/api/reports', reportsRouter({ reports, config }));
  app.use('/api', filesRouter({ reports, storage }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (config.serveFrontend && fs.existsSync(config.frontendDir)) {
    // The portal chooser / sign-in page is the entry point of the site.
    app.get('/', (_req, res) => res.redirect(302, '/login/'));
    app.use(express.static(config.frontendDir, { index: 'index.html', extensions: ['html'] }));
  }

  app.use(errorHandler);
  return app;
}

export function frontendExists(config) {
  return fs.existsSync(path.join(config.frontendDir, 'professional', 'index.html'));
}
