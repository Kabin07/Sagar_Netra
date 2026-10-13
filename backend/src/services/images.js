import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../errors.js';

const TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', extensions: ['.jpg', '.jpeg'] },
  png: { mime: 'image/png', ext: 'png', extensions: ['.png'] },
  webp: { mime: 'image/webp', ext: 'webp', extensions: ['.webp'] },
};

/** Identify the real format from magic bytes; the client-declared MIME is not trusted. */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Validate one multer memory file. Rules:
 *  - magic bytes must be JPEG, PNG or WebP
 *  - the filename extension must agree with the detected format
 *  - the declared MIME type must agree too (if the browser sent one)
 */
export function validateImageFile(file) {
  const kind = sniffImageType(file.buffer);
  const name = file.originalname || '';
  if (!kind) {
    throw new HttpError(415, `Unsupported file "${safeName(name)}": only JPEG, PNG and WebP images are accepted`);
  }
  const t = TYPES[kind];
  const ext = path.extname(name).toLowerCase();
  if (ext && !t.extensions.includes(ext)) {
    throw new HttpError(415, `File "${safeName(name)}" has extension ${ext} but its content is ${kind.toUpperCase()}`);
  }
  if (file.mimetype && file.mimetype !== 'application/octet-stream' && file.mimetype !== t.mime) {
    throw new HttpError(415, `File "${safeName(name)}" declares ${file.mimetype} but its content is ${t.mime}`);
  }
  return {
    mime: t.mime,
    ext: t.ext,
    size: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    originalName: safeName(name) || `image.${t.ext}`,
  };
}

/** Strip paths/control characters; the stored filename is metadata only, never a path. */
export function safeName(name) {
  return path.basename(String(name)).replace(/[^\w.\- ()]/g, '_').slice(0, 200);
}
