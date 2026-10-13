import fs from 'node:fs';
import pg from 'pg';

// BIGINT ids come back as strings by default; they fit safely in a JS number here.
pg.types.setTypeParser(20, (v) => Number(v));

/** TLS options for hosted PostgreSQL (Supabase, RDS, ...). Undefined = plain local connection. */
export function sslOptions(config) {
  if (!config.pgSsl) return undefined;
  const ssl = { rejectUnauthorized: config.pgSslRejectUnauthorized };
  if (config.pgSslCa) {
    if (!fs.existsSync(config.pgSslCa)) throw new Error(`PGSSL_CA file not found: ${config.pgSslCa}`);
    ssl.ca = fs.readFileSync(config.pgSslCa, 'utf8');
  }
  return ssl;
}

/**
 * node-postgres lets ?sslmode=... in the URL REPLACE the ssl object, which would
 * silently drop the CA / verification settings above, so TLS is configured only via
 * PGSSL* variables and any sslmode-style parameters are removed from the URL.
 */
export function connectionString(config) {
  if (!config.pgSsl) return config.databaseUrl;
  const u = new URL(config.databaseUrl);
  for (const p of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(p);
  return u.toString();
}

export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: connectionString(config),
    ssl: sslOptions(config),
    max: config.pgPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

/** Run `fn(client)` inside a transaction; rolls back on any thrown error. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
