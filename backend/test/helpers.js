// Test harness: real PostgreSQL + real Python inference service + real app.
//
// PostgreSQL:  TEST_DATABASE_URL (database name must contain "test"; its public schema
//              is DROPPED and recreated) — or, if unset, a throwaway embedded-postgres
//              cluster in backend/.test-pgdata.
// Inference:   TEST_INFERENCE_URL + TEST_INFERENCE_TOKEN for an already running
//              service — or, if unset, inference/service.py is spawned with $PYTHON
//              (default "python") on a free port with a random token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { BACKEND_ROOT, REPO_ROOT, loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';

export const DEMO_DIR = path.join(REPO_ROOT, 'demo_inputs_net');
export const NET_IMAGE = path.join(DEMO_DIR, 'vid_000052_frame0000082.jpg');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

export async function startPostgres() {
  if (process.env.TEST_DATABASE_URL) {
    const url = process.env.TEST_DATABASE_URL;
    if (!/test/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL database name must contain "test" (its schema is wiped)');
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS monitoring CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
    return { url, stop: async () => {} };
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = path.join(BACKEND_ROOT, '.test-pgdata', String(process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
  const port = await freePort();
  const password = crypto.randomBytes(12).toString('hex');
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: false, onLog: () => {},
    initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  await server.initialise();
  await server.start();
  await server.createDatabase('sagar_netra_test');
  return {
    url: `postgresql://postgres:${password}@127.0.0.1:${port}/sagar_netra_test`,
    stop: async () => {
      await server.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startInference() {
  if (process.env.TEST_INFERENCE_URL) {
    return { url: process.env.TEST_INFERENCE_URL, token: process.env.TEST_INFERENCE_TOKEN, stop: async () => {} };
  }
  const port = await freePort();
  const token = crypto.randomBytes(24).toString('hex');
  const child = spawn(process.env.PYTHON || 'python', [path.join(REPO_ROOT, 'inference', 'service.py')], {
    cwd: REPO_ROOT,
    env: { ...process.env, SN_INFERENCE_TOKEN: token, SN_INFERENCE_PORT: String(port), SN_INFERENCE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`inference service exited early:\n${log}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200) break;
      if (res.status === 503) throw new Error(`inference model failed to load:\n${JSON.stringify(await res.json())}`);
    } catch (err) {
      if (err.message.startsWith('inference model')) throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (Date.now() >= deadline) throw new Error(`inference service did not become healthy:\n${log}`);
  return {
    url,
    token,
    log: () => log,
    stop: async () => {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    },
  };
}

/** Build a fresh app (new pool, new services) — calling it twice simulates a restart. */
export async function buildApp({ dbUrl, inference, uploadDir, overrides = {} }) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    JWT_SECRET: 'test-secret-'.padEnd(48, 'x'),
    INFERENCE_URL: inference.url,
    INFERENCE_TOKEN: inference.token,
    UPLOAD_DIR: uploadDir,
    AUTH_RATE_LIMIT: '1000',
    REPORT_RATE_LIMIT: '1000',
    LOG_REQUESTS: 'false',
    CLIENT_ORIGINS: '',
    ...overrides,
  });
  const ctx = await createContext(config);
  await migrate(ctx.db, { log: () => {} });
  return { ...ctx, app: createApp(ctx) };
}

export const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const hasDemoImages = () => fs.existsSync(NET_IMAGE);
