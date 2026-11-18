import express from 'express';

// Vercel's Express preset only detects entries that import express directly at
// app/index/server (root or src/). This file is that entry; the real app lives
// in the prebundled dist/serverless.js so dependencies never resolve from
// node_modules at runtime.
let appPromise;

function loadApp() {
  if (!appPromise) {
    appPromise = import('./dist/serverless.js')
      .then((module) => module.default ?? module)
      .catch((error) => {
        appPromise = undefined;
        throw error;
      });
  }
  return appPromise;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(async (req, res, next) => {
  let inner;
  try {
    inner = await loadApp();
  } catch (error) {
    console.error('[manage-api] Failed to load the serverless bundle', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      node: process.version,
      cwd: process.cwd(),
    });
    if (res.headersSent) return;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The service is starting. Retry shortly.',
        },
      }),
    );
    return;
  }
  inner(req, res, next);
});

export default app;