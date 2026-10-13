/**
 * Client for the private Python inference service (inference/service.py).
 *
 * Nothing returned here is fabricated: either the service produced a result that
 * passed validation, or an InferenceError is thrown and the caller records a failure.
 */
export class InferenceError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

export class InferenceClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async health({ timeoutMs = 3000 } = {}) {
    try {
      const res = await this.fetch(`${this.config.inferenceUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.json().catch(() => ({}));
      return { reachable: true, ok: res.ok && body.model_loaded === true, ...body };
    } catch (err) {
      return { reachable: false, ok: false, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  /**
   * @param {Buffer} buffer raw image bytes
   * @param {Map<number,{id:number,type_name:string}>} classMap DB debris_types keyed by class_index
   */
  async segment(buffer, classMap) {
    const params = new URLSearchParams({ conf: String(this.config.inferenceConf) });
    if (this.config.inferenceImgsz) params.set('imgsz', String(this.config.inferenceImgsz));
    let res;
    try {
      res = await this.fetch(`${this.config.inferenceUrl}/v1/segment?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Inference-Token': this.config.inferenceToken },
        body: buffer,
        signal: AbortSignal.timeout(this.config.inferenceTimeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError') throw new InferenceError(`Inference timed out after ${this.config.inferenceTimeoutMs} ms`);
      throw new InferenceError('Inference service unreachable');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.error ? `: ${String(body.error).slice(0, 200)}` : '';
      if (res.status === 422) throw new InferenceError(`Image could not be analysed${detail}`, { retryable: false });
      if (res.status === 401) throw new InferenceError('Inference service rejected the backend token (check INFERENCE_TOKEN)');
      if (res.status === 503) throw new InferenceError(`Inference model unavailable${body?.detail ? `: ${String(body.detail).slice(0, 200)}` : ''}`);
      throw new InferenceError(`Inference service error (HTTP ${res.status})${detail}`);
    }
    return validateInferenceOutput(body, classMap);
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isB64 = (s) => typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(s);

/** Strictly validate the service response; any inconsistency fails the whole image. */
export function validateInferenceOutput(body, classMap) {
  const bad = (msg) => { throw new InferenceError(`Invalid inference output: ${msg}`, { retryable: false }); };
  if (!body || typeof body !== 'object') bad('not an object');
  const { image, model, detections } = body;
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) bad('image size');
  if (!model || typeof model.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(model.sha256)) bad('model metadata');
  if (!Array.isArray(detections)) bad('detections is not an array');
  if (detections.length > 300) bad('too many detections');
  if (!isB64(body.annotated_jpeg_base64)) bad('annotated image missing');

  const out = detections.map((d, i) => {
    if (!Number.isInteger(d.class_index)) bad(`detection ${i}: class_index`);
    const type = classMap.get(d.class_index);
    if (!type) bad(`detection ${i}: unknown class index ${d.class_index}`);
    // Never remap: the model's name for this index must equal the DB's name.
    if (d.class_name !== type.type_name) bad(`detection ${i}: class ${d.class_index} is "${d.class_name}" in the model but "${type.type_name}" in the database`);
    if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 1) bad(`detection ${i}: confidence`);
    if (!Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.bbox.every(isNum)) bad(`detection ${i}: bbox`);
    const [x1, y1, x2, y2] = d.bbox;
    if (x1 < 0 || y1 < 0 || x2 > image.width + 1 || y2 > image.height + 1 || x2 < x1 || y2 < y1) bad(`detection ${i}: bbox out of range`);
    let mask = null;
    if (d.mask) {
      const m = d.mask;
      if (m.format !== 'png' || !isB64(m.png_base64) || !Number.isInteger(m.area_px) || m.area_px < 0
        || !isNum(m.area_frac) || m.area_frac < 0 || m.area_frac > 1 || !Number.isInteger(m.width) || !Number.isInteger(m.height)) {
        bad(`detection ${i}: mask`);
      }
      const png = Buffer.from(m.png_base64, 'base64');
      if (!png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) bad(`detection ${i}: mask is not a PNG`);
      mask = { png, width: m.width, height: m.height, areaPx: m.area_px, areaFrac: m.area_frac };
    }
    return {
      classIndex: d.class_index,
      debrisTypeId: type.id,
      className: type.type_name,
      category: type.category,
      confidence: d.confidence,
      bbox: {
        format: 'xyxy',
        units: 'px',
        x1, y1, x2, y2,
        image_width: image.width,
        image_height: image.height,
        normalized: d.bbox.map((v, k) => Number((v / (k % 2 === 0 ? image.width : image.height)).toFixed(6))),
      },
      mask,
    };
  });

  const annotated = Buffer.from(body.annotated_jpeg_base64, 'base64');
  if (!(annotated[0] === 0xff && annotated[1] === 0xd8)) bad('annotated image is not a JPEG');
  return {
    width: image.width,
    height: image.height,
    model: { sha256: model.sha256, imgsz: model.imgsz ?? null, conf: model.conf ?? null },
    inferenceMs: isNum(body.inference_ms) ? body.inference_ms : null,
    detections: out,
    annotated,
  };
}
