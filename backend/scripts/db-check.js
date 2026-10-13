// Verify database connectivity and schema state for the configured DATABASE_URL.
//   npm run db:check              read-only checks
//   npm run db:check -- --migrate apply pending migrations first
//
// Prints host (never the password), TLS status, server version, encoding, applied
// migrations, ER table row counts, class seed integrity, and — on Supabase — whether
// the public REST API roles are locked out of the application tables.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set in backend/.env');
  process.exit(1);
}
const url = new URL(config.databaseUrl);
if (url.password && /YOUR-PASSWORD|CHANGE_ME/i.test(decodeURIComponent(url.password))) {
  console.error('DATABASE_URL still contains a placeholder password — put the real database password in backend/.env');
  process.exit(1);
}
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { console.log(`  ✖ ${m}`); process.exitCode = 1; };

console.log(`Database: ${url.username}@${url.hostname}:${url.port || 5432}${url.pathname}`);
if (/^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname)) {
  console.log('  ! This is Supabase\'s DIRECT host, which is IPv6-only. If the connection times out, use the');
  console.log('    "Session pooler" connection string (Dashboard → Connect), e.g. aws-0-<region>.pooler.supabase.com:5432');
}
if (/pooler\.supabase\.com$/.test(url.hostname) && url.port === '6543') {
  console.log('  ! Port 6543 is the TRANSACTION pooler; use the SESSION pooler (port 5432) — migrations need session features.');
}

const pool = createPool(config);
try {
  const t0 = Date.now();
  const { rows: [info] } = await pool.query(
    `SELECT version() AS version, current_database() AS db, current_user AS usr,
            pg_encoding_to_char(d.encoding) AS encoding
       FROM pg_database d WHERE d.datname = current_database()`,
  );
  // Check TLS on OUR socket: behind a pooler (Supabase/Supavisor) TLS ends at the pooler,
  // so the server-side pg_stat_ssl view cannot tell whether this hop is encrypted.
  const probe = await pool.connect();
  info.ssl = Boolean(probe.connection?.stream?.encrypted);
  info.verified = info.ssl ? probe.connection.stream.authorized === true : false;
  probe.release();
  ok(`connected in ${Date.now() - t0} ms as ${info.usr} → ${info.version.split(',')[0]}`);
  info.ssl ? ok(`connection to ${url.hostname} is TLS-encrypted${info.verified ? ' and the server certificate is verified' : ' (certificate NOT verified)'}`) : (config.pgSsl ? bad('PGSSL=true but the connection is not encrypted')
    : /^(127\.0\.0\.1|localhost|::1)$/.test(url.hostname) ? console.log('  · TLS off (fine for a local server)')
    : bad(`UNENCRYPTED connection to remote host ${url.hostname} — set PGSSL=true (and PGSSL_CA) in backend/.env`));
  if (config.pgSsl && !config.pgSslRejectUnauthorized) console.log('  ! PGSSL_REJECT_UNAUTHORIZED=false — server certificate is NOT verified; set PGSSL_CA instead');
  info.encoding === 'UTF8' ? ok('database encoding UTF8') : bad(`database encoding ${info.encoding} (must be UTF8)`);

  if (process.argv.includes('--migrate')) await migrate(pool);

  const files = fs.readdirSync(path.join(REPO_ROOT, 'backend', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const hasTable = (await pool.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
  const applied = hasTable ? (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version) : [];
  const pending = files.filter((f) => !applied.includes(f));
  pending.length ? bad(`pending migrations: ${pending.join(', ')} — run: npm run db:check -- --migrate (or npm start)`) : ok(`all ${files.length} migrations applied`);

  if (!pending.length) {
    const counts = (await pool.query(`SELECT
        (SELECT count(*) FROM user_types)::int AS user_types, (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM reports)::int AS reports, (SELECT count(*) FROM report_images)::int AS report_images,
        (SELECT count(*) FROM debris_types)::int AS debris_types, (SELECT count(*) FROM debris)::int AS debris`)).rows[0];
    ok(`ER tables: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);

    const expected = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'inference', 'classes.json'), 'utf8'));
    const seeded = (await pool.query('SELECT type_name FROM debris_types ORDER BY class_index')).rows.map((r) => r.type_name);
    JSON.stringify(seeded) === JSON.stringify(expected) ? ok('22 model classes seeded in model index order') : bad('debris_types does not match inference/classes.json');

    const rls = (await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`)).rows.map((r) => r.relname);
    rls.length ? bad(`RLS disabled on: ${rls.join(', ')}`) : ok('row level security enabled on every public table');

    const apiRoles = (await pool.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')`)).rows.map((r) => r.rolname);
    if (apiRoles.length) {
      const leaks = (await pool.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee IN ('anon','authenticated') AND table_schema IN ('public','monitoring')`)).rows;
      leaks.length ? bad(`REST API roles still have privileges: ${leaks.slice(0, 5).map((l) => `${l.grantee}:${l.table_name}:${l.privilege_type}`).join(', ')}`)
        : ok('Supabase REST roles (anon/authenticated) have no access to application tables or monitoring views');
    }
    const summary = (await pool.query('SELECT * FROM monitoring.system_summary')).rows[0];
    ok(`monitoring views readable: ${summary.users} users, ${summary.reports} reports, ${summary.detections} detections`);
  }
} catch (err) {
  bad(`database check failed: ${err.message}`);
  if (/self-signed certificate|unable to get local issuer/i.test(err.message)) {
    console.log('    → download the server CA (Supabase: Dashboard → Project Settings → Database → SSL Configuration),');
    console.log('      save it as backend/certs/supabase-ca.crt and set PGSSL_CA=./certs/supabase-ca.crt');
  } else if (/ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|timeout/i.test(err.message)) {
    console.log('    → host unreachable: for Supabase use the Session pooler connection string (IPv4)');
  } else if (/password authentication failed|Tenant or user not found/i.test(err.message)) {
    console.log('    → wrong password or user. With the pooler the user is postgres.<project-ref>');
  }
} finally {
  await pool.end();
}
