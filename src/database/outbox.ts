import { ObjectId, type ClientSession } from 'mongodb';
import { backoffMs, shouldDeadLetter } from '../domain/index.js';
import type { Collections, OutboxDoc } from './collections.js';

export type OutboxIntent = {
  logicalKey: string;
  organizationId: ObjectId;
  siteId: ObjectId;
  incidentId: ObjectId;
  alertId: ObjectId;
  recipientId: string;
  channel: 'EMAIL' | 'PUSH';
};

export async function enqueueOutbox(
  c: Collections,
  intent: OutboxIntent,
  session?: ClientSession,
): Promise<ObjectId> {
  const now = new Date();
  const _id = new ObjectId();
  await c.outbox.updateOne(
    { logicalKey: intent.logicalKey },
    {
      $setOnInsert: {
        _id,
        ...intent,
        state: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
        providerMessageId: null,
        providerAcceptedAt: null,
        deliveryReportedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, session },
  );
  const doc = await c.outbox.findOne({ logicalKey: intent.logicalKey }, { session });
  return doc?._id ?? _id;
}

export async function leaseOutboxItem(
  c: Collections,
  workerId: string,
  leaseSeconds: number,
  maxAttempts: number,
  now = new Date(),
): Promise<OutboxDoc | null> {
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
  return c.outbox.findOneAndUpdate(
    {
      attempts: { $lt: maxAttempts },
      $or: [
        { state: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $lte: now } },
        { state: 'LEASED', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        state: 'LEASED',
        leaseOwner: workerId,
        leaseUntil,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
  );
}

export async function markOutboxSent(
  c: Collections,
  id: ObjectId,
  workerId: string,
  providerMessageId: string,
): Promise<boolean> {
  const now = new Date();
  const result = await c.outbox.updateOne(
    { _id: id, state: 'LEASED', leaseOwner: workerId },
    {
      $set: {
        state: 'SENT',
        providerMessageId,
        providerAcceptedAt: now,
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: now,
      },
    },
  );
  return result.modifiedCount === 1;
}

export async function markOutboxFailed(
  c: Collections,
  id: ObjectId,
  workerId: string,
  error: string,
  maxAttempts: number,
): Promise<{ dead: boolean }> {
  const now = new Date();
  const current = await c.outbox.findOne({ _id: id });
  const attempts = current?.attempts ?? 1;
  const dead = shouldDeadLetter(attempts, maxAttempts);
  await c.outbox.updateOne(
    { _id: id, state: 'LEASED', leaseOwner: workerId },
    {
      $set: {
        state: dead ? 'DEAD' : 'FAILED',
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        leaseOwner: null,
        leaseUntil: null,
        lastError: error.slice(0, 500),
        updatedAt: now,
      },
    },
  );
  return { dead };
}

export async function cancelOutboxForIncident(
  c: Collections,
  incidentId: ObjectId,
  session?: ClientSession,
): Promise<number> {
  const result = await c.outbox.updateMany(
    { incidentId, state: { $in: ['PENDING', 'FAILED', 'LEASED'] } },
    {
      $set: {
        state: 'CANCELLED',
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      },
    },
    { session },
  );
  return result.modifiedCount;
}

export async function heartbeatWorker(
  c: Collections,
  workerId: string,
  state: 'idle' | 'working',
  options: { mode?: 'loop' | 'scheduled'; staleAfterSeconds?: number } = {},
): Promise<void> {
  await c.workerHeartbeats.updateOne(
    { _id: 'worker' },
    {
      $set: {
        lastHeartbeatAt: new Date(),
        workerId,
        state,
        mode: options.mode ?? 'loop',
        staleAfterSeconds: options.staleAfterSeconds ?? 60,
      },
    },
    { upsert: true },
  );
}

export async function retryOutbox(
  c: Collections,
  ids: ObjectId[],
  actorId: string,
): Promise<number> {
  const result = await c.outbox.updateMany(
    { _id: { $in: ids }, state: { $in: ['DEAD', 'FAILED'] } },
    {
      $set: {
        state: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: new Date(),
        retriedBy: actorId,
      },
    },
  );
  return result.modifiedCount;
}
