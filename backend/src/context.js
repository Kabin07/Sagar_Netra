import { createPool } from './db.js';
import { createStorage } from './services/storage/index.js';
import { InferenceClient } from './services/inference.js';
import { ReportService } from './services/reports.js';

/** Wire up the shared dependencies used by createApp(). */
export async function createContext(config) {
  const db = createPool(config);
  const storage = await createStorage(config);
  const inference = new InferenceClient(config);
  const reports = new ReportService({ db, storage, inference, config });
  return { config, db, storage, inference, reports, close: () => db.end() };
}
