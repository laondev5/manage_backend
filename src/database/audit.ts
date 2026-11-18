import { createHash } from 'node:crypto';
import { ObjectId, type ClientSession } from 'mongodb';
import type { Collections } from './collections.js';

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
};

export const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

export type AuditInput = {
  actorId: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  organizationId?: ObjectId | null;
  siteId?: ObjectId | null;
  requestId?: string | null;
  summary: string;
  meta?: Record<string, unknown>;
};

export async function appendAudit(
  c: Collections,
  input: AuditInput,
  session?: ClientSession,
): Promise<{ id: string; hash: string; sequence: number }> {
  const head = await c.auditHeads.findOne({ _id: 'main' }, { session });
  const sequence = (head?.sequence ?? 0) + 1;
  const previousHash = head?.hash ?? null;
  const at = new Date();
  const meta = input.meta ?? {};
  const hash = sha256(
    canonical({
      sequence,
      previousHash,
      at: at.toISOString(),
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      organizationId: input.organizationId?.toHexString() ?? null,
      siteId: input.siteId?.toHexString() ?? null,
      summary: input.summary,
      meta,
    }),
  );

  const doc = {
    _id: new ObjectId(),
    sequence,
    at,
    actorId: input.actorId,
    actorName: input.actorName ?? null,
    actorRole: input.actorRole ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    organizationId: input.organizationId ?? null,
    siteId: input.siteId ?? null,
    requestId: input.requestId ?? null,
    summary: input.summary,
    meta,
    hash,
    previousHash,
  };
  await c.auditEvents.insertOne(doc, { session });
  await c.auditHeads.updateOne(
    { _id: 'main' },
    { $set: { sequence, hash, updatedAt: at } },
    { upsert: true, session },
  );
  return { id: doc._id.toHexString(), hash, sequence };
}
