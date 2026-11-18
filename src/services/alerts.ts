import { ObjectId } from 'mongodb';
import { forbidden, notFound, type AlertDetail, type AlertReview, type AlertSummary } from '../contracts/index.js';
import { canReadSite } from '../domain/index.js';
import {
  appendAudit,
  findAlertForRecipient,
  findIncident,
  findShiftById,
  findSite,
  listAlertsForRecipient,
  markAlertRead,
  reviewAlert,
  usersByIds,
  type AlertDoc,
  type Database,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

async function mapSummary(
  db: Database,
  alert: AlertDoc,
  site: SiteDoc,
  workerName: string,
): Promise<AlertSummary> {
  const incident = await findIncident(db.c, alert.incidentId);
  const shiftDoc = incident ? await findShiftById(db.c, incident.shiftId) : null;
  return {
    id: alert._id.toHexString(),
    incidentId: alert.incidentId.toHexString(),
    siteId: alert.siteId.toHexString(),
    siteName: site.name,
    workerName,
    workerId: alert.workerId,
    state: alert.state,
    detectedAt: alert.detectedAt.toISOString(),
    receivedAt: alert.receivedAt.toISOString(),
    lastUpdateAt: alert.lastUpdateAt?.toISOString() ?? null,
    stillWorking: shiftDoc?.status === 'WORKING',
    createdAt: alert.createdAt.toISOString(),
  };
}

async function alertContext(db: Database, alert: AlertDoc) {
  const [site, incident, users] = await Promise.all([
    findSite(db.c, alert.siteId),
    findIncident(db.c, alert.incidentId),
    usersByIds(db.c, [alert.workerId, ...(alert.reviewedBy ? [alert.reviewedBy] : [])]),
  ]);
  if (!site) throw notFound('Alert not found.');
  return { site, incident, users };
}

function accessAllowed(auth: AuthContext, site: SiteDoc): boolean {
  return canReadSite(auth.actor, {
    organizationId: site.organizationId.toHexString(),
    id: site._id.toHexString(),
  });
}

export async function listMyAlerts(
  db: Database,
  auth: AuthContext,
  input: { state?: AlertDoc['state']; cursor?: string; limit: number },
) {
  const result = await listAlertsForRecipient(db.c, {
    recipientId: auth.user.id,
    state: input.state,
    cursor: input.cursor,
    limit: input.limit,
  });
  const items: AlertSummary[] = [];
  for (const alert of result.items) {
    const { site, users } = await alertContext(db, alert);
    if (!accessAllowed(auth, site)) continue;
    items.push(await mapSummary(db, alert, site, users.get(alert.workerId)?.name ?? 'Team member'));
  }
  return { items, nextCursor: result.nextCursor };
}

async function detailFor(
  db: Database,
  auth: AuthContext,
  alert: AlertDoc,
): Promise<AlertDetail> {
  const { site, incident, users } = await alertContext(db, alert);
  if (!accessAllowed(auth, site)) throw notFound('Alert not found.');
  const summary = await mapSummary(db, alert, site, users.get(alert.workerId)?.name ?? 'Team member');
  const events: AlertDetail['events'] = [
    {
      at: alert.detectedAt.toISOString(),
      label: 'Device detected outside the boundary',
      detail: incident
        ? `About ${Math.round(incident.distanceMeters ?? 0)} m from the site center.`
        : null,
    },
    { at: alert.receivedAt.toISOString(), label: 'Alert received by Manage', detail: null },
  ];
  if (incident?.confirmedAt) {
    events.push({
      at: incident.confirmedAt.toISOString(),
      label: 'Departure confirmed after the grace interval',
      detail: null,
    });
  }
  if (incident?.returnedAt) {
    events.push({
      at: incident.returnedAt.toISOString(),
      label: 'Device detected back inside the boundary',
      detail: null,
    });
  }
  if (incident?.cancelledAt) {
    events.push({
      at: incident.cancelledAt.toISOString(),
      label: 'Incident closed',
      detail: incident.cancelledReason,
    });
  }
  if (alert.reviewedAt) {
    events.push({
      at: alert.reviewedAt.toISOString(),
      label: `Reviewed: ${alert.reviewDecision?.toLowerCase() ?? 'reviewed'}`,
      detail: alert.reviewNote,
    });
  }
  const shift = incident ? await findShiftById(db.c, incident.shiftId) : null;
  return {
    ...summary,
    shiftId: shift?._id.toHexString() ?? null,
    explanation:
      'Location readings can be imperfect. A departure alert means the device was detected outside the configured boundary after the grace interval. It is a prompt to review, not an automatic disciplinary decision, and it does not clock the worker out.',
    detectionLatitude: incident?.detectionLocation?.coordinates[1] ?? null,
    detectionLongitude: incident?.detectionLocation?.coordinates[0] ?? null,
    detectionAccuracyMeters: incident?.detectionAccuracyMeters ?? null,
    distanceMeters: incident?.distanceMeters ?? null,
    radiusMeters: incident?.radiusMeters ?? site.policy.radiusMeters,
    shiftStartedAt: shift?.startedAt.toISOString() ?? alert.detectedAt.toISOString(),
    review:
      alert.reviewDecision && alert.reviewedAt
        ? {
            decision: alert.reviewDecision,
            note: alert.reviewNote,
            reviewedAt: alert.reviewedAt.toISOString(),
            reviewedBy: users.get(alert.reviewedBy ?? '')?.name ?? 'Site owner',
          }
        : null,
    events,
  };
}

export async function getAlert(
  db: Database,
  auth: AuthContext,
  alertId: ObjectId,
): Promise<AlertDetail> {
  const alert = await findAlertForRecipient(db.c, alertId, auth.user.id);
  if (!alert) throw notFound('Alert not found.');
  const detail = await detailFor(db, auth, alert);
  if (alert.state === 'UNREAD') await markAlertRead(db.c, alert._id);
  return detail;
}

export async function reviewAlertAsOwner(
  db: Database,
  auth: AuthContext,
  alertId: ObjectId,
  input: AlertReview,
  requestId: string,
): Promise<AlertDetail> {
  const alert = await findAlertForRecipient(db.c, alertId, auth.user.id);
  if (!alert) throw notFound('Alert not found.');
  const { site } = await alertContext(db, alert);
  if (!accessAllowed(auth, site)) throw notFound('Alert not found.');
  if (!auth.capabilities.includes('owner.alerts')) {
    throw forbidden('Alert review is not available for this account.');
  }
  const updated = await reviewAlert(db.c, {
    alertId: alert._id,
    recipientId: auth.user.id,
    decision: input.decision,
    note: input.note ?? null,
  });
  if (!updated) throw notFound('Alert not found.');
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'alert.reviewed',
    targetType: 'alert',
    targetId: alert._id.toHexString(),
    organizationId: alert.organizationId,
    siteId: alert.siteId,
    requestId,
    summary: `Reviewed a departure alert as ${input.decision.toLowerCase()}.`,
    meta: { incidentId: alert.incidentId.toHexString(), decision: input.decision },
  });
  return detailFor(db, auth, updated);
}
