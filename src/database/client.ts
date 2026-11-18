import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { collections, type Collections } from './collections.js';

export type Database = {
  client: MongoClient;
  db: Db;
  c: Collections;
  close: () => Promise<void>;
};

export type DatabaseOptions = {
  maxPoolSize?: number;
  minPoolSize?: number;
  appName?: string;
  serverSelectionTimeoutMS?: number;
};

export async function connectDatabase(
  uri: string,
  dbName: string,
  options: DatabaseOptions = {},
): Promise<Database> {
  const client = new MongoClient(uri, {
    appName: options.appName ?? 'manage-api',
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
    retryWrites: true,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
    ...(options.minPoolSize === undefined ? {} : { minPoolSize: options.minPoolSize }),
  });
  await client.connect();
  const db = client.db(dbName);
  return {
    client,
    db,
    c: collections(db),
    close: () => client.close(),
  };
}

export async function withTransaction<T>(
  db: Database,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = db.client.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: number }).code === 11000;
