import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageType, validateImageFile, safeName } from '../src/services/images.js';
import { validateInferenceOutput, InferenceError } from '../src/services/inference.js';
import { detectionSeverity, reportSeverity } from '../src/services/severity.js';
import { connectionString, sslOptions } from '../src/db.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const classMap = new Map([
  [0, { id: 1, type_name: 'rov', category: 'rov' }],
  [21, { id: 22, type_name: 'trash_net', category: 'trash' }],
]);
const output = (overrides = {}) => ({
  image: { width: 100, height: 50 },
  model: { sha256: 'a'.repeat(64), imgsz: 512, conf: 0.25 },
  inference_ms: 12.5,
  annotated_jpeg_base64: Buffer.concat([JPEG_HEAD, Buffer.alloc(10)]).toString('base64'),
  detections: [{
    class_index: 21, class_name: 'trash_net', confidence: 0.91, bbox: [10, 5, 60, 40],
    mask: { format: 'png', width: 100, height: 50, area_px: 300, area_frac: 0.06, png_base64: PNG_1PX.toString('base64') },
  }],
  ...overrides,
});

describe('image validation', () => {
  it('detects formats by magic bytes', () => {
    assert.equal(sniffImageType(JPEG_HEAD), 'jpeg');
    assert.equal(sniffImageType(PNG_1PX), 'png');
    assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(sniffImageType(Buffer.from('GIF89a......')), null);
    assert.equal(sniffImageType(Buffer.from('<svg xmlns=...>')), null);
  });

  it('rejects a mismatched declared MIME type', () => {
    assert.throws(() => validateImageFile({ buffer: PNG_1PX, originalname: 'a.png', mimetype: 'image/jpeg', size: PNG_1PX.length }), /declares image\/jpeg/);
    assert.equal(validateImageFile({ buffer: PNG_1PX, originalname: 'a.png', mimetype: 'image/png', size: PNG_1PX.length }).ext, 'png');
  });

  it('sanitises client filenames', () => {
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.doesNotMatch(safeName('C:\\x\\..\\y<z>.jpg'), /[\\/:<>]/);
  });
});

describe('inference output validation', () => {
  it('accepts a well-formed response and normalises the bbox', () => {
    const r = validateInferenceOutput(output(), classMap);
    assert.equal(r.detections[0].debrisTypeId, 22);
    assert.deepEqual(r.detections[0].bbox.normalized, [0.1, 0.1, 0.6, 0.8]);
    assert.equal(r.detections[0].mask.areaFrac, 0.06);
  });

  it('refuses a class name that disagrees with the database (no silent remapping)', () => {
    const bad = output({ detections: [{ ...output().detections[0], class_name: 'trash_rope' }] });
    assert.throws(() => validateInferenceOutput(bad, classMap), (e) => e instanceof InferenceError && /trash_rope/.test(e.message));
  });

  it('refuses unknown class indices, bad confidences and out-of-frame boxes', () => {
    const d = output().detections[0];
    for (const det of [{ ...d, class_index: 99 }, { ...d, confidence: 1.5 }, { ...d, confidence: 'high' }, { ...d, bbox: [0, 0, 500, 10] }]) {
      assert.throws(() => validateInferenceOutput(output({ detections: [det] }), classMap), InferenceError);
    }
  });
});

describe('severity', () => {
  it('only trash classes raise severity', () => {
    assert.equal(detectionSeverity('rov', 0.9), 'none');
    assert.equal(detectionSeverity('animal_fish', 0.5), 'none');
    assert.equal(detectionSeverity('trash_net', 0.01), 'high');
    assert.equal(detectionSeverity('trash_rope', 0.01), 'high');
    assert.equal(detectionSeverity('trash_bottle', 0.01), 'low');
    assert.equal(detectionSeverity('trash_bag', 0.1), 'med');
  });

  it('is null until an analysis has completed, and ignores false positives', () => {
    assert.equal(reportSeverity([], { anyCompleted: false }), null);
    assert.equal(reportSeverity([], { anyCompleted: true }), 'none');
    assert.equal(reportSeverity([{ type_name: 'trash_net', mask_area_frac: 0.1, status: 'false_positive' }], { anyCompleted: true }), 'none');
  });
});

describe('hosted database TLS settings', () => {
  const base = { databaseUrl: 'postgresql://postgres.ref:p%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&application_name=sn' };

  it('removes sslmode from the URL when PGSSL is on, keeping other parameters and the encoded password', () => {
    const u = new URL(connectionString({ ...base, pgSsl: true }));
    assert.equal(u.searchParams.get('sslmode'), null);
    assert.equal(u.searchParams.get('application_name'), 'sn');
    assert.equal(u.password, 'p%40ss');
  });

  it('verifies certificates by default and refuses a missing CA file', () => {
    assert.equal(sslOptions({ pgSsl: false }), undefined);
    assert.deepEqual(sslOptions({ pgSsl: true, pgSslRejectUnauthorized: true, pgSslCa: null }), { rejectUnauthorized: true });
    assert.throws(() => sslOptions({ pgSsl: true, pgSslRejectUnauthorized: true, pgSslCa: 'Z:/missing/ca.crt' }), /PGSSL_CA file not found/);
  });
});
