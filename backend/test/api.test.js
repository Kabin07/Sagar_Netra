import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { REPO_ROOT } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import {
  DEMO_DIR, NET_IMAGE, buildApp, hasDemoImages, startInference, startPostgres, tmpDir,
} from './helpers.js';

const EXPECTED_CLASSES = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'inference', 'classes.json'), 'utf8'));
const PASSWORD = 'correct horse battery';

let pgServer; let inference; let main; let uploadDir;
let alice; let bob; let admin; // supertest agents (cookie sessions)
const users = {};

async function register(app, name, email, extra = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({ name, email, password: PASSWORD, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { agent, user: res.body.user, token: res.body.token };
}

function submit(agent, { images = [NET_IMAGE], fields = {} } = {}) {
  let req = agent.post('/api/reports')
    .field('latitude', '13.0827')
    .field('longitude', '80.2707');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  for (const img of images) {
    req = typeof img === 'string' ? req.attach('images', img) : req.attach('images', img.buffer, { filename: img.filename, contentType: img.contentType });
  }
  return req;
}

before(async () => {
  pgServer = await startPostgres();
  inference = await startInference();
  uploadDir = tmpDir('sn-uploads-');
  main = await buildApp({ dbUrl: pgServer.url, inference, uploadDir });
  ({ agent: alice, user: users.alice } = await register(main.app, 'Alice Diver', 'alice@example.org'));
  ({ agent: bob, user: users.bob } = await register(main.app, 'Bob Diver', 'bob@example.org'));
  ({ agent: admin, user: users.admin } = await register(main.app, 'Ada Admin', 'ada@example.org'));
  // Promotion happens out-of-band (as `npm run admin:create -- --promote` does), never via public API.
  await main.db.query(`UPDATE users SET user_type_id = (SELECT user_type_id FROM user_types WHERE type_name='admin') WHERE user_id=$1`, [users.admin.user_id]);
});

after(async () => {
  await main?.close();
  await inference?.stop();
  await pgServer?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('1. database connection and schema initialisation', () => {
  it('reports a connected database and a loaded model through /api/health', async () => {
    const res = await request(main.app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.database, 'connected');
    assert.equal(res.body.inference.model_loaded, true);
    assert.equal(res.body.inference.num_classes, 22);
  });

  it('creates every ER table plus extensions', async () => {
    const { rows } = await main.db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const names = rows.map((r) => r.table_name);
    for (const t of ['user_types', 'users', 'reports', 'debris_types', 'debris', 'report_images', 'user_sessions', 'schema_migrations']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });

  it('seeds exactly the 22 model classes in model index order, and re-running migrations adds no duplicates', async () => {
    const applied = await migrate(main.db, { log: () => {} });
    assert.deepEqual(applied, []);
    const { rows } = await main.db.query('SELECT type_name, class_index FROM debris_types ORDER BY class_index');
    assert.equal(rows.length, 22);
    assert.deepEqual(rows.map((r) => r.type_name), EXPECTED_CLASSES);
    rows.forEach((r, i) => assert.equal(r.class_index, i));
    const { rows: types } = await main.db.query('SELECT type_name FROM user_types ORDER BY type_name');
    assert.deepEqual(types.map((t) => t.type_name), ['admin', 'citizen', 'diver', 'researcher']);
    const res = await request(main.app).get('/api/debris-types');
    assert.equal(res.body.debris_types.length, 22);
  });

  it('opens the portal chooser / sign-in page as the site entry point', async () => {
    const res = await request(main.app).get('/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login/');
    const page = await request(main.app).get('/login/');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-portal="citizen"/);
  });

  it('enforces coordinate ranges at the database level too', async () => {
    await assert.rejects(
      main.db.query('INSERT INTO reports (reported_by, report_lat, report_long) VALUES ($1, 95, 0)', [users.alice.user_id]),
      /check constraint/,
    );
  });
});

describe('2-3. registration, login, password hashing, logout', () => {
  it('registers with the default diver role and never returns the password hash', async () => {
    const { user } = await register(main.app, 'Carol', 'Carol@Example.org');
    assert.equal(user.role, 'diver');
    assert.equal(user.email, 'carol@example.org');
    assert.equal(JSON.stringify(user).includes('password'), false);
  });

  it('stores a bcrypt hash, not the password', async () => {
    const { rows: [u] } = await main.db.query('SELECT password_hash FROM users WHERE email = $1', ['alice@example.org']);
    assert.match(u.password_hash, /^\$2[aby]\$12\$/);
    assert.notEqual(u.password_hash, PASSWORD);
    assert.equal(await bcrypt.compare(PASSWORD, u.password_hash), true);
  });

  it('rejects weak input and duplicate emails', async () => {
    const r1 = await request(main.app).post('/api/auth/register').send({ name: 'X', email: 'bad', password: 'short' });
    assert.equal(r1.status, 400);
    assert.ok(r1.body.details.email && r1.body.details.password && r1.body.details.name);
    const r2 = await request(main.app).post('/api/auth/register').send({ name: 'Alice 2', email: 'ALICE@example.org', password: PASSWORD });
    assert.equal(r2.status, 409);
  });

  it('logs in with correct credentials only', async () => {
    const ok = await request(main.app).post('/api/auth/login').send({ email: 'alice@example.org', password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers['set-cookie'].some((c) => /sn_session=.+HttpOnly/i.test(c) && /SameSite=Strict/i.test(c)));
    assert.equal(ok.body.user.password_hash, undefined);
    const bad = await request(main.app).post('/api/auth/login').send({ email: 'alice@example.org', password: 'wrong password!!' });
    assert.equal(bad.status, 401);
    const unknown = await request(main.app).post('/api/auth/login').send({ email: 'nobody@example.org', password: PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(bad.body.error, unknown.body.error); // no account enumeration
  });

  it('returns the current user and revokes the session on logout', async () => {
    const { agent, token } = await register(main.app, 'Dan', 'dan@example.org');
    assert.equal((await agent.get('/api/users/me')).body.user.email, 'dan@example.org');
    assert.equal((await request(main.app).get('/api/users/me').set('Authorization', `Bearer ${token}`)).status, 200);
    assert.equal((await agent.post('/api/auth/logout')).status, 200);
    assert.equal((await agent.get('/api/users/me')).status, 401);
    // the same JWT is dead server-side, even if someone kept a copy
    assert.equal((await request(main.app).get('/api/users/me').set('Authorization', `Bearer ${token}`)).status, 401);
  });

  it('lets a signed-in user change their own password (current password required)', async () => {
    const { agent } = await register(main.app, 'Pat Password', 'pat@example.org');
    const other = request.agent(main.app);
    await other.post('/api/auth/login').send({ email: 'pat@example.org', password: PASSWORD }).expect(200);
    assert.equal((await request(main.app).post('/api/users/me/password').send({ current_password: PASSWORD, new_password: 'brand new password 1' })).status, 401);
    assert.equal((await agent.post('/api/users/me/password').send({ current_password: 'wrong password!!', new_password: 'brand new password 1' })).status, 403);
    assert.equal((await agent.post('/api/users/me/password').send({ current_password: PASSWORD, new_password: 'short' })).status, 400);
    const ok = await agent.post('/api/users/me/password').send({ current_password: PASSWORD, new_password: 'brand new password 1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.other_sessions_signed_out, 1);
    assert.equal((await agent.get('/api/users/me')).status, 200, 'current session stays signed in');
    assert.equal((await other.get('/api/users/me')).status, 401, 'other sessions are signed out');
    assert.equal((await request(main.app).post('/api/auth/login').send({ email: 'pat@example.org', password: PASSWORD })).status, 401);
    assert.equal((await request(main.app).post('/api/auth/login').send({ email: 'pat@example.org', password: 'brand new password 1' })).status, 200);
  });

  it('rate-limits authentication routes', async () => {
    const limited = await buildApp({ dbUrl: pgServer.url, inference, uploadDir, overrides: { AUTH_RATE_LIMIT: '3' } });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await request(limited.app).post('/api/auth/login').send({ email: 'x@example.org', password: 'whatever123' })).status);
      }
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('4. no self-assigned admin role; RBAC', () => {
  it('refuses admin at registration and creates no account', async () => {
    const res = await request(main.app).post('/api/auth/register').send({ name: 'Mallory', email: 'mallory@example.org', password: PASSWORD, role: 'admin' });
    assert.equal(res.status, 403);
    const { rows } = await main.db.query('SELECT 1 FROM users WHERE email = $1', ['mallory@example.org']);
    assert.equal(rows.length, 0);
  });

  it('allows choosing a non-privileged role', async () => {
    const { user } = await register(main.app, 'Rita Researcher', 'rita@example.org', { role: 'researcher' });
    assert.equal(user.role, 'researcher');
  });

  it('only admins can change roles', async () => {
    const denied = await alice.patch(`/api/users/${users.alice.user_id}/role`).send({ role: 'admin' });
    assert.equal(denied.status, 403);
    const { user } = await register(main.app, 'Promote Me', 'promote@example.org');
    const ok = await admin.patch(`/api/users/${user.user_id}/role`).send({ role: 'researcher' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'researcher');
  });
});

describe('5. authentication is required for private endpoints', () => {
  for (const [method, url] of [
    ['get', '/api/users/me'], ['get', '/api/reports'], ['post', '/api/reports'], ['get', '/api/reports/1'],
    ['get', '/api/reports/1/detections'], ['patch', '/api/reports/1'], ['delete', '/api/reports/1'],
    ['get', '/api/reports/markers'], ['get', '/api/images/1'], ['get', '/api/debris/1/mask'], ['patch', '/api/debris/1'],
  ]) {
    it(`${method.toUpperCase()} ${url} → 401`, async () => {
      assert.equal((await request(main.app)[method](url)).status, 401);
    });
  }

  it('rejects forged tokens', async () => {
    const res = await request(main.app).get('/api/users/me').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzaWQiOiJ4In0.');
    assert.equal(res.status, 401);
  });

  it('rejects cross-origin state-changing requests made with the session cookie', async () => {
    const res = await alice.post('/api/auth/logout').set('Origin', 'https://evil.example');
    assert.equal(res.status, 403);
  });
});

describe('7. input validation', () => {
  it('rejects invalid coordinates', async () => {
    for (const [lat, lng] of [['91', '0'], ['0', '-181'], ['abc', '10'], ['', '10'], ['NaN', 'Infinity']]) {
      const res = await alice.post('/api/reports').field('latitude', lat).field('longitude', lng).attach('images', NET_IMAGE);
      assert.equal(res.status, 400, `${lat},${lng}`);
    }
    const { rows } = await main.db.query('SELECT count(*)::int AS n FROM reports');
    assert.equal(rows[0].n, 0, 'nothing persisted for invalid submissions');
  });

  it('rejects unsupported or disguised files', async () => {
    const cases = [
      { buffer: Buffer.from('this is plain text, not an image at all'), filename: 'notes.jpg', contentType: 'image/jpeg' },
      { buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00', 'binary'), filename: 'anim.gif', contentType: 'image/gif' },
      { buffer: fs.readFileSync(NET_IMAGE), filename: 'photo.png', contentType: 'image/png' }, // JPEG bytes named .png
      { buffer: fs.readFileSync(NET_IMAGE), filename: 'photo.exe', contentType: 'image/jpeg' },
    ];
    for (const c of cases) {
      const res = await submit(alice, { images: [c] });
      assert.equal(res.status, 415, `${c.filename}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await alice.post('/api/reports').field('latitude', '1').field('longitude', '1')).status, 400);
  });

  it('enforces upload size and count limits', async () => {
    const small = await buildApp({ dbUrl: pgServer.url, inference, uploadDir, overrides: { MAX_UPLOAD_MB: '0.01', MAX_FILES_PER_REPORT: '2' } });
    try {
      const { agent } = await register(small.app, 'Limits', 'limits@example.org');
      assert.equal((await submit(agent)).status, 413);
      const tiny = { buffer: fs.readFileSync(NET_IMAGE).subarray(0, 5000), filename: 'a.jpg', contentType: 'image/jpeg' };
      assert.equal((await submit(agent, { images: [tiny, tiny, tiny] })).status, 400);
    } finally {
      await small.close();
    }
  });

  it('rejects unknown detail fields and bad enum values', async () => {
    const res = await submit(alice, { fields: { details: JSON.stringify({ hacker: 1, sea_state: 'tsunami' }) } });
    assert.equal(res.status, 400);
    assert.ok(res.body.details['details.hacker'] && res.body.details['details.sea_state']);
  });
});

describe('8-13. report lifecycle with real YOLO inference', { skip: !hasDemoImages() && 'demo_inputs_net/ not present' }, () => {
  let created; let direct;

  before(async () => {
    // Ground truth: call the inference service directly with the same bytes.
    const res = await fetch(`${inference.url}/v1/segment?conf=0.25`, {
      method: 'POST', headers: { 'X-Inference-Token': inference.token }, body: fs.readFileSync(NET_IMAGE),
    });
    direct = await res.json();
    const r = await submit(alice, {
      fields: {
        site_name: 'Netrani Island, north wall',
        depth: '18.5', water_temp: '27.4', visibility: '8', position_accuracy_m: '3',
        observed_at: '2026-10-01T09:30:00.000Z', location_source: 'sensor', source_channel: 'professional',
        comments: 'Net snagged on rocks',
        details: JSON.stringify({ bottom_time_min: 34, hazards: ['marine_life_entangled'], vessel: 'MV Sagarika', sea_state: 'calm' }),
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    created = r.body;
  });

  it('9. persists the report and its metadata in PostgreSQL', async () => {
    const { rows: [row] } = await main.db.query('SELECT * FROM reports WHERE report_id = $1', [created.report.report_id]);
    assert.equal(row.reported_by, users.alice.user_id);
    assert.equal(row.report_lat, 13.0827);
    assert.equal(row.report_long, 80.2707);
    assert.equal(row.depth, 18.5);
    assert.equal(row.water_temp, 27.4);
    assert.equal(row.visibility, 8);
    assert.equal(row.site_name, 'Netrani Island, north wall');
    assert.equal(row.location_source, 'sensor');
    assert.equal(row.observed_at.toISOString(), '2026-10-01T09:30:00.000Z');
    assert.deepEqual(row.details.hazards, ['marine_life_entangled']);
    assert.equal(row.inference_status, 'completed');
    assert.equal(row.image_url, `/api/images/${created.report.images[0].image_id}`);
  });

  it('8. stores uploads under server-generated names outside the web root and serves them only to the owner', async () => {
    const { rows: [img] } = await main.db.query('SELECT storage_key FROM report_images WHERE report_id = $1', [created.report.report_id]);
    assert.match(img.storage_key, /^images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    const onDisk = path.join(uploadDir, ...img.storage_key.split('/'));
    assert.deepEqual(fs.readFileSync(onDisk), fs.readFileSync(NET_IMAGE));
    const res = await alice.get(created.report.images[0].url).buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.deepEqual(res.body, fs.readFileSync(NET_IMAGE));
    assert.equal((await bob.get(created.report.images[0].url)).status, 404);
    assert.equal((await request(main.app).get(`/storage/${img.storage_key}`)).status, 404);
  });

  it('8b. a path-traversal filename is reduced to metadata only', async () => {
    const r = await submit(alice, { images: [{ buffer: fs.readFileSync(NET_IMAGE), filename: '..\\..\\..\\evil.jpg', contentType: 'image/jpeg' }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.images[0].original_filename, 'evil.jpg');
    assert.equal(fs.existsSync(path.join(uploadDir, '..', 'evil.jpg')), false);
  });

  it('10. returns the model\'s real predictions (identical to calling the model service directly)', () => {
    const got = created.report.detections.map((d) => `${d.class_index}:${d.type_name}:${d.confidence}`).sort();
    const want = direct.detections.map((d) => `${d.class_index}:${d.class_name}:${d.confidence}`).sort();
    assert.ok(want.length > 0, 'model produced no detections on the ghost-net frame');
    assert.deepEqual(got, want);
    const net = created.report.detections.find((d) => d.type_name === 'trash_net');
    assert.ok(net && net.confidence > 0.5, 'expected a confident trash_net detection');
    assert.equal(created.inference.status, 'completed');
    assert.equal(created.report.severity, 'high');
  });

  it('11. maps every detection to the debris_types row with the same class index and name', async () => {
    const { rows } = await main.db.query(
      `SELECT dt.type_name, dt.class_index FROM debris d JOIN debris_types dt ON dt.id = d.debris_type_id WHERE d.report_id = $1`,
      [created.report.report_id],
    );
    assert.equal(rows.length, direct.detections.length);
    for (const r of rows) assert.equal(EXPECTED_CLASSES[r.class_index], r.type_name);
    // non-trash classes (e.g. the ROV) are kept, not discarded or relabelled
    const nonTrash = created.report.detections.filter((d) => !d.is_debris);
    for (const d of nonTrash) assert.ok(!d.type_name.startsWith('trash_'));
  });

  it('12. persists confidence, bounding boxes and mask references', async () => {
    const { rows } = await main.db.query('SELECT * FROM debris WHERE report_id = $1 ORDER BY confidence DESC', [created.report.report_id]);
    const sortedDirect = [...direct.detections].sort((a, b) => b.confidence - a.confidence);
    rows.forEach((row, i) => {
      assert.equal(row.confidence, sortedDirect[i].confidence);
      assert.equal(row.bbox.format, 'xyxy');
      assert.deepEqual([row.bbox.x1, row.bbox.y1, row.bbox.x2, row.bbox.y2], sortedDirect[i].bbox);
      assert.equal(row.bbox.image_width, direct.image.width);
      assert.equal(row.mask_url, `/api/debris/${row.id}/mask`);
      assert.ok(row.mask_key && row.mask_area_px > 0 && row.mask_area_frac > 0);
    });
    const mask = await alice.get(rows[0].mask_url).buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    assert.equal(mask.status, 200);
    assert.equal(mask.headers['content-type'], 'image/png');
    assert.deepEqual(mask.body.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal((await bob.get(rows[0].mask_url)).status, 404);
    assert.equal((await alice.get(created.report.images[0].annotated_url)).status, 200);
  });

  it('13. reports and detections survive a backend restart', async () => {
    const restarted = await buildApp({ dbUrl: pgServer.url, inference, uploadDir });
    try {
      const agent = request.agent(restarted.app);
      await agent.post('/api/auth/login').send({ email: 'alice@example.org', password: PASSWORD }).expect(200);
      const res = await agent.get(`/api/reports/${created.report.report_id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.report.detections, created.report.detections);
      const det = await agent.get(`/api/reports/${created.report.report_id}/detections`);
      assert.equal(det.body.detections.length, created.report.detections.length);
    } finally {
      await restarted.close();
    }
  });

  it('6. other users cannot read or modify the report; admins can', async () => {
    const id = created.report.report_id;
    assert.equal((await bob.get(`/api/reports/${id}`)).status, 404);
    assert.equal((await bob.get(`/api/reports/${id}/detections`)).status, 404);
    assert.equal((await bob.patch(`/api/reports/${id}`).send({ comments: 'mine now' })).status, 404);
    assert.equal((await bob.delete(`/api/reports/${id}`)).status, 404);
    assert.equal((await bob.patch(`/api/debris/${created.report.detections[0].id}`).send({ status: 'false_positive' })).status, 404);
    const list = await bob.get('/api/reports');
    assert.equal(list.body.reports.some((r) => r.report_id === id), false);
    assert.equal((await admin.get(`/api/reports/${id}`)).status, 200);
    const all = await admin.get('/api/reports?limit=100');
    assert.ok(all.body.reports.some((r) => r.report_id === id));
  });

  it('14. map markers come from the database coordinates and respect ownership', async () => {
    const mine = await alice.get('/api/reports/markers');
    const { rows } = await main.db.query('SELECT report_id, report_lat, report_long FROM reports WHERE reported_by = $1', [users.alice.user_id]);
    assert.equal(mine.body.markers.length, rows.length);
    for (const row of rows) {
      const m = mine.body.markers.find((x) => x.report_id === row.report_id);
      assert.equal(m.latitude, row.report_lat);
      assert.equal(m.longitude, row.report_long);
    }
    assert.equal((await bob.get('/api/reports/markers')).body.markers.length, 0);
    const m = mine.body.markers.find((x) => x.report_id === created.report.report_id);
    assert.equal(m.top_class, 'trash_net');
  });

  it('supports one incident with several photos', async () => {
    const files = fs.readdirSync(DEMO_DIR).filter((f) => f.endsWith('.jpg')).slice(0, 3).map((f) => path.join(DEMO_DIR, f));
    const r = await submit(alice, { images: files });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.images.length, 3);
    assert.ok(r.body.report.images.every((i) => i.inference_status === 'completed'));
    const imageIds = new Set(r.body.report.images.map((i) => i.image_id));
    assert.ok(r.body.report.detections.every((d) => imageIds.has(d.image_id)));
  });

  it('lets owners edit metadata, admins set review status, and owners review detections', async () => {
    const id = created.report.report_id;
    const upd = await alice.patch(`/api/reports/${id}`).send({ comments: 'Updated', latitude: 13.1, longitude: 80.3 });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.report.latitude, 13.1);
    assert.equal((await alice.patch(`/api/reports/${id}`).send({ latitude: 100, longitude: 0 })).status, 400);
    assert.equal((await alice.patch(`/api/reports/${id}`).send({ review_status: 'resolved' })).status, 403);
    assert.equal((await alice.patch(`/api/reports/${id}`).send({ reported_by: users.bob.user_id })).status, 400);
    const adm = await admin.patch(`/api/reports/${id}`).send({ review_status: 'assigned' });
    assert.equal(adm.body.report.review_status, 'assigned');
    const det = created.report.detections[0];
    const d = await alice.patch(`/api/debris/${det.id}`).send({ status: 'confirmed', comment: 'Verified by diver' });
    assert.equal(d.status, 200);
    assert.equal(d.body.detection.status, 'confirmed');
    assert.equal(d.body.detection.confidence, det.confidence, 'review never alters model confidence');
  });

  it('paginates report history', async () => {
    const res = await alice.get('/api/reports?limit=1&page=1');
    assert.equal(res.body.reports.length, 1);
    assert.ok(res.body.pagination.total >= 3);
    assert.equal((await alice.get('/api/reports?limit=1000')).status, 400);
  });

  it('deletes a report together with its stored files', async () => {
    const r = await submit(alice);
    const id = r.body.report.report_id;
    const { rows } = await main.db.query(
      `SELECT storage_key AS k FROM report_images WHERE report_id=$1 UNION ALL SELECT annotated_key FROM report_images WHERE report_id=$1
       UNION ALL SELECT mask_key FROM debris WHERE report_id=$1`, [id]);
    assert.equal((await alice.delete(`/api/reports/${id}`)).status, 204);
    for (const { k } of rows) assert.equal(fs.existsSync(path.join(uploadDir, ...k.split('/'))), false);
    assert.equal((await main.db.query('SELECT 1 FROM debris WHERE report_id=$1', [id])).rows.length, 0);
  });
});

describe('15. failed inference never produces fake results', { skip: !hasDemoImages() && 'demo_inputs_net/ not present' }, () => {
  it('saves the report as failed when the inference service is down, then succeeds on retry', async () => {
    const down = await buildApp({ dbUrl: pgServer.url, inference: { url: 'http://127.0.0.1:9', token: inference.token }, uploadDir });
    let id;
    try {
      const agent = request.agent(down.app);
      await agent.post('/api/auth/login').send({ email: 'bob@example.org', password: PASSWORD }).expect(200);
      const r = await submit(agent);
      assert.equal(r.status, 201);
      id = r.body.report.report_id;
      assert.equal(r.body.inference.status, 'failed');
      assert.equal(r.body.report.detections.length, 0);
      assert.equal(r.body.report.severity, null);
      assert.match(r.body.inference.errors[0].error, /unreachable/i);
      assert.equal((await down.db.query('SELECT count(*)::int AS n FROM debris WHERE report_id=$1', [id])).rows[0].n, 0);
    } finally {
      await down.close();
    }
    const retry = await bob.post(`/api/reports/${id}/reprocess`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.inference.status, 'completed');
    assert.ok(retry.body.report.detections.length > 0);
    assert.equal((await bob.post(`/api/reports/${id}/reprocess`)).status, 409);
  });

  it('marks a corrupt image as failed instead of inventing detections', async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
    const r = await submit(alice, { images: [{ buffer: corrupt, filename: 'broken.jpg', contentType: 'image/jpeg' }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.inference.status, 'failed');
    assert.match(r.body.inference.errors[0].error, /could not be analysed/);
    assert.equal(r.body.report.detections.length, 0);
  });

  it('fails closed when the backend token is wrong', async () => {
    const wrong = await buildApp({ dbUrl: pgServer.url, inference: { url: inference.url, token: 'x'.repeat(32) }, uploadDir });
    try {
      const agent = request.agent(wrong.app);
      await agent.post('/api/auth/login').send({ email: 'alice@example.org', password: PASSWORD }).expect(200);
      const r = await submit(agent);
      assert.equal(r.body.inference.status, 'failed');
      assert.match(r.body.inference.errors[0].error, /token/);
      assert.equal(r.body.report.detections.length, 0);
    } finally {
      await wrong.close();
    }
  });

  it('reports a mixed batch as partial', async () => {
    const corrupt = { buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]), filename: 'b.jpg', contentType: 'image/jpeg' };
    const r = await submit(alice, { images: [NET_IMAGE, corrupt] });
    assert.equal(r.body.inference.status, 'partial');
    assert.equal(r.body.inference.images_analysed, 1);
  });
});
