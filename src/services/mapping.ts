import type {
  AttendanceEvent,
  ShiftDetail,
  ShiftSummary,
  SiteDetail,
  SiteSummary,
} from '../contracts/index.js';
import type {
  AttendanceEventDoc,
  PresenceDoc,
  ShiftDoc,
  SiteDoc,
} from '../database/index.js';

const presenceOf = (presence: PresenceDoc) => presence.state;

export function shiftToSummary(
  shift: ShiftDoc,
  site: Pick<SiteDoc, 'name' | 'timezone'>,
  pendingCorrection = false,
): ShiftSummary {
  const durationMinutes = shift.endedAt
    ? Math.max(0, Math.floor((shift.endedAt.getTime() - shift.startedAt.getTime()) / 60000))
    : null;
  return {
    id: shift._id.toHexString(),
    siteId: shift.siteId.toHexString(),
    siteName: site.name,
    status: shift.status,
    reviewState: shift.reviewState,
    startedAt: shift.startedAt.toISOString(),
    endedAt: shift.endedAt?.toISOString() ?? null,
    durationMinutes,
    timezone: shift.siteTimezone || site.timezone,
    presence: presenceOf(shift.presence),
    lastLocationUpdateAt: shift.presence.lastQualifiedAt?.toISOString() ?? null,
    reviewReason: shift.reviewReason,
    ...(shift.status === 'ENDED' ? { pendingCorrection } : {}),
  };
}

export function shiftToDetail(
  shift: ShiftDoc,
  site: SiteDoc,
  events: AttendanceEventDoc[],
  observations: { count: number; lastAccuracyMeters: number | null; lastCapturedAt: Date | null },
  pendingCorrection = false,
): ShiftDetail {
  const summary = shiftToSummary(shift, site, pendingCorrection);
  return {
    ...summary,
    siteAddress: site.address,
    radiusMeters: site.policy.radiusMeters,
    expectedHours: site.expectedHours
      ? { start: site.expectedHours.start, end: site.expectedHours.end, days: site.expectedHours.days }
      : null,
    events: events.map(eventToSummary),
    observationsSummary: {
      count: observations.count,
      lastAccuracyMeters: observations.lastAccuracyMeters,
      lastCapturedAt: observations.lastCapturedAt?.toISOString() ?? null,
    },
    receipt:
      shift.status === 'ENDED' && shift.endedAt
        ? {
            workedMinutes: Math.max(
              0,
              Math.floor((shift.endedAt.getTime() - shift.startedAt.getTime()) / 60000),
            ),
            startedAt: shift.startedAt.toISOString(),
            endedAt: shift.endedAt.toISOString(),
            note: null,
          }
        : null,
  };
}

export function eventToSummary(event: AttendanceEventDoc): AttendanceEvent {
  return {
    id: event._id.toHexString(),
    type: event.type,
    outcome: event.outcome,
    capturedAt: event.capturedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    siteId: event.siteId.toHexString(),
    accuracyMeters: event.accuracyMeters,
    distanceMeters: event.distanceMeters,
    reviewReason: event.reviewReason,
    note: event.note,
    amended: event.correctionId !== null,
  };
}

export type SiteSummaryExtras = {
  teamLeadName?: string | null;
  inspectorName?: string | null;
  assignmentAcceptedAt?: string | null;
};

export function siteToSummary(
  site: SiteDoc,
  counts?: { staffCount: number; onSiteCount: number },
  extras?: SiteSummaryExtras,
): SiteSummary {
  return {
    id: site._id.toHexString(),
    organizationId: site.organizationId.toHexString(),
    name: site.name,
    address: site.address,
    latitude: site.location.coordinates[1],
    longitude: site.location.coordinates[0],
    timezone: site.timezone,
    radiusMeters: site.policy.radiusMeters,
    policyVersion: site.policyVersion,
    expectedHours: site.expectedHours
      ? { start: site.expectedHours.start, end: site.expectedHours.end, days: site.expectedHours.days }
      : null,
    status: site.status,
    archivedAt: site.archivedAt?.toISOString() ?? null,
    teamLeadId: site.teamLeadId ?? null,
    ...(extras?.teamLeadName !== undefined ? { teamLeadName: extras.teamLeadName } : {}),
    inspectorId: site.inspectorId ?? null,
    ...(extras?.inspectorName !== undefined ? { inspectorName: extras.inspectorName } : {}),
    ...(extras?.assignmentAcceptedAt !== undefined
      ? { assignmentAcceptedAt: extras.assignmentAcceptedAt }
      : {}),
    ...(counts ? { staffCount: counts.staffCount, onSiteCount: counts.onSiteCount } : {}),
  };
}

export function siteToDetail(site: SiteDoc, extras?: SiteSummaryExtras): SiteDetail {
  return {
    ...siteToSummary(site, undefined, extras),
    policy: {
      radiusMeters: site.policy.radiusMeters,
      exitBufferMeters: site.policy.exitBufferMeters,
      entryBufferMeters: site.policy.entryBufferMeters,
      graceSeconds: site.policy.graceSeconds,
      maxAccuracyMeters: site.policy.maxAccuracyMeters,
      freshnessSeconds: site.policy.freshnessSeconds,
    },
    notificationPreferences: { ...site.notificationPreferences },
    version: site.version,
  };
}
