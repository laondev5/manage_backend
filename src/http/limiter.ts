import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../contracts/index.js';
import { MongoRateLimitStore } from './rate-limit.js';
import type { AppDeps } from './context.js';

type LimiterOptions = {
  windowMs: number;
  limit: number;
  prefix: string;
  key?: (req: Request) => string;
};

export function limiter(deps: AppDeps, options: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: false,
    store: new MongoRateLimitStore(deps.db.c, options.prefix),
    keyGenerator: options.key ?? ((req) => req.ip ?? 'unknown'),
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.'));
    },
  });
}

export const userOrIp = (req: Request) => req.auth?.user.id ?? req.ip ?? 'unknown';
