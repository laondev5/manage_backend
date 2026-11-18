import express, { type Express, type RequestHandler } from 'express';
import helmetModule, { type HelmetOptions } from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { toNodeHandler } from 'better-auth/node';
import { AppError } from './contracts/index.js';
import type { AppDeps } from './http/context.js';
import { requestId, errorHandler, notFoundHandler } from './http/http.js';
import { buildApiRouter } from './routes/index.js';
import { resendWebhookHandler } from './webhooks.js';

// helmet publishes ESM and CJS builds with separate type entries and no "types"
// export condition, so some type-check environments resolve the module namespace
// instead of its callable default. Normalize it once here.
const helmet = helmetModule as unknown as (
  options?: Readonly<HelmetOptions>,
) => RequestHandler;

const blockedSignup: RequestHandler = (_req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found.',
      requestId: _req.requestId,
    },
  });
};

export function createApp(deps: AppDeps, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.env.TRUST_PROXY || deps.env.isVercel ? 1 : false);

  app.use(requestId);

  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ requestId: req.requestId }),
      autoLogging: {
        ignore: (req) => req.url === '/health/live' || req.url === '/api/v1/health',
      },
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url?.split('?')[0],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'req.headers["x-api-key"]',
          'req.headers["x-manage-worker-secret"]',
        ],
        censor: '[redacted]',
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const mobileOrigins = [`${deps.env.MOBILE_SCHEME}://`];
  // Expo's web preview binds a local port that can change between runs; this
  // allowance is development-only and never applies in production.
  const isLocalExpoWeb = (origin: string) =>
    !deps.env.isProduction && /^http:\/\/localhost:\d+$/.test(origin);
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (
          !origin ||
          deps.env.trustedWebOrigins.includes(origin) ||
          mobileOrigins.some((prefix) => origin.startsWith(prefix)) ||
          isLocalExpoWeb(origin) ||
          (!deps.env.isProduction && origin.startsWith('exp://'))
        ) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-CSRF-Token',
        'X-Organization-Id',
        'X-Manage-Client',
        'Idempotency-Key',
        'X-Request-Id',
      ],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.all('/api/auth/sign-up', blockedSignup);
  app.all('/api/auth/sign-up/*splat', blockedSignup);

  app.post(
    '/api/v1/webhooks/resend',
    express.raw({ type: () => true, limit: '1mb' }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
      next();
    },
    resendWebhookHandler(deps, logger),
  );

  app.all('/api/auth/*splat', toNodeHandler(deps.auth));

  app.use(express.json({ limit: '1mb' }));

  app.get(['/health/live', '/api/health/live'], (_req, res) => {
    res.json({ status: 'ok' });
  });

  const readiness: RequestHandler = async (_req, res, next) => {
    try {
      await deps.db.db.command({ ping: 1 });
      res.json({ status: 'ok' });
    } catch (error) {
      next(new AppError(503, 'PROVIDER_UNAVAILABLE', 'The database is not reachable.'));
      logger.debug({ err: error }, 'Readiness probe failed');
    }
  };

  app.get(['/health/ready', '/api/health/ready'], readiness);

  app.use('/api/v1', buildApiRouter(deps, logger));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
