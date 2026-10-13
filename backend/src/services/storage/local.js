import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEY_RE = /^[a-z]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/**
 * Local-disk storage for development. Files live OUTSIDE any statically served
 * directory and are only reachable through authorised API routes.
 *
 * Storage interface (implement the same four methods for S3/GCS/Azure later):
 *   put(buffer, { kind, ext })  -> key
 *   get(key)                    -> Readable stream
 *   getBuffer(key)              -> Buffer
 *   delete(key)                 -> void (missing files are ignored)
 */
export class LocalStorage {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Keys are generated server-side (never from client filenames). */
  newKey(kind, ext) {
    if (!/^[a-z]+$/.test(kind) || !['jpg', 'png', 'webp'].includes(ext)) throw new Error('invalid storage key parts');
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${kind}/${yyyy}/${mm}/${crypto.randomUUID()}.${ext}`;
  }

  resolve(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('invalid storage key');
    const full = path.resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new Error('storage key escapes root');
    return full;
  }

  async put(buffer, { kind, ext }) {
    const key = this.newKey(kind, ext);
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer, { flag: 'wx' });
    return key;
  }

  get(key) {
    return createReadStream(this.resolve(key));
  }

  getBuffer(key) {
    return fs.readFile(this.resolve(key));
  }

  async delete(key) {
    if (!key) return;
    await fs.rm(this.resolve(key), { force: true });
  }
}
