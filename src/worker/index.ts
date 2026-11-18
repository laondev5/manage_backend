import './load-env.js';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { connectDatabase } from '../database/index.js';
import {
  ManageWorker,
  createDeliveryContext,
  type WorkerDeps,
  type WorkerLoopEnv,
} from '../worker-core/index.js';
import { loadWorkerEnv } from './env.js';
import { projectRoot } from './load-env.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
});

async function main() {
  const env = loadWorkerEnv();
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  });
  const delivery = createDeliveryContext({
    env,
    c: db.c,
    logger,
    localRoot: env.isProduction ? null : projectRoot,
  });

  const deps: WorkerDeps<WorkerLoopEnv> = {
    c: db.c,
    env,
    logger,
    delivery,
    workerId: `worker-${randomUUID()}`,
  };

  const worker = new ManageWorker(deps);
  worker.start();
  logger.info(
    { workerId: deps.workerId, email: env.emailProvider, push: env.pushProvider },
    'Manage worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Stopping worker');
    await worker.stop();
    await db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start the worker');
  process.exit(1);
});
