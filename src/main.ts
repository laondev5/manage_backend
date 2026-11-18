import './load-env.js';
import { pino } from 'pino';
import { connectDatabase, ensureIndexes, verifyIndexes } from './database/index.js';
import { loadEnv } from './env.js';
import { createAuth } from './auth.js';
import { createMailer } from './mail.js';
import { createApp } from './create-app.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: ['req.headers.authorization', 'req.headers.cookie'],
});

async function main() {
  const env = loadEnv();
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  });

  if (process.env.CHECK_INDEXES === 'true') {
    const result = await verifyIndexes(db.db);
    if (!result.ok) {
      logger.warn({ issues: result.issues }, 'Index verification found drift; applying index specs');
      await ensureIndexes(db.db);
    }
  } else if (!env.isProduction) {
    await ensureIndexes(db.db);
  }

  const mailer = createMailer(env, logger);
  const auth = createAuth(db, env, logger, mailer);
  const app = createApp({ db, auth, env, mailer }, logger);

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, email: env.emailProvider, push: env.pushProvider },
      'Manage API listening',
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start the API');
  process.exit(1);
});
