import { ObjectId } from 'mongodb';
import { AppError, conflict } from '../contracts/index.js';
import type { Collections } from './collections.js';

const RESERVATION_STALE_MS = 90_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

type IdempotencyInput = {
  actorId: string;
  key: string;
  operation: string;
  requestHash: string;
};

export async function withIdempotency<T>(
  c: Collections,
  input: IdempotencyInput,
  execute: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ statusCode: number; body: T; replayed: boolean }> {
  const now = new Date();
  const existing = await c.idempotency.findOne({ actorId: input.actorId, key: input.key });
  if (existing) {
    if (existing.requestHash !== input.requestHash || existing.operation !== input.operation) {
      throw conflict(
        'This idempotency key was already used with different input.',
        'IDEMPOTENCY_CONFLICT',
      );
    }
    if (existing.statusCode === 0) {
      if (now.getTime() - existing.createdAt.getTime() < RESERVATION_STALE_MS) {
        throw conflict('A request with this idempotency key is already in progress.');
      }
      await c.idempotency.deleteOne({ _id: existing._id, statusCode: 0 });
    } else {
      return { statusCode: existing.statusCode, body: existing.responseBody as T, replayed: true };
    }
  }

  const reservation = {
    _id: new ObjectId(),
    actorId: input.actorId,
    key: input.key,
    operation: input.operation,
    requestHash: input.requestHash,
    statusCode: 0,
    responseBody: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
  };

  try {
    await c.idempotency.insertOne(reservation);
  } catch {
    throw conflict('A request with this idempotency key is already in progress.');
  }

  try {
    const result = await execute();
    await c.idempotency.updateOne(
      { _id: reservation._id },
      {
        $set: {
          statusCode: result.statusCode,
          responseBody: result.body,
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
      },
    );
    return { ...result, replayed: false };
  } catch (error) {
    await c.idempotency.deleteOne({ _id: reservation._id, statusCode: 0 });
    if (error instanceof AppError) throw error;
    throw error;
  }
}
