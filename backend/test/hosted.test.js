// Simulates the Supabase permission model on a local PostgreSQL:
//   * `anon` / `authenticated` roles used by Supabase's public REST/GraphQL API, with the
//     same default grants Supabase applies to tables created in `public`;
//   * the app connecting as a NON-superuser table owner (like Supabase's `postgres` role).
// Verifies that after migrations the API roles cannot read anything (incl. password
// hashes) while the backend itself keeps full functionality.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { NET_IMAGE, buildApp, hasDemoImages, startPostgres, tmpDir } from './helpers.js';

let server; let admin; let app; let uploadDir; let ownerUrl;

before(async () => {
  server = await startPostgres();
  const superUrl = new URL(server.url);
  admin = new pg.Client({ connectionString: superUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
                     CREATE ROLE app_owner LOGIN PASSWORD 'owner-pass-123' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);
  await admin.query(`CREATE DATABASE hosted_sim_test OWNER app_owner ENCODING 'UTF8' TEMPLATE template0`);
  await admin.end();

  superUrl.pathname = '/hosted_sim_test';
  admin = new pg.Client({ connectionString: superUrl.toString() });
  await admin.connect();
  // What Supabase does for the public schema
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;`);

  ownerUrl = new URL(superUrl.toString());
  ownerUrl.username = 'app_owner';
  ownerUrl.password = 'owner-pass-123';
  uploadDir = tmpDir('sn-hosted-');
  // inference deliberately unreachable: this suite is about database permissions
  app = await buildApp({ dbUrl: ownerUrl.toString(), inference: { url: 'http://127.0.0.1:9', token: 'x'.repeat(32) }, uploadDir });
});

after(async () => {
  await app?.close();
  await admin?.end().catch(() => {});
  await server?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

async function asRole(role, sql) {
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL ROLE ${role}`);
    return await admin.query(sql);
  } finally {
    await admin.query('ROLLBACK');
  }
}

describe('hosted (Supabase-style) database permissions', () => {
  it('migrations succeed as a non-superuser owner and the API works normally', async () => {
    const agent = request.agent(app.app);
    const reg = await agent.post('/api/auth/register').send({ name: 'Hosted User', email: 'hosted@example.org', password: 'correct horse battery' });
    assert.equal(reg.status, 201);
    assert.equal((await agent.get('/api/users/me')).status, 200);
    if (hasDemoImages()) {
      const r = await agent.post('/api/reports').field('latitude', '10').field('longitude', '76').attach('images', NET_IMAGE);
      assert.equal(r.status, 201);
      assert.equal(r.body.inference.status, 'failed'); // honest failure, nothing fabricated
    }
    assert.equal((await agent.get('/api/reports')).status, 200);
  });

  it('enables row level security on every application table', async () => {
    const { rows } = await admin.query(`SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    assert.ok(rows.length >= 8);
    for (const r of rows) assert.equal(r.relrowsecurity, true, r.relname);
  });

  for (const role of ['anon', 'authenticated']) {
    it(`${role} cannot read users, password hashes, reports or detections`, async () => {
      for (const table of ['users', 'user_sessions', 'reports', 'report_images', 'debris']) {
        await assert.rejects(asRole(role, `SELECT * FROM public.${table}`), /permission denied/, `${role} → ${table}`);
      }
      await assert.rejects(asRole(role, `INSERT INTO public.user_types(type_name) VALUES ('hacker')`), /permission denied/);
    });

    it(`${role} cannot read the monitoring views`, async () => {
      await assert.rejects(asRole(role, 'SELECT * FROM monitoring.users_overview'), /permission denied/);
    });
  }

  it('monitoring views summarise the data without exposing secrets', async () => {
    const { rows: [s] } = await admin.query('SELECT * FROM monitoring.system_summary');
    assert.equal(Number(s.users), 1);
    const { rows: users, fields } = await admin.query('SELECT * FROM monitoring.users_overview');
    assert.equal(users[0].email, 'hosted@example.org');
    assert.equal(fields.some((f) => /password|hash|session_id/.test(f.name)), false);
    const { rows: types } = await admin.query('SELECT * FROM monitoring.debris_type_counts');
    assert.equal(types.length, 22);
    if (hasDemoImages()) {
      const { rows: failures } = await admin.query('SELECT * FROM monitoring.inference_failures');
      assert.equal(failures.length, 1);
    }
  });
});
