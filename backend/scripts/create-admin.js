// Create an administrator, or promote an existing account to admin.
// This is the ONLY way to obtain the admin role besides an existing admin calling
// PATCH /api/users/:id/role. It needs direct database access (backend/.env), so it
// is not exposed over HTTP.
//
//   npm run admin:create -- --email admin@example.org --name "Coastal Admin"
//   npm run admin:create -- --email diver@example.org --promote
//
// The password is read from the SN_ADMIN_PASSWORD environment variable, or prompted
// for interactively (input hidden). It is never accepted as a command-line argument,
// so it does not end up in shell history.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/auth/sessions.js';
import { EMAIL_RE } from '../src/validation.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, promote: { type: 'boolean', default: false } },
});

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const email = (values.email || '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) {
  console.error('Usage: npm run admin:create -- --email <email> [--name "<name>"] [--promote]');
  process.exit(1);
}

const pool = createPool(loadConfig());
try {
  await migrate(pool, { log: () => {} });
  const existing = await pool.query('SELECT user_id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE users SET user_type_id = (SELECT user_type_id FROM user_types WHERE type_name = 'admin') WHERE user_id = $1`,
      [existing.rows[0].user_id],
    );
    console.log(`Promoted existing user ${email} to admin.`);
  } else if (values.promote) {
    console.error(`No user with email ${email}; register first or omit --promote to create one.`);
    process.exitCode = 1;
  } else {
    const name = (values.name || '').trim();
    if (name.length < 2) throw new Error('--name is required when creating a new admin');
    const password = process.env.SN_ADMIN_PASSWORD || await promptHidden('Admin password (10-128 chars): ');
    if (password.length < 10 || password.length > 128) throw new Error('Password must be 10-128 characters');
    await pool.query(
      `INSERT INTO users (name, email, password_hash, user_type_id)
       SELECT $1, $2, $3, user_type_id FROM user_types WHERE type_name = 'admin'`,
      [name, email, await hashPassword(password)],
    );
    console.log(`Created admin ${email}.`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
