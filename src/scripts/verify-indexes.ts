import '../load-env.js';
import { pino } from 'pino';
import { connectDatabase, verifyIndexes } from '../database/index.js';
import { loadEnv } from '../env.js';

async function main() {
  const env = loadEnv();
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME);
  try {
    const result = await verifyIndexes(db.db);
    if (!result.ok) {
      console.error('Index verification failed:');
      for (const issue of result.issues) console.error(` - ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log('All declared indexes are present with the expected options.');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  pino().error({ err: error }, 'Could not verify indexes');
  process.exit(1);
});
