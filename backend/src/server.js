import { loadConfig, validateConfig } from './config.js';
import { createContext } from './context.js';
import { createApp, frontendExists } from './app.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const problems = validateConfig(config);
if (problems.length) {
  console.error('[config] backend/.env is incomplete:\n  - ' + problems.join('\n  - ') + '\nSee backend/.env.example.');
  process.exit(1);
}

const ctx = await createContext(config);
try {
  await migrate(ctx.db); // idempotent; keeps the schema current on every start
} catch (err) {
  console.error(`[db] cannot initialise database: ${err.message}`);
  console.error('[db] Check DATABASE_URL and that PostgreSQL is running (npm run db:local starts a local one).');
  process.exit(1);
}
const recovered = await ctx.reports.recoverInterrupted();
if (recovered) console.warn(`[inference] marked ${recovered} interrupted image analyses as failed (retry from the report)`);

// Cross-check the model's class list against debris_types once at startup.
const health = await ctx.inference.health();
if (!health.reachable) {
  console.warn(`[inference] service not reachable at ${config.inferenceUrl} — reports will be saved with inference_status=failed until it is started`);
} else if (!health.ok) {
  console.warn(`[inference] service reachable but model not loaded: ${health.error}`);
} else {
  const names = [...(await ctx.reports.classMap()).values()].map((t) => t.type_name);
  if (JSON.stringify(names) !== JSON.stringify(health.classes)) {
    console.error('[inference] MODEL CLASS LIST DOES NOT MATCH debris_types — detections will be rejected');
  } else {
    console.log(`[inference] model ready (${health.num_classes} classes, imgsz ${health.imgsz}); class mapping verified`);
  }
}

const app = createApp(ctx);
const server = app.listen(config.port, config.host, () => {
  const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`[api] SAGAR-NETRA API listening on ${base}/api`);
  if (config.serveFrontend && frontendExists(config)) {
    console.log(`[web] professional  ${base}/professional/\n[web] citizen       ${base}/citizen/\n[web] authority     ${base}/authority/`);
  }
});
server.requestTimeout = Math.max(300000, config.inferenceTimeoutMs * config.maxFilesPerReport);

const shutdown = () => server.close(() => ctx.close().finally(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
