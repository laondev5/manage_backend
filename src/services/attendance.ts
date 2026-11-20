import { ObjectId } from 'mongodb';
import {
  conflict,
  forbidden,
  notFound,
  type AttendanceEventInput,
  type CurrentShiftResponse,
  type ShiftDetail,
  type ShiftSummary,
  type SyncItemResult,
} from '../contracts/index.js';
import {
  canManageSite,
  canViewOperationalAttendance,
  decideClockIn,
  type ScopedActor,
} from '../domain/index.js';
import {
  findActiveAssignment,
  findEventByClientId,
  findEventsByClientShift,
  findLastEndedShift,
  findOpenIncident,
  findPendingCorrectionForShift,
  findShiftByClientId,
  findShiftById,
  findSite,
  findWorkingShift,
  insertAttendanceEvent,
  insertShift,
  isDuplicateKey,
  listShiftEvents,
  listShiftsForUser,
  markShiftEnded,
  observationSummary,
  pendingCorrectionShiftIds,
  withTransaction,
  type AttendanceEventDoc,
  type Database,
  type ShiftDoc,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';
import { shiftToDetail, shiftToSummary } from './mapping.js';

export type ClockResult = {
  outcome: SyncItemResult['outcome'];
  eventId: string | null;
  shift: ShiftSummary | null;
  message: string;
  reviewReason: string | null;
};

const pointOf = (site: SiteDoc) => ({
  latitude: site.location.coordinates[1],
  longitude: site.location.coordinates[0],
});

const OUTCOME_MESSAGE: Record<SyncItemResult['outcome'], string> = {
  ACCEPTED: 'Recorded.',
  NEEDS_REVIEW: 'Recorded and sent for review.',
  REJECTED: 'This record was not accepted.',
  DUPLICATE: 'This record was already saved.',
};

async function pairShift(
  db: Database,
  shift: ShiftDoc,
): Promise<{ shift: ShiftDoc; site: SiteDoc } | null> {
  const site = await findSite(db.c, shift.siteId);
  return site ? { shift, site } : null;
}

async function duplicateResult(
  db: Database,
  event: AttendanceEventDoc,
): Promise<ClockResult> {
  const shift = await findShiftById(db.c, event.shiftId);
  const paired = shift ? await pairShift(db, shift) : null;
  return {
    outcome: 'DUPLICATE',
    eventId: event._id.toHexString(),
    shift: paired ? shiftToSummary(paired.shift, paired.site) : null,
    message: OUTCOME_MESSAGE.DUPLICATE,
    reviewReason: event.reviewReason,
  };
}

async function orphanEvent(
  db: Database,
  auth: AuthContext,
  input: AttendanceEventInput,
  type: AttendanceEventDoc['type'],
  outcome: AttendanceEventDoc['outcome'],
  reviewReason: string,
  requestId: string,
): Promise<ClockResult> {
  const site = await findSite(db.c, new ObjectId(input.siteId));
  const capturedAt = new Date(input.capturedAt);
  const now = new Date();
  const event: AttendanceEventDoc = {
    _id: new ObjectId(),
    organizationId: site?.organizationId ?? new ObjectId(),
    siteId: new ObjectId(input.siteId),
    shiftId: new ObjectId(),
    userId: auth.user.id,
    deviceId: input.deviceId,
    clientEventId: input.clientEventId,
    clientShiftId: input.clientShiftId,
    type,
    outcome,
    capturedAt,
    receivedAt: now,
    receivedOffsetSeconds: Math.round((now.getTime() - capturedAt.getTime()) / 1000),
    location: input.location
      ? {
          type: 'Point',
          coordinates: [input.location.longitude, input.location.latitude],
        }
      : null,
    accuracyMeters: input.location?.accuracyMeters ?? null,
    distanceMeters: null,
    sitePolicyVersion: input.sitePolicyVersion ?? 1,
    reviewReason,
    note: input.note ?? null,
    syncState: outcome === 'REJECTED' ? 'REJECTED' : 'NEEDS_REVIEW',
    correctionId: null,
    requestId,
    createdAt: now,
  };
  await insertAttendanceEvent(db.c, event);
  return {
    outcome,
    eventId: event._id.toHexString(),
    shift: null,
    message: outcome === 'REJECTED' ? reviewReason : OUTCOME_MESSAGE[outcome],
    reviewReason,
  };
}

async function clockIn(
  db: Database,
  auth: AuthContext,
  input: AttendanceEventInput,
  requestId: string,
): Promise<ClockResult> {
  const site = await findSite(db.c, new ObjectId(input.siteId));
  if (!site) return orphanEvent(db, auth, input, 'CLOCK_IN', 'REJECTED', 'This site could not be found.', requestId);

  const existingWorking = await findWorkingShift(db.c, auth.user.id);
  if (existingWorking) {
    if (existingWorking.clientShiftId === input.clientShiftId) {
      const siteDoc = await findSite(db.c, existingWorking.siteId);
      return {
        outcome: 'DUPLICATE',
        eventId: null,
        shift: siteDoc ? shiftToSummary(existingWorking, siteDoc) : null,
        message: 'You are already clocked in for this shift.',
        reviewReason: existingWorking.reviewReason,
      };
    }
    return {
      outcome: 'REJECTED',
      eventId: null,
      shift: null,
      message: 'An active shift already exists for this account. Clock out before starting another.',
      reviewReason: 'An active shift already exists for this account.',
    };
  }

  const alreadyMapped = await findShiftByClientId(db.c, auth.user.id, input.clientShiftId);
  if (alreadyMapped) {
    const siteDoc = await findSite(db.c, alreadyMapped.siteId);
    return {
      outcome: 'DUPLICATE',
      eventId: null,
      shift: siteDoc ? shiftToSummary(alreadyMapped, siteDoc) : null,
      message: 'This shift was already recorded.',
      reviewReason: alreadyMapped.reviewReason,
    };
  }

  const membership = auth.context.memberships.find((entry) =>
    entry.organization._id.equals(site.organizationId),
  );
  if (
    !membership ||
    membership.membership.status !== 'ACTIVE' ||
    membership.organization.status !== 'ACTIVE'
  ) {
    return orphanEvent(
      db,
      auth,
      input,
      'CLOCK_IN',
      'REJECTED',
      'Your access to this site is not active. Ask your site owner to restore it.',
      requestId,
    );
  }

  const assignment = await findActiveAssignment(db.c, site._id, auth.user.id);
  if (assignment?.acceptedAt === null) {
    return orphanEvent(
      db,
      auth,
      input,
      'CLOCK_IN',
      'REJECTED',
      'Accept this site assignment before you clock in.',
      requestId,
    );
  }
  // Resolve the policy valid at capture time on the server; never let a client
  // select an older, more permissive boundary by supplying a version number.
  const policyRecord = await db.c.sitePolicies.findOne({ siteId: site._id,
    createdAt: { $lte: new Date(input.capturedAt) },
  }, { sort: { createdAt: -1, version: -1 } });
  const policy = policyRecord?.policy ?? site.policy;
  const sitePoint = policyRecord
    ? {
        latitude: policyRecord.center.coordinates[1],
        longitude: policyRecord.center.coordinates[0],
      }
    : pointOf(site);

  const capturedAt = new Date(input.capturedAt);
  if (input.location && Math.abs(capturedAt.getTime() - new Date(input.location.capturedAt).getTime()) > policy.freshnessSeconds * 1000) {
    return orphanEvent(db, auth, input, 'CLOCK_IN', 'REJECTED', 'Obtain a fresh location reading before clocking in.', requestId);
  }
  const decision = decideClockIn({
    assignmentActive: Boolean(assignment),
    siteActive: site.status === 'ACTIVE',
    hasWorkingShift: false,
    site: sitePoint,
    policy,
    location: input.location
      ? {
          point: { latitude: input.location.latitude, longitude: input.location.longitude },
          accuracyMeters: input.location.accuracyMeters,
        }
      : null,
    capturedAt,
    now: new Date(),
  });

  if (decision.outcome === 'REJECTED') {
    return orphanEvent(
      db,
      auth,
      input,
      'CLOCK_IN',
      'REJECTED',
      decision.reviewReason ?? 'This clock-in was rejected.',
      requestId,
    );
  }

  const now = new Date();
  const reviewState = decision.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_REVIEW';
  const shift: ShiftDoc = {
    _id: new ObjectId(),
    organizationId: site.organizationId,
    siteId: site._id,
    userId: auth.user.id,
    clientShiftId: input.clientShiftId,
    status: 'WORKING',
    reviewState,
    startedAt: capturedAt,
    endedAt: null,
    startCapturedAt: capturedAt,
    endCapturedAt: null,
    startEventId: null,
    endEventId: null,
    presence: {
      state: decision.classification === 'INSIDE' ? 'INSIDE' : 'UNKNOWN',
      candidateSince: null,
      lastQualifiedAt: decision.classification === 'INSIDE' ? capturedAt : null,
      lastAccuracyMeters: input.location?.accuracyMeters ?? null,
      lastDistanceMeters: decision.distanceMeters,
      updatedAt: now,
    },
    policyVersion: policyRecord?.version ?? site.policyVersion,
    siteTimezone: policyRecord?.timezone ?? site.timezone,
    reviewReason: decision.reviewReason,
    staleFlaggedAt: null,
    lastSyncAt: now,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const eventId = new ObjectId();
  const event: AttendanceEventDoc = {
    _id: eventId,
    organizationId: site.organizationId,
    siteId: site._id,
    shiftId: shift._id,
    userId: auth.user.id,
    deviceId: input.deviceId,
    clientEventId: input.clientEventId,
    clientShiftId: input.clientShiftId,
    type: 'CLOCK_IN',
    outcome: decision.outcome,
    capturedAt,
    receivedAt: now,
    receivedOffsetSeconds: Math.round((now.getTime() - capturedAt.getTime()) / 1000),
    location: input.location
      ? { type: 'Point', coordinates: [input.location.longitude, input.location.latitude] }
      : null,
    accuracyMeters: input.location?.accuracyMeters ?? null,
    distanceMeters: decision.distanceMeters,
    sitePolicyVersion: shift.policyVersion,
    reviewReason: decision.reviewReason,
    note: input.note ?? null,
    syncState: decision.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_REVIEW',
    correctionId: null,
    requestId,
    createdAt: now,
  };
  shift.startEventId = eventId;

  try {
    await withTransaction(db, async (session) => {
      await insertShift(db.c, shift, session);
      try {
        await insertAttendanceEvent(db.c, event, session);
      } catch (error) {
        if (db.supportsTransactions === false) {
          // No transaction rolled the shift insert back; remove the eventless
          // shift so the account is not wedged with an unclock-outable start.
          await db.c.shifts
            .deleteOne({ _id: shift._id, status: 'WORKING', startEventId: eventId, version: 1 })
            .catch(() => undefined);
        }
        throw error;
      }
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const raced = await findWorkingShift(db.c, auth.user.id);
      if (raced) {
        const siteDoc = await findSite(db.c, raced.siteId);
        return {
          outcome: raced.clientShiftId === input.clientShiftId ? 'DUPLICATE' : 'REJECTED',
          eventId: null,
          shift: siteDoc ? shiftToSummary(raced, siteDoc) : null,
          message:
            raced.clientShiftId === input.clientShiftId
              ? 'You are already clocked in for this shift.'
              : 'An active shift already exists for this account.',
          reviewReason: raced.reviewReason,
        };
      }
    }
    throw error;
  }

  return {
    outcome: decision.outcome,
    eventId: eventId.toHexString(),
    shift: shiftToSummary(shift, site),
    message:
      decision.outcome === 'ACCEPTED'
        ? 'You are clocked in.'
        : (decision.reviewReason ?? OUTCOME_MESSAGE.NEEDS_REVIEW),
    reviewReason: decision.reviewReason,
  };
}

async function clockOut(
  db: Database,
  auth: AuthContext,
  input: AttendanceEventInput,
  requestId: string,
): Promise<ClockResult> {
  const working = await findWorkingShift(db.c, auth.user.id);
  if (!working || working.clientShiftId !== input.clientShiftId || working.siteId.toHexString() !== input.siteId) {
    const mapped = await findShiftByClientId(db.c, auth.user.id, input.clientShiftId);
    if (mapped) {
      const paired = await pairShift(db, mapped);
      return {
        outcome: 'DUPLICATE',
        eventId: null,
        shift: paired ? shiftToSummary(paired.shift, paired.site) : null,
        message: 'This shift has already ended.',
        reviewReason: mapped.reviewReason,
      };
    }
    const priorEvents = await findEventsByClientShift(db.c, auth.user.id, input.clientShiftId);
    const priorStart = priorEvents.find((event) => event.type === 'CLOCK_IN');
    if (priorStart) {
      return orphanEvent(
        db,
        auth,
        input,
        'CLOCK_OUT',
        'NEEDS_REVIEW',
        'The linked clock-in was not accepted. This clock-out is kept for review and was not attached to another shift.',
        requestId,
      );
    }
    return orphanEvent(
      db,
      auth,
      input,
      'CLOCK_OUT',
      'REJECTED',
      working
        ? 'This clock-out does not match the active shift, so it was not attached to it.'
        : 'No matching clock-in was found for this clock-out.',
      requestId,
    );
  }

  const site = await findSite(db.c, working.siteId);
  if (!site) throw notFound('The site for this shift could not be found.');

  const capturedAt = new Date(input.capturedAt);
  if (capturedAt.getTime() < working.startedAt.getTime()) {
    throw conflict('The clock-out time is before the shift start. Check the device time.');
  }
  const now = new Date();
  const lateByMs = now.getTime() - capturedAt.getTime();
  const late = lateByMs > 24 * 60 * 60 * 1000;
  const reviewState: ShiftDoc['reviewState'] =
    working.reviewState === 'NEEDS_REVIEW'
      ? 'NEEDS_REVIEW'
      : late
        ? 'NEEDS_REVIEW'
        : 'ACCEPTED';
  const reviewReason =
    working.reviewReason ??
    (late ? 'The clock-out was received more than 24 hours after it was captured.' : null);

  const eventId = new ObjectId();
  const event: AttendanceEventDoc = {
    _id: eventId,
    organizationId: working.organizationId,
    siteId: working.siteId,
    shiftId: working._id,
    userId: auth.user.id,
    deviceId: input.deviceId,
    clientEventId: input.clientEventId,
    clientShiftId: input.clientShiftId,
    type: 'CLOCK_OUT',
    outcome: reviewState === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_REVIEW',
    capturedAt,
    receivedAt: now,
    receivedOffsetSeconds: Math.round(lateByMs / 1000),
    location: input.location
      ? { type: 'Point', coordinates: [input.location.longitude, input.location.latitude] }
      : null,
    accuracyMeters: input.location?.accuracyMeters ?? null,
    distanceMeters: null,
    sitePolicyVersion: working.policyVersion,
    reviewReason,
    note: input.note ?? null,
    syncState: reviewState === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_REVIEW',
    correctionId: null,
    requestId,
    createdAt: now,
  };

  let ended = false;
  await withTransaction(db, async (session) => {
    const updated = await markShiftEnded(
      db.c,
      {
        shiftId: working._id,
        endedAt: capturedAt,
        endCapturedAt: capturedAt,
        endEventId: eventId,
        reviewState,
        reviewReason,
      },
      session,
    );
    if (!updated) return;
    ended = true;
    await insertAttendanceEvent(db.c, event, session);
    const incident = await findOpenIncident(db.c, working._id);
    if (incident) {
      await db.c.incidents.updateOne(
        { _id: incident._id, open: true },
        {
          $set: {
            open: false,
            state: incident.state === 'CONFIRMED' ? 'CONFIRMED' : 'CANCELLED',
            cancelledAt: incident.state === 'CONFIRMED' ? null : now,
            cancelledReason: 'Shift ended.',
            updatedAt: now,
          },
        },
        { session },
      );
      if (incident.state !== 'CONFIRMED') {
        await db.c.outbox.updateMany(
          { incidentId: incident._id, state: { $in: ['PENDING', 'FAILED', 'LEASED'] } },
          { $set: { state: 'CANCELLED', leaseOwner: null, leaseUntil: null, updatedAt: now } },
          { session },
        );
      }
    }
  });

  if (!ended) {
    const latest = await findShiftById(db.c, working._id);
    if (latest?.status === 'ENDED') {
      const paired = await pairShift(db, latest);
      return {
        outcome: 'DUPLICATE',
        eventId: null,
        shift: paired ? shiftToSummary(paired.shift, paired.site) : null,
        message: 'This shift has already ended.',
        reviewReason: latest.reviewReason,
      };
    }
    throw conflict('The shift changed while clocking out. Refresh and try again.');
  }

  const endedShift: ShiftDoc = {
    ...working,
    status: 'ENDED',
    endedAt: capturedAt,
    endCapturedAt: capturedAt,
    endEventId: eventId,
    reviewState,
    reviewReason,
    updatedAt: now,
  };
  return {
    outcome: reviewState === 'ACCEPTED' ? 'ACCEPTED' : 'NEEDS_REVIEW',
    eventId: eventId.toHexString(),
    shift: shiftToSummary(endedShift, site),
    message:
      reviewState === 'ACCEPTED'
        ? 'You are clocked out.'
        : (reviewReason ?? 'Your shift ended and was sent for review.'),
    reviewReason,
  };
}

export async function processAttendanceEvent(
  db: Database,
  auth: AuthContext,
  input: AttendanceEventInput,
  requestId: string,
): Promise<ClockResult> {
  const existing = await findEventByClientId(db.c, auth.user.id, input.deviceId, input.clientEventId);
  if (existing) return duplicateResult(db, existing);
  if (input.type === 'CLOCK_IN') return clockIn(db, auth, input, requestId);
  return clockOut(db, auth, input, requestId);
}

export async function currentShift(db: Database, auth: AuthContext): Promise<CurrentShiftResponse> {
  const working = await findWorkingShift(db.c, auth.user.id);
  const lastEnded = working ? null : await findLastEndedShift(db.c, auth.user.id);
  const shifts = [working, lastEnded].filter((shift): shift is ShiftDoc => Boolean(shift));
  const sites = await Promise.all(shifts.map((shift) => findSite(db.c, shift.siteId)));
  const pending = await pendingCorrectionShiftIds(
    db.c,
    shifts.map((shift) => shift._id),
  );
  const map = (shift: ShiftDoc | null, index: number): ShiftSummary | null => {
    if (!shift) return null;
    const site = sites[index];
    if (!site) return null;
    return shiftToSummary(shift, site, pending.has(shift._id.toHexString()));
  };
  return {
    serverTime: new Date().toISOString(),
    activeShift: map(working, 0),
    lastEndedShift: working ? null : map(lastEnded, 1),
  };
}

export async function shiftHistory(
  db: Database,
  auth: AuthContext,
  input: { from: Date; to: Date; cursor?: string; limit: number },
) {
  const result = await listShiftsForUser(db.c, auth.user.id, input);
  const siteIds = [...new Set(result.items.map((shift) => shift.siteId.toHexString()))];
  const sites = siteIds.length
    ? await Promise.all(siteIds.map((id) => findSite(db.c, new ObjectId(id))))
    : [];
  const siteById = new Map(sites.filter((site): site is SiteDoc => Boolean(site)).map((site) => [site._id.toHexString(), site]));
  const pending = await pendingCorrectionShiftIds(
    db.c,
    result.items.map((shift) => shift._id),
  );
  return {
    items: result.items
      .map((shift) => {
        const site = siteById.get(shift.siteId.toHexString());
        return site ? shiftToSummary(shift, site, pending.has(shift._id.toHexString())) : null;
      })
      .filter((item): item is ShiftSummary => item !== null),
    nextCursor: result.nextCursor,
  };
}

export function canReadShift(actor: ScopedActor, shift: ShiftDoc): boolean {
  if (shift.userId === actor.userId) return true;
  const site = { organizationId: shift.organizationId.toHexString(), id: shift.siteId.toHexString() };
  return (
    canManageSite(actor, site) ||
    canViewOperationalAttendance(actor, shift.organizationId.toHexString())
  );
}

export async function shiftDetail(
  db: Database,
  auth: AuthContext,
  shiftId: ObjectId,
): Promise<ShiftDetail> {
  const shift = await findShiftById(db.c, shiftId);
  if (!shift) throw notFound('Shift not found.');
  if (!canReadShift(auth.actor, shift)) throw notFound('Shift not found.');
  const site = await findSite(db.c, shift.siteId);
  if (!site) throw notFound('Site not found.');
  const [events, observations, pending] = await Promise.all([
    listShiftEvents(db.c, shift._id),
    observationSummary(db.c, shift._id),
    findPendingCorrectionForShift(db.c, shift._id),
  ]);
  return shiftToDetail(shift, site, events, observations, Boolean(pending));
}

export async function assertCanClockIn(auth: AuthContext, site: SiteDoc): Promise<void> {
  if (!auth.actor.assignedSiteIds.includes(site._id.toHexString())) {
    throw forbidden('You are not assigned to this site.');
  }
  if (!auth.capabilities.includes('staff.clock')) {
    throw forbidden('Clock-in is not available for this account.');
  }
}
