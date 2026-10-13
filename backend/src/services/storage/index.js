import { LocalStorage } from './local.js';

export async function createStorage(config) {
  if (config.storageDriver !== 'local') {
    throw new Error(`Unsupported STORAGE_DRIVER "${config.storageDriver}". Implement put/get/getBuffer/delete for it in src/services/storage/.`);
  }
  const storage = new LocalStorage(config.uploadDir);
  await storage.init();
  return storage;
}
