// Apply pending SQL migrations (schema + idempotent seed data).
//   npm run db:migrate
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set (backend/.env)');
  process.exit(1);
}
const pool = createPool(config);
try {
  await migrate(pool);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM debris_types');
  console.log(`[migrate] debris_types rows: ${rows[0].n}`);
} catch (err) {
  console.error(`[migrate] ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
