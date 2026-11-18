import { ObjectId } from 'mongodb';
import {
  AppError,
  forbidden,
  notFound,
  type ExportResult,
  type OwnerOverview,
  type TimesheetRow,
} from '../contracts/index.js';
import { toCsv, zonedDayRange } from '../domain/index.js';
import {
  appendAudit,
  countOpenAlertsForRecipient,
  countShiftsForExport,
  findSitesByIds,
  listShiftsForExport,
  listShiftsForSites,
  openAlertCountsBySite,
  recentAlertsForRecipient,
  siteCounts,
  sumWorkedMinutesToday,
  usersByIds,
  type Database,
  type ShiftDoc,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
const MAX_EXPORT_ROWS = 10_000;

export function assertRange(from: Date, to: Date, maxDays = MAX_RANGE_DAYS) {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Use a valid date range.');
  }
  if (from.getTime() >= to.getTime()) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The start of the range must be before the end.');
  }
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) {
    throw new AppError(422, 'VALIDATION_ERROR', `Choose a range of at most ${maxDays} days.`);
  }
}

export function ownedSiteIds(auth: AuthContext): ObjectId[] {
  return auth.actor.ownedSiteIds.map((id) => new ObjectId(id));
}

export async function ownerOverview(
  db: Database,
  auth: AuthContext,
): Promise<OwnerOverview> {
  const siteIds = ownedSiteIds(auth);
  const [sites, counts, openAlerts, alertCounts, pendingCorrections, recent] = await Promise.all([
    findSitesByIds(db.c, siteIds),
    siteCounts(db.c, siteIds),
    countOpenAlertsForRecipient(db.c, auth.user.id),
    openAlertCountsBySite(db.c, auth.user.id, siteIds),
    db.c.corrections.countDocuments({ siteId: { $in: siteIds }, status: 'PENDING' }),
    recentAlertsForRecipient(db.c, auth.user.id, siteIds, 5),
  ]);

  const shifts = siteIds.length
    ? await db.c.shifts
        .find({ siteId: { $in: siteIds }, status: 'WORKING' })
        .project({ siteId: 1, presence: 1 })
        .toArray()
    : [];
  const uncertainBySite = new Map<string, number>();
  let staffOnSite = 0;
  for (const shift of shifts) {
    if (shift.presence.state === 'INSIDE') staffOnSite += 1;
    const key = shift.siteId.toHexString();
    if (shift.presence.state === 'UNKNOWN' || shift.presence.state === 'EXIT_PENDING') {
      uncertainBySite.set(key, (uncertainBySite.get(key) ?? 0) + 1);
    }
  }

  const now = new Date();
  let workedMinutes = 0;
  for (const site of sites) {
    const range = zonedDayRange(now, site.timezone);
    workedMinutes += await sumWorkedMinutesToday(db.c, [site._id], range.start, range.end);
  }

  const workers = await usersByIds(db.c, recent.map((alert) => alert.workerId));
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site]));
  return {
    organizationId: auth.activeOrganizationId ?? '',
    staffOnSite,
    staffAssigned: [...counts.values()].reduce((total, entry) => total + entry.staffCount, 0),
    openAlerts,
    pendingCorrections,
    hoursToday: Math.round((workedMinutes / 60) * 10) / 10,
    sites: sites.map((site) => {
      const key = site._id.toHexString();
      const count = counts.get(key) ?? { staffCount: 0, onSiteCount: 0 };
      return {
        id: key,
        name: site.name,
        onSiteCount: count.onSiteCount,
        assignedCount: count.staffCount,
        openAlerts: alertCounts.get(key) ?? 0,
        presenceUncertain: uncertainBySite.get(key) ?? 0,
      };
    }),
    recentAlerts: recent.map((alert) => ({
      id: alert._id.toHexString(),
      siteName: siteById.get(alert.siteId.toHexString())?.name ?? 'Site',
      workerName: workers.get(alert.workerId)?.name ?? 'Team member',
      detectedAt: alert.detectedAt.toISOString(),
      state: alert.state,
    })),
    generatedAt: now.toISOString(),
  };
}

export async function mapTimesheetRows(
  db: Database,
  shifts: ShiftDoc[],
  sites: SiteDoc[],
): Promise<TimesheetRow[]> {
  const users = await usersByIds(db.c, [...new Set(shifts.map((shift) => shift.userId))]);
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site]));
  return shifts
    .map((shift) => {
      const site = siteById.get(shift.siteId.toHexString());
      if (!site) return null;
      return {
        shiftId: shift._id.toHexString(),
        workerName: users.get(shift.userId)?.name ?? 'Team member',
        siteName: site.name,
        startedAt: shift.startedAt.toISOString(),
        endedAt: shift.endedAt?.toISOString() ?? null,
        minutes: shift.endedAt
          ? Math.max(0, Math.floor((shift.endedAt.getTime() - shift.startedAt.getTime()) / 60000))
          : null,
        timezone: shift.siteTimezone || site.timezone,
        status: shift.status,
        reviewState: shift.reviewState,
      } satisfies TimesheetRow;
    })
    .filter((row): row is TimesheetRow => row !== null);
}

