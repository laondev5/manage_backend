import './load-env.js';
import { pino } from 'pino';
import { connectDatabase, type Database } from './database/index.js';
import type { Express } from 'express';
import { loadEnv } from './env.js';
import { createAuth } from './auth.js';
import { createMailer } from './mail.js';
import { createApp } from './create-app.js';

type Runtime = {
  app: Express;
  db: Database;
};

let runtimePromise: Promise<Runtime> | null = null;

async function bootstrap(): Promise<Runtime> {
  const env = loadEnv();
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, {
    appName: 'manage-api-vercel',
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    minPoolSize: 0,
  });
  const logger = pino({
    level: process.env.LOG_LEVEL ?? (env.isProduction ? 'info' : 'debug'),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["x-manage-worker-secret"]',
      ],
      censor: '[redacted]',
    },
  });
  const mailer = createMailer(env, logger);
  const auth = createAuth(db, env, logger, mailer);
  const app = createApp({ db, auth, env, mailer }, logger);
  logger.info(
    { database: env.MONGODB_DB_NAME, email: env.emailProvider, push: env.pushProvider },
    'Manage API serverless runtime ready',
  );
  return { app, db };
}

/**
 * One Mongo client (and one Better Auth instance) per warm function instance.
 * A failed start is not cached, so the next request retries initialization.
 * Indexes and migrations are deliberately not run here; see the deployment runbook.
 */
export function getServerlessApp(): Promise<Express> {
  if (!runtimePromise) {
    runtimePromise = bootstrap().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise.then((runtime) => runtime.app);
}
