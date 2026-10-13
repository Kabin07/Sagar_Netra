// Set a new password for any account (requires database access via backend/.env).
//   npm run user:set-password -- --email admin@sagarnetra.test
//
// You are prompted twice for the new password (input hidden). For automation the
// password can come from the SN_NEW_PASSWORD environment variable instead; it is never
// accepted as a command-line argument, so it does not end up in shell history.
// All existing sessions of that account are signed out.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth/sessions.js';
import { EMAIL_RE } from '../src/validation.js';

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const email = (values.email || '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) {
  console.error('Usage: npm run user:set-password -- --email <email>');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const pool = createPool(loadConfig());
try {
  const { rows } = await pool.query(
    'SELECT u.user_id, ut.type_name AS role FROM users u JOIN user_types ut USING (user_type_id) WHERE u.email = $1',
    [email],
  );
  if (!rows[0]) throw new Error(`No account with email ${email}`);

  let password = process.env.SN_NEW_PASSWORD;
  if (!password) {
    password = await promptHidden(`New password for ${email} (10-128 characters): `);
    const again = await promptHidden('Repeat the new password: ');
    if (password !== again) throw new Error('The two passwords do not match — nothing was changed');
  }
  if (password.length < 10 || password.length > 128) throw new Error('Password must be 10-128 characters — nothing was changed');

  await pool.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [rows[0].user_id, await hashPassword(password)]);
  const { rowCount } = await pool.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].user_id]);
  console.log(`Password updated for ${email} (${rows[0].role}). ${rowCount} active session(s) signed out.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
