import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { collections, type Collections } from './collections.js';

export type Database = {
  client: MongoClient;
  db: Db;
  c: Collections;
  close: () => Promise<void>;
  // Probed at connect time; false when the server rejects transaction numbers
  // (standalone mongod). Writes then run in a plain session; invariants rely on
  // unique indexes and compensating writes instead of atomic transactions.
  supportsTransactions?: boolean;
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
  const baseOptions = {
    appName: options.appName ?? 'manage-api',
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
    ...(options.maxPoolSize === undefined ? {} : { maxPoolSize: options.maxPoolSize }),
    ...(options.minPoolSize === undefined ? {} : { minPoolSize: options.minPoolSize }),
  };
  let client = new MongoClient(uri, baseOptions);
  await client.connect();
  // A standalone mongod rejects every txnNumber write — transactions and
  // retryable writes alike. Detect it before any write and reconnect with
  // retryWrites disabled; transactions fall back to plain sessions.
  const hello = await client.db(dbName).command({ hello: 1 });
  const standalone = hello.setName == null && hello.msg !== 'isdbgrid';
  if (standalone) {
    await client.close();
    client = new MongoClient(uri, { ...baseOptions, retryWrites: false });
    await client.connect();
  }
  const db = client.db(dbName);
  return {
    client,
    db,
    c: collections(db),
    supportsTransactions: !standalone,
    close: () => client.close(),
  };
}

export function isTransactionUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? (error as { code?: number }).code : undefined;
  const message =
    'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
  return (
    code === 20 &&
    /Transaction numbers|replica set member or mongos|Transactions are not supported/i.test(message)
  );
}

async function runWithoutTransaction<T>(
  db: Database,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = db.client.startSession();
  try {
    return await fn(session);
  } finally {
    await session.endSession();
  }
}

export async function withTransaction<T>(
  db: Database,
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  if (db.supportsTransactions === false) {
    return runWithoutTransaction(db, fn);
  }
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
  } catch (error) {
    // A standalone mongod rejects the very first transactional command, so no
    // writes from this callback have landed. Safe to rerun without a transaction.
    if (isTransactionUnsupported(error)) {
      db.supportsTransactions = false;
      return runWithoutTransaction(db, fn);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: number }).code === 11000;
