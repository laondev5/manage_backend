import { randomUUID } from 'node:crypto';
import express from 'express';
import { getServerlessApp } from './vercel.js';

/**
 * Vercel's Express preset detects this file and turns the default export into
 * one Fluid function. Requests are forwarded to the real app once its cached
 * Mongo/auth runtime is ready.
 */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(async (req, res, next) => {
  try {
    const inner = await getServerlessApp();
    inner(req, res, next);
  } catch (error) {
    const requestId = randomUUID();
    console.error('Manage API initialization failed', { requestId, error });
    if (res.headersSent) return;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-Id', requestId);
    res.end(
      JSON.stringify({
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The service is starting. Retry shortly.',
          requestId,
        },
      }),
    );
  }
});

export default app;
