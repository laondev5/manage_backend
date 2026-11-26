import { ObjectId } from 'mongodb';
import {
  AppError,
  forbidden,
  notFound,
  type AttendanceRow,
  type ExportResult,
  type LiveSite,
  type LiveStaff,
  type OwnerInsights,
  type OwnerOverview,
  type SiteLive,
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

const APP_TIMEZONE = 'Africa/Lagos';

/** Calendar day in a fixed reporting zone, so the chart lines up with "today" for owners. */
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function startOfDay(date: Date, timezone: string): Date {
  const key = dayKey(date, timezone);
  // 00:00 in the reporting zone converted back to an instant. The offset is taken
  // from the same instant so a DST-free zone like Lagos resolves exactly.
  const guess = new Date(`${key}T00:00:00Z`);
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(guess);
  const [hours, minutes] = formatted.split(':').map(Number);
  return new Date(guess.getTime() - ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000);
}

function presenceState(shift: ShiftDoc): 'UNKNOWN' | 'INSIDE' | 'EXIT_PENDING' | 'OUTSIDE' | 'NOT_WORKING' {
  return shift.status === 'WORKING' ? shift.presence.state : 'NOT_WORKING';
}

function minutesBetween(start: Date, end: Date | null, now: Date): number | null {
  if (!end) {
    return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60_000));
  }
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}

function attendanceStatus(shift: ShiftDoc, presence: string): AttendanceRow['status'] {
  if (shift.status === 'ENDED') return 'COMPLETED';
  if (presence === 'OUTSIDE' || presence === 'EXIT_PENDING') return 'LEFT_SITE';
  return 'ACTIVE';
}

/**
 * One call that feeds the owner dashboard: the day's totals, a seven-day hours
 * series, the live presence snapshot with coordinates for the map, and the
 * attendance table rows for the selected range.
 */