export function resolveSiteScope(auth: AuthContext, requestedSiteId?: string): ObjectId[] {
  if (requestedSiteId) {
    if (!auth.actor.ownedSiteIds.includes(requestedSiteId)) {
      throw notFound('Site not found.');
    }
    return [new ObjectId(requestedSiteId)];
  }
  return ownedSiteIds(auth);
}

export async function timesheets(
  db: Database,
  auth: AuthContext,
  input: { siteId?: string; from: Date; to: Date; cursor?: string; limit: number },
) {
  assertRange(input.from, input.to);
  const siteIds = resolveSiteScope(auth, input.siteId);
  const result = await listShiftsForSites(db.c, siteIds, {
    from: input.from,
    to: input.to,
    cursor: input.cursor,
    limit: input.limit,
  });
  const sites = await findSitesByIds(
    db.c,
    [...new Set(result.items.map((shift) => shift.siteId.toHexString()))].map(
      (id) => new ObjectId(id),
    ),
  );
  return { items: await mapTimesheetRows(db, result.items, sites), nextCursor: result.nextCursor };
}

export async function exportTimesheets(
  db: Database,
  auth: AuthContext,
  input: { organizationId: string; siteId?: string; from: Date; to: Date },
  requestId: string,
): Promise<ExportResult> {
  assertRange(input.from, input.to);
  const siteIds = resolveSiteScope(auth, input.siteId);
  if (!siteIds.length) {
    throw forbidden('You do not manage any sites to export.');
  }
  return exportRowsForSites(db, auth, siteIds, new ObjectId(input.organizationId), input.from, input.to, requestId);
}

export async function exportRowsForSites(
  db: Database,
  auth: AuthContext,
  siteIds: ObjectId[],
  organizationId: ObjectId,
  from: Date,
  to: Date,
  requestId: string,
): Promise<ExportResult> {
  assertRange(from, to);
  const count = await countShiftsForExport(db.c, siteIds, from, to);
  if (count > MAX_EXPORT_ROWS) {
    throw new AppError(
      422,
      'EXPORT_TOO_LARGE',
      `This export has ${count} rows. Narrow the date range to ${MAX_EXPORT_ROWS} rows or fewer.`,
    );
  }
  const shifts = await listShiftsForExport(db.c, siteIds, from, to, MAX_EXPORT_ROWS);
  const sites = await findSitesByIds(db.c, siteIds);
  const rows = await mapTimesheetRows(db, shifts, sites);
  const users = await usersByIds(db.c, [...new Set(shifts.map((shift) => shift.userId))]);
  const emailById = new Map([...users.entries()].map(([id, user]) => [id, user.email]));

  const csv = toCsv(
    ['Worker', 'Email', 'Site', 'Timezone', 'Started (UTC)', 'Ended (UTC)', 'Minutes', 'Status', 'Review'],
    shifts.map((shift) => {
      const site = sites.find((entry) => entry._id.equals(shift.siteId));
      return [
        users.get(shift.userId)?.name ?? 'Team member',
        emailById.get(shift.userId) ?? '',
        site?.name ?? '',
        shift.siteTimezone || site?.timezone || '',
        shift.startedAt.toISOString(),
        shift.endedAt?.toISOString() ?? '',
        shift.endedAt
          ? Math.max(0, Math.floor((shift.endedAt.getTime() - shift.startedAt.getTime()) / 60000))
          : '',
        shift.status,
        shift.reviewState,
      ];
    }),
  );

  const generatedAt = new Date();
  const exportId = new ObjectId();
  await db.c.exports.insertOne({
    _id: exportId,
    organizationId,
    siteId: siteIds.length === 1 ? siteIds[0] ?? null : null,
    requestedBy: auth.user.id,
    from,
    to,
    rowCount: rows.length,
    createdAt: generatedAt,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'export.created',
    targetType: 'export',
    targetId: exportId.toHexString(),
    organizationId,
    siteId: siteIds.length === 1 ? siteIds[0] ?? null : null,
    requestId,
    summary: `Exported ${rows.length} attendance rows.`,
    meta: { from: from.toISOString(), to: to.toISOString(), rowCount: rows.length },
  });

  return {
    id: exportId.toHexString(),
    filename: `manage-timesheets-${generatedAt.toISOString().slice(0, 10)}.csv`,
    rowCount: rows.length,
    generatedAt: generatedAt.toISOString(),
    csv,
  };
}
