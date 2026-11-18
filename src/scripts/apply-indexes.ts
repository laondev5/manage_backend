import '../load-env.js';
import { pino } from 'pino';
import { connectDatabase, ensureIndexes, verifyIndexes } from '../database/index.js';
import { loadEnv } from '../env.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

/**
 * Applies every declared index. Run this once against a new database, or after
 * index definitions change. Safe to rerun: existing matching indexes are kept.
 */
async function main() {
  const env = loadEnv();
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME, {
    maxPoolSize: 2,
    appName: 'manage-index-apply',
  });
  try {
    await ensureIndexes(db.db);
    const result = await verifyIndexes(db.db);
    if (!result.ok) {
      for (const issue of result.issues) logger.error({ issue }, 'Index verification issue');
      throw new Error('Indexes were applied but verification still reports drift.');
    }
    logger.info({ database: env.MONGODB_DB_NAME }, 'Indexes applied and verified');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Could not apply indexes');
  process.exit(1);
});
