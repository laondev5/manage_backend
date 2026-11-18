import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../contracts/index.js';
import type { Logger } from 'pino';
import { asyncHandler, parseQuery, type AppDeps } from '../http/context.js';
import {
  extractBearerToken,
  runScheduledWorkerTick,
  verifyWorkerSecret,
} from '../services/worker-tick.js';

const tickQuerySchema = z.object({
  max: z.coerce.number().int().min(1).max(100).default(40),
});

/**
 * Machine-only routes. They are mounted before session auth and CSRF because
 * the caller is a scheduler holding a dedicated shared secret, not a browser.
 */
export function buildInternalRouter(deps: AppDeps, logger: Logger): Router {
  const router = Router();

  const tickLimit = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Too many worker ticks. Wait a moment and retry.'));
    },
  });

  // Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`. External
  // schedulers use POST. Both accept CRON_SECRET or WORKER_TRIGGER_SECRET.
  const tick = asyncHandler(async (req: Request, res: Response) => {
    const secrets = [deps.env.CRON_SECRET, deps.env.WORKER_TRIGGER_SECRET].filter(
      (secret): secret is string => Boolean(secret),
    );
    if (!secrets.length) {
      // Hide the route entirely when no scheduler is configured.
      throw new AppError(404, 'NOT_FOUND', 'Resource not found.');
    }

    const provided =
      extractBearerToken(req.header('authorization')) ??
      req.header('x-manage-worker-secret') ??
      undefined;
    if (!secrets.some((secret) => verifyWorkerSecret(provided, secret))) {
      throw new AppError(401, 'UNAUTHENTICATED', 'A valid worker secret is required.');
    }

    const query = parseQuery(tickQuerySchema, req.query);
    const result = await runScheduledWorkerTick(deps, logger, { maxItems: query.max });
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.ok ? 200 : 503).json(result);
  });

  router.get('/worker/tick', tickLimit, tick);
  router.post('/worker/tick', tickLimit, tick);

  return router;
}
