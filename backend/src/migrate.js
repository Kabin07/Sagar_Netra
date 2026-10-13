import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKEND_ROOT } from './config.js';

export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'db', 'migrations');
const LOCK_KEY = 74_201_337; // arbitrary constant for pg_advisory_lock

/**
 * Apply every db/migrations/NNN_*.sql file that has not been applied yet, each in
 * its own transaction. Re-running is a no-op. A migration whose file content changed
 * after being applied is reported as an error instead of being silently skipped.
 */
export async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [enc] } = await client.query(
      `SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()`,
    );
    if (enc.encoding !== 'UTF8') {
      throw new Error(`Database encoding is ${enc.encoding}; SAGAR-NETRA needs UTF8 (comments may be in Tamil, Hindi, Malayalam). `
        + `Recreate it with: CREATE DATABASE <name> ENCODING 'UTF8' TEMPLATE template0;`);
    }
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const ran = [];
    for (const file of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      ran.push(file);
      log(`[migrate] applied ${file}`);
    }
    if (!ran.length) log('[migrate] database schema is up to date');
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
