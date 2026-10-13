import multer from 'multer';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

/** Final Express error handler: never leaks stack traces or SQL to clients. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'An image exceeds the maximum upload size',
      LIMIT_FILE_COUNT: 'Too many images in one report',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field (use "images")',
      LIMIT_FIELD_VALUE: 'A form field is too long',
    };
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: messages[err.code] || 'Upload rejected' });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  // PostgreSQL check / FK violations that slipped past validation are client errors.
  if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22003') {
    return res.status(400).json({ error: 'Invalid value for a database field' });
  }
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: 'Internal server error' });
}
