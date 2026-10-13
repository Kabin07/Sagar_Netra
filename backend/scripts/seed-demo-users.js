// Create one demo account per role (admin, diver, researcher, citizen) for testing.
//   npm run seed:demo            create missing demo accounts
//   npm run seed:demo -- --reset also give EXISTING demo accounts new passwords
//
// Passwords are random (never hard-coded) and written to backend/demo-accounts.local.txt,
// which is git-ignored. Delete the accounts (or rerun with --reset) before any real deployment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKEND_ROOT, loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/auth/sessions.js';

const DEMO = [
  { role: 'admin', name: 'Demo Admin', email: 'admin@sagarnetra.test' },
  { role: 'diver', name: 'Demo Diver', email: 'diver@sagarnetra.test' },
  { role: 'researcher', name: 'Demo Researcher', email: 'researcher@sagarnetra.test' },
  { role: 'citizen', name: 'Demo Citizen', email: 'citizen@sagarnetra.test' },
];
const reset = process.argv.includes('--reset');
const outFile = path.join(BACKEND_ROOT, 'demo-accounts.local.txt');
const newPassword = () => `Sn-${crypto.randomBytes(9).toString('base64url')}`;

const config = loadConfig();
const pool = createPool(config);
const lines = [];
try {
  await migrate(pool, { log: () => {} });
  for (const d of DEMO) {
    const { rows } = await pool.query('SELECT user_id FROM users WHERE email = $1', [d.email]);
    if (rows[0] && !reset) {
      console.log(`exists   ${d.role.padEnd(10)} ${d.email} (password unchanged; use --reset for a new one)`);
      continue;
    }
    const password = newPassword();
    const hash = await hashPassword(password);
    if (rows[0]) {
      await pool.query(
        `UPDATE users SET password_hash = $2, user_type_id = (SELECT user_type_id FROM user_types WHERE type_name = $3) WHERE user_id = $1`,
        [rows[0].user_id, hash, d.role],
      );
      await pool.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].user_id]);
      console.log(`reset    ${d.role.padEnd(10)} ${d.email}`);
    } else {
      await pool.query(
        `INSERT INTO users (name, email, password_hash, user_type_id)
         SELECT $1, $2, $3, user_type_id FROM user_types WHERE type_name = $4`,
        [d.name, d.email, hash, d.role],
      );
      console.log(`created  ${d.role.padEnd(10)} ${d.email}`);
    }
    lines.push(`${d.role.padEnd(11)} ${d.email.padEnd(28)} ${password}`);
  }
  if (lines.length) {
    const header = `# SAGAR-NETRA demo accounts — ${new Date().toISOString()} — database ${new URL(config.databaseUrl).hostname}\n`
      + '# role       email                        password\n';
    const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') + '\n' : '';
    fs.writeFileSync(outFile, prev + header + lines.join('\n') + '\n', { mode: 0o600 });
    console.log(`\nPasswords written to ${outFile} (git-ignored).`);
  }
} catch (err) {
  console.error(`seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
