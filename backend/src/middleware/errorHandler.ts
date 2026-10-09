import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError, CommandRejected } from '../utils/errors';
import { logError } from '../utils/logger';

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(ApiError.notFound('Route not found'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
    });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err instanceof CommandRejected) {
    return res.status(422).json({ success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (typeof err === 'object' && err && (err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (typeof err === 'object' && err && (err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  logError('http', err, { method: req.method, path: req.path });
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}
