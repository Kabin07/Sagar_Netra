// Run a real PostgreSQL 17 server for local development WITHOUT a system install,
// using the `embedded-postgres` package (official PostgreSQL binaries from npm).
//
//   npm run db:local            # keeps running; Ctrl+C to stop
//
// Data lives in backend/.pgdata (git-ignored). On first run a random password is
// generated and printed together with the DATABASE_URL to put in backend/.env.
// A system PostgreSQL install works just as well — this is only a convenience.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKEND_ROOT } from '../src/config.js';

const dataDir = path.join(BACKEND_ROOT, '.pgdata', 'cluster');
const secretFile = path.join(BACKEND_ROOT, '.pgdata', 'password.txt');
const port = Number(process.env.LOCAL_PG_PORT || 5433);
const dbName = process.env.LOCAL_PG_DB || 'sagar_netra';

let EmbeddedPostgres;
try {
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
} catch {
  console.error('embedded-postgres is not installed. Run `npm install` (dev dependencies) or install PostgreSQL normally.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(secretFile), { recursive: true });
const firstRun = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
let password;
if (fs.existsSync(secretFile)) password = fs.readFileSync(secretFile, 'utf8').trim();
else {
  password = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(secretFile, password, { mode: 0o600 });
}

const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password, port, persistent: true, onLog: () => {},
  initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (firstRun) await pg.initialise();
await pg.start();
if (firstRun) await pg.createDatabase(dbName);

console.log(`PostgreSQL running on 127.0.0.1:${port} (data: ${dataDir})`);
console.log(`DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/${dbName}`);
console.log('Press Ctrl+C to stop.');

const stop = async () => { await pg.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
