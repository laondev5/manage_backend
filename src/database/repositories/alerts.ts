import { ObjectId, type ClientSession } from 'mongodb';
import type { AlertDoc, Collections, IncidentDoc, SiteDoc } from '../collections.js';
import { enqueueOutbox } from '../outbox.js';

export async function resolveAlertRecipients(c: Collections, site: SiteDoc): Promise<string[]> {
  const owners = await c.memberships
    .find({ organizationId: site.organizationId, role: 'SITE_OWNER', status: 'ACTIVE' })
    .toArray();
  const ownerIds = new Set(owners.map((owner) => owner.userId));
  const scoped = site.ownerIds.filter((id) => ownerIds.has(id));
  if (scoped.length) return scoped;
  return owners.map((owner) => owner.userId);
}

export async function createIncidentAlerts(
  c: Collections,
  input: {
    incident: IncidentDoc;
    site: SiteDoc;
    recipients: string[];
  },
  session?: ClientSession,
): Promise<AlertDoc[]> {
  if (!input.recipients.length) return [];
  const now = new Date();
  const alerts: AlertDoc[] = input.recipients.map((recipientId) => ({
    _id: new ObjectId(),
    organizationId: input.incident.organizationId,
    siteId: input.incident.siteId,
    incidentId: input.incident._id,
    recipientId,
    workerId: input.incident.userId,
    channel: 'IN_APP',
    state: 'UNREAD',
    detectedAt: input.incident.detectedAt,
    receivedAt: now,
    lastUpdateAt: now,
    reviewDecision: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: now,
  }));

  try {
    await c.alerts.insertMany(alerts, { ordered: false, session });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as { code?: number }).code !== 11000) {
      throw error;
    }
  }

  for (const alert of alerts) {
    if (input.site.notificationPreferences.email) {
      await enqueueOutbox(
        c,
        {
          logicalKey: `alert:${alert.incidentId.toHexString()}:${alert.recipientId}:EMAIL`,
          organizationId: alert.organizationId,
          siteId: alert.siteId,
          incidentId: alert.incidentId,
          alertId: alert._id,
          recipientId: alert.recipientId,
          channel: 'EMAIL',
        },
        session,
      );
    }
    if (input.site.notificationPreferences.push) {
      await enqueueOutbox(
        c,
        {
          logicalKey: `alert:${alert.incidentId.toHexString()}:${alert.recipientId}:PUSH`,
          organizationId: alert.organizationId,
          siteId: alert.siteId,
          incidentId: alert.incidentId,
          alertId: alert._id,
          recipientId: alert.recipientId,
          channel: 'PUSH',
        },
        session,
      );
    }
  }
  return alerts;
}

export async function listAlertsForRecipient(
  c: Collections,
  input: {
    recipientId: string;
    state?: AlertDoc['state'];
    cursor?: string;
    limit: number;
  },
) {
  const filter: Record<string, unknown> = { recipientId: input.recipientId };
  if (input.state) filter.state = input.state;
  if (input.cursor && ObjectId.isValid(input.cursor)) filter._id = { $lt: new ObjectId(input.cursor) };
  const docs = await c.alerts
    .find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .toArray();
  const items = docs.slice(0, input.limit);
  return {
    items,
    nextCursor: docs.length > input.limit ? items.at(-1)?._id.toHexString() ?? null : null,
  };
}

export async function findAlertForRecipient(
  c: Collections,
  alertId: ObjectId,
  recipientId: string,
) {
  return c.alerts.findOne({ _id: alertId, recipientId });
}

export async function markAlertRead(c: Collections, alertId: ObjectId) {
  await c.alerts.updateOne(
    { _id: alertId, state: 'UNREAD' },
    { $set: { state: 'READ', readAt: new Date() } },
  );
}

export async function reviewAlert(
  c: Collections,
  input: {
    alertId: ObjectId;
    recipientId: string;
    decision: 'ACKNOWLEDGED' | 'CONTACTED' | 'DISMISSED';
    note: string | null;
  },
): Promise<AlertDoc | null> {
  return c.alerts.findOneAndUpdate(
    { _id: input.alertId, recipientId: input.recipientId },
    {
      $set: {
        state: 'REVIEWED',
        reviewDecision: input.decision,
        reviewNote: input.note,
        reviewedBy: input.recipientId,
        reviewedAt: new Date(),
        readAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}

export async function listAlertsForSites(
  c: Collections,
  siteIds: ObjectId[],
  input: { state?: AlertDoc['state']; cursor?: string; limit: number },
) {
  if (!siteIds.length) return { items: [], nextCursor: null };
  const filter: Record<string, unknown> = { siteId: { $in: siteIds } };
  if (input.state) filter.state = input.state;
  if (input.cursor && ObjectId.isValid(input.cursor)) filter._id = { $lt: new ObjectId(input.cursor) };
  const docs = await c.alerts
    .find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .toArray();
  const items = docs.slice(0, input.limit);
  return {
    items,
    nextCursor: docs.length > input.limit ? items.at(-1)?._id.toHexString() ?? null : null,
  };
}

export async function countOpenAlerts(c: Collections, siteIds: ObjectId[]) {
  if (!siteIds.length) return 0;
  return c.alerts.countDocuments({ siteId: { $in: siteIds }, state: { $ne: 'REVIEWED' } });
}

export async function countOpenAlertsForRecipient(c: Collections, recipientId: string) {
  return c.alerts.countDocuments({ recipientId, state: { $ne: 'REVIEWED' } });
}

export async function openAlertCountsBySite(c: Collections, recipientId: string, siteIds: ObjectId[]) {
  if (!siteIds.length) return new Map<string, number>();
  const rows = await c.alerts
    .aggregate<{ _id: ObjectId; count: number }>([
      { $match: { recipientId, siteId: { $in: siteIds }, state: { $ne: 'REVIEWED' } } },
      { $group: { _id: '$siteId', count: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((row) => [row._id.toHexString(), row.count]));
}

export async function recentAlertsForRecipient(
  c: Collections,
  recipientId: string,
  siteIds: ObjectId[],
  limit = 5,
) {
  if (!siteIds.length) return [];
  return c.alerts
    .find({ recipientId, siteId: { $in: siteIds } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function recentAlerts(c: Collections, siteIds: ObjectId[], limit = 5) {
  if (!siteIds.length) return [];
  return c.alerts
    .find({ siteId: { $in: siteIds } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function markIncidentAlertsUpdated(
  c: Collections,
  incidentId: ObjectId,
  session?: ClientSession,
) {
  await c.alerts.updateMany(
    { incidentId },
    { $set: { lastUpdateAt: new Date() } },
    { session },
  );
}
