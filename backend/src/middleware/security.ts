import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { ApiError } from '../utils/errors';

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!env.ADMIN_API_KEY) return next(new ApiError(503, 'ADMIN_DISABLED', 'Admin access is not configured'));
  const supplied = req.header('x-admin-key') ?? '';
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(env.ADMIN_API_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) return next(ApiError.unauthorized('Invalid admin key'));
  next();
}

export function bearerToken(req: Request): string {
  const h = req.header('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(h);
  if (!m) throw ApiError.unauthorized('Missing or invalid session token');
  return m[1];
}

const limiterBase = { standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } } };
export const globalLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, limit: 600 });
export const startLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 60 * 1000, limit: 30 });
export const messageLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 1000, limit: 30 });
export const adminLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 1000, limit: 120 });
/** Counts only rejected admin requests (wrong key etc.), so guessing the key is throttled without limiting real staff. */
export const adminAuthFailLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true });
