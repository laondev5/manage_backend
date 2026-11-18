import '../load-env.js';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: 27017 }],
  });

  const uri = replSet.getUri('manage');
  console.log('');
  console.log('Manage development MongoDB is running.');
  console.log(`URI: ${uri}`);
  console.log('This is an in-memory single-member replica set so transactions work locally.');
  console.log('Data is discarded when this process stops. Press Ctrl+C to stop.');
  console.log('');

  const shutdown = async () => {
    console.log('Stopping development MongoDB...');
    await replSet.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start development MongoDB:', error);
  process.exit(1);
});