export async function ownerInsights(
  db: Database,
  auth: AuthContext,
  input: { siteId?: string; from: Date; to: Date; limit: number },
): Promise<OwnerInsights> {
  assertRange(input.from, input.to);
  const siteIds = resolveSiteScope(auth, input.siteId);
  const now = new Date();
  if (!siteIds.length) {
    return {
      generatedAt: now.toISOString(),
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      timezone: APP_TIMEZONE,
      totals: { staffOnSite: 0, staffAssigned: 0, hoursToday: 0, openAlerts: 0, pendingCorrections: 0, notInCount: 0 },
      daily: [],
      statusSplit: { onSite: 0, leftSite: 0, notIn: 0, completed: 0 },
      attendance: [],
      live: { sites: [], staff: [], notIn: [] },
    };
  }

  const [sites, counts, alertCounts, pendingCorrections] = await Promise.all([
    findSitesByIds(db.c, siteIds),
    siteCounts(db.c, siteIds),
    openAlertCountsBySite(db.c, auth.user.id, siteIds),
    db.c.corrections.countDocuments({ siteId: { $in: siteIds }, status: 'PENDING' }),
  ]);
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site]));

  const weekStart = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000), APP_TIMEZONE);
  const tomorrow = new Date(startOfDay(now, APP_TIMEZONE).getTime() + 24 * 60 * 60 * 1000);
  const [working, weekShifts, rangeShifts] = await Promise.all([
    db.c.shifts.find({ siteId: { $in: siteIds }, status: 'WORKING' }).toArray(),
    db.c.shifts
      .find({ siteId: { $in: siteIds }, startedAt: { $gte: weekStart, $lte: tomorrow } })
      .toArray(),
    db.c.shifts
      .find({ siteId: { $in: siteIds }, startedAt: { $gte: input.from, $lte: input.to } })
      .sort({ startedAt: -1 })
      .limit(input.limit)
      .toArray(),
  ]);

  const assignments = await db.c.assignments
    .find({ siteId: { $in: siteIds }, effectiveFrom: { $lte: now }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }] })
    .toArray();
  // Include assigned staff who have not clocked in so their names resolve below.
  const userIds = [
    ...new Set([
      ...working.map((shift) => shift.userId),
      ...rangeShifts.map((shift) => shift.userId),
      ...assignments.map((assignment) => assignment.memberId),
    ]),
  ];
  const users = await usersByIds(db.c, userIds);
  const nameOf = (id: string) => users.get(id)?.name ?? 'Team member';

  let staffOnSite = 0;
  let outsideNow = 0;
  const liveStaff: LiveStaff[] = [];
  const onSiteBySite = new Map<string, number>();
  const outsideBySite = new Map<string, number>();
  for (const shift of working) {
    const site = siteById.get(shift.siteId.toHexString());
    if (!site) continue;
    const inside = shift.presence.state === 'INSIDE';
    if (inside) {
      staffOnSite += 1;
      const key = site._id.toHexString();
      onSiteBySite.set(key, (onSiteBySite.get(key) ?? 0) + 1);
    }
    if (shift.presence.state === 'OUTSIDE' || shift.presence.state === 'EXIT_PENDING') {
      outsideNow += 1;
      const key = site._id.toHexString();
      outsideBySite.set(key, (outsideBySite.get(key) ?? 0) + 1);
    }
    liveStaff.push({
      shiftId: shift._id.toHexString(),
      siteId: site._id.toHexString(),
      siteName: site.name,
      memberId: shift.userId,
      memberName: nameOf(shift.userId),
      startedAt: shift.startedAt.toISOString(),
      presence: shift.presence.state,
      latitude: null,
      longitude: null,
      accuracyMeters: shift.presence.lastAccuracyMeters,
      distanceMeters: shift.presence.lastDistanceMeters,
      lastUpdateAt: shift.presence.lastQualifiedAt?.toISOString() ?? null,
    });
  }

  // The most recent observation carries the coordinate used for the map pin.
  if (working.length) {
    const observations = await db.c.observations
      .find({ shiftId: { $in: working.map((shift) => shift._id) } })
      .sort({ capturedAt: -1 })
      .limit(working.length * 8)
      .toArray();
    const seen = new Set<string>();
    const pointByShift = new Map<string, { lat: number; lng: number }>();
    for (const observation of observations) {
      const key = observation.shiftId.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      pointByShift.set(key, {
        lat: observation.location.coordinates[1],
        lng: observation.location.coordinates[0],
      });
    }
    for (const staff of liveStaff) {
      const point = pointByShift.get(staff.shiftId);
      if (!point) continue;
      staff.latitude = point.lat;
      staff.longitude = point.lng;
    }
  }

  const assignedBySite = new Map<string, number>();
  for (const assignment of assignments) {
    const key = assignment.siteId.toHexString();
    assignedBySite.set(key, (assignedBySite.get(key) ?? 0) + 1);
  }

  const liveSites: LiveSite[] = sites.map((site) => {
    const key = site._id.toHexString();
    const count = counts.get(key) ?? { staffCount: 0, onSiteCount: 0 };
    return {
      id: key,
      name: site.name,
      address: site.address,
      latitude: site.location.coordinates[1],
      longitude: site.location.coordinates[0],
      radiusMeters: site.policy.radiusMeters,
      assignedCount: assignedBySite.get(key) ?? count.staffCount,
      onSiteCount: onSiteBySite.get(key) ?? 0,
      outsideCount: outsideBySite.get(key) ?? 0,
      openAlerts: alertCounts.get(key) ?? 0,
    };
  });

  const workingIds = new Set(working.map((shift) => shift.userId));
  const notIn = assignments
    .filter((assignment) => !workingIds.has(assignment.memberId))
    .slice(0, 50)
    .map((assignment) => {
      const site = siteById.get(assignment.siteId.toHexString());
      return {
        memberId: assignment.memberId,
        memberName: nameOf(assignment.memberId),
        siteId: assignment.siteId.toHexString(),
        siteName: site?.name ?? 'Site',
      };
    });

  const todayKey = dayKey(now, APP_TIMEZONE);
  const daily = Array.from({ length: 7 }).map((_, index) => {
    const day = new Date(startOfDay(now, APP_TIMEZONE).getTime() - (6 - index) * 24 * 60 * 60 * 1000);
    const key = dayKey(day, APP_TIMEZONE);
    const shifts = weekShifts.filter((shift) => dayKey(shift.startedAt, APP_TIMEZONE) === key);
    const minutes = shifts.reduce((total, shift) => {
      const end = shift.endedAt ?? (key === todayKey ? now : shift.startedAt);
      return total + (minutesBetween(shift.startedAt, end, now) ?? 0);
    }, 0);
    return { date: key, hours: Math.round((minutes / 60) * 10) / 10, shifts: shifts.length };
  });

  const todayShifts = weekShifts.filter((shift) => dayKey(shift.startedAt, APP_TIMEZONE) === todayKey);
  const hoursToday =
    todayShifts.reduce((total, shift) => {
      const end = shift.endedAt ?? now;
      return total + (minutesBetween(shift.startedAt, end, now) ?? 0);
    }, 0) / 60;

  const attendance: AttendanceRow[] = rangeShifts.map((shift) => {
    const site = siteById.get(shift.siteId.toHexString());
    const presence = presenceState(shift);
    return {
      shiftId: shift._id.toHexString(),
      memberId: shift.userId,
      memberName: nameOf(shift.userId),
      memberEmail: users.get(shift.userId)?.email ?? '',
      siteId: shift.siteId.toHexString(),
      siteName: site?.name ?? 'Site',
      startedAt: shift.startedAt.toISOString(),
      endedAt: shift.endedAt?.toISOString() ?? null,
      minutes: minutesBetween(shift.startedAt, shift.endedAt, now),
      status: attendanceStatus(shift, presence),
      presence,
      reviewState: shift.reviewState,
      lastDistanceMeters: shift.presence.lastDistanceMeters,
      lastLocationUpdateAt: shift.presence.lastQualifiedAt?.toISOString() ?? null,
      timezone: shift.siteTimezone || site?.timezone || APP_TIMEZONE,
    };
  });

  const completedToday = todayShifts.filter((shift) => shift.status === 'ENDED').length;

  return {
    generatedAt: now.toISOString(),
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    timezone: APP_TIMEZONE,
    totals: {
      staffOnSite,
      staffAssigned: [...assignedBySite.values()].reduce((total, value) => total + value, 0),
      hoursToday: Math.round(hoursToday * 10) / 10,
      openAlerts: [...alertCounts.values()].reduce((total, value) => total + value, 0),
      pendingCorrections,
      notInCount: new Set(notIn.map((entry) => entry.memberId)).size,
    },
    daily,
    statusSplit: {
      onSite: staffOnSite,
      leftSite: outsideNow,
      notIn: notIn.length,
      completed: completedToday,
    },
    attendance,
    live: { sites: liveSites, staff: liveStaff, notIn },
  };
}

