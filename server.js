// Vercel's Express preset loads this file as the function entry. The bundle it
// imports is built by `pnpm build` (tsup, every dependency inlined), so this
// module has no runtime imports of its own.
//
// The load is deliberately lazy: a static import that throws takes the whole
// function down before any handler exists, which the platform reports as an
// opaque 500 FUNCTION_INVOCATION_FAILED with nothing in the logs. Loading
// inside the handler turns the same failure into a logged error plus the 503
// JSON the API already uses while it is starting.
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

export default async function handler(req, res) {
  let app;
  try {
    app = await loadApp();
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

  return app(req, res);
}