/** One site plus the coordinates of everyone currently clocked in there, for the map. */
export async function siteLive(db: Database, auth: AuthContext, siteId: ObjectId): Promise<SiteLive> {
  if (!auth.actor.ownedSiteIds.includes(siteId.toHexString())) {
    throw notFound('Site not found.');
  }
  const now = new Date();
  const site = await findSitesByIds(db.c, [siteId]);
  const found = site[0];
  if (!found) throw notFound('Site not found.');
  const working = await db.c.shifts.find({ siteId, status: 'WORKING' }).toArray();
  const users = await usersByIds(db.c, working.map((shift) => shift.userId));
  const observations = working.length
    ? await db.c.observations
        .find({ shiftId: { $in: working.map((shift) => shift._id) } })
        .sort({ capturedAt: -1 })
        .limit(working.length * 8)
        .toArray()
    : [];
  const pointByShift = new Map<string, { lat: number; lng: number }>();
  for (const observation of observations) {
    const key = observation.shiftId.toHexString();
    if (!pointByShift.has(key)) {
      pointByShift.set(key, {
        lat: observation.location.coordinates[1],
        lng: observation.location.coordinates[0],
      });
    }
  }
  const staff: LiveStaff[] = working.map((shift) => {
    const point = pointByShift.get(shift._id.toHexString());
    return {
      shiftId: shift._id.toHexString(),
      siteId: siteId.toHexString(),
      siteName: found.name,
      memberId: shift.userId,
      memberName: users.get(shift.userId)?.name ?? 'Team member',
      startedAt: shift.startedAt.toISOString(),
      presence: shift.presence.state,
      latitude: point?.lat ?? null,
      longitude: point?.lng ?? null,
      accuracyMeters: shift.presence.lastAccuracyMeters,
      distanceMeters: shift.presence.lastDistanceMeters,
      lastUpdateAt: shift.presence.lastQualifiedAt?.toISOString() ?? null,
    };
  });
  const assignments = await db.c.assignments.countDocuments({
    siteId,
    effectiveFrom: { $lte: now },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
  });
  const alertCounts = await openAlertCountsBySite(db.c, auth.user.id, [siteId]);
  return {
    generatedAt: now.toISOString(),
    site: {
      id: siteId.toHexString(),
      name: found.name,
      address: found.address,
      latitude: found.location.coordinates[1],
      longitude: found.location.coordinates[0],
      radiusMeters: found.policy.radiusMeters,
      assignedCount: assignments,
      onSiteCount: staff.filter((entry) => entry.presence === 'INSIDE').length,
      outsideCount: staff.filter((entry) => entry.presence === 'OUTSIDE' || entry.presence === 'EXIT_PENDING').length,
      openAlerts: alertCounts.get(siteId.toHexString()) ?? 0,
    },
    staff,
  };
}
