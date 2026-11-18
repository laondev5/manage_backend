import { ObjectId, type ClientSession } from 'mongodb';
import type {
  AttendanceEventDoc,
  Collections,
  CorrectionDoc,
  ObservationDoc,
  ShiftDoc,
} from '../collections.js';

export async function findWorkingShift(c: Collections, userId: string): Promise<ShiftDoc | null> {
  return c.shifts.findOne({ userId, status: 'WORKING' });
}

export async function findShiftById(c: Collections, shiftId: ObjectId): Promise<ShiftDoc | null> {
  return c.shifts.findOne({ _id: shiftId });
}

export async function findShiftByClientId(
  c: Collections,
  userId: string,
  clientShiftId: string,
): Promise<ShiftDoc | null> {
  return c.shifts.findOne({ userId, clientShiftId });
}

export async function insertShift(c: Collections, shift: ShiftDoc, session?: ClientSession) {
  await c.shifts.insertOne(shift, { session });
  return shift;
}

export async function insertAttendanceEvent(
  c: Collections,
  event: AttendanceEventDoc,
  session?: ClientSession,
) {
  await c.attendanceEvents.insertOne(event, { session });
  return event;
}

export async function findEventByClientId(
  c: Collections,
  userId: string,
  deviceId: string,
  clientEventId: string,
) {
  return c.attendanceEvents.findOne({ userId, deviceId, clientEventId });
}

export async function findEventsByClientShift(
  c: Collections,
  userId: string,
  clientShiftId: string,
) {
  return c.attendanceEvents
    .find({ userId, clientShiftId })
    .sort({ capturedAt: 1 })
    .toArray();
}

export async function listActiveShiftForUserInOrg(
  c: Collections,
  userId: string,
  organizationId: ObjectId,
) {
  return c.shifts.findOne({ userId, organizationId, status: 'WORKING' });
}

export async function findLastEndedShift(c: Collections, userId: string) {
  return c.shifts.findOne({ userId, status: 'ENDED' }, { sort: { endedAt: -1 } });
}

export async function findShiftForSite(c: Collections, shiftId: ObjectId, siteId: ObjectId) {
  return c.shifts.findOne({ _id: shiftId, siteId });
}

export async function listShiftsForExport(
  c: Collections,
  siteIds: ObjectId[],
  from: Date,
  to: Date,
  limit: number,
) {
  if (!siteIds.length) return [];
  return c.shifts
    .find({ siteId: { $in: siteIds }, startedAt: { $gte: from, $lte: to } })
    .sort({ startedAt: 1 })
    .limit(limit)
    .toArray();
}

export async function countShiftsForExport(
  c: Collections,
  siteIds: ObjectId[],
  from: Date,
  to: Date,
) {
  if (!siteIds.length) return 0;
  return c.shifts.countDocuments({ siteId: { $in: siteIds }, startedAt: { $gte: from, $lte: to } });
}

export async function sumWorkedMinutesToday(
  c: Collections,
  siteIds: ObjectId[],
  from: Date,
  to: Date,
) {
  if (!siteIds.length) return 0;
  const rows = await c.shifts
    .aggregate<{ total: number }>([
      {
        $match: {
          siteId: { $in: siteIds },
          status: 'ENDED',
          startedAt: { $gte: from, $lte: to },
          endedAt: { $ne: null },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $max: [0, { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 60000] }],
            },
          },
        },
      },
    ])
    .toArray();
  return Math.floor(rows[0]?.total ?? 0);
}

export async function markShiftEnded(
  c: Collections,
  input: {
    shiftId: ObjectId;
    endedAt: Date;
    endCapturedAt: Date;
    endEventId: ObjectId;
    reviewState: ShiftDoc['reviewState'];
    reviewReason: string | null;
  },
  session?: ClientSession,
): Promise<ShiftDoc | null> {
  return c.shifts.findOneAndUpdate(
    { _id: input.shiftId, status: 'WORKING' },
    {
      $set: {
        status: 'ENDED',
        endedAt: input.endedAt,
        endCapturedAt: input.endCapturedAt,
        endEventId: input.endEventId,
        reviewState: input.reviewState,
        reviewReason: input.reviewReason,
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
    { returnDocument: 'after', session },
  );
}

export async function updateShiftPresence(
  c: Collections,
  input: {
    shiftId: ObjectId;
    presence: ShiftDoc['presence'];
  },
  session?: ClientSession,
) {
  await c.shifts.updateOne(
    { _id: input.shiftId, status: 'WORKING' },
    { $set: { presence: input.presence, updatedAt: new Date() }, $inc: { version: 1 } },
    { session },
  );
}

export async function listShiftEvents(c: Collections, shiftId: ObjectId) {
  return c.attendanceEvents.find({ shiftId }).sort({ capturedAt: 1 }).toArray();
}

export type ShiftRange = { from: Date; to: Date; cursor?: string; limit: number };

export async function listShiftsForUser(c: Collections, userId: string, range: ShiftRange) {
  const filter: Record<string, unknown> = {
    userId,
    startedAt: { $gte: range.from, $lte: range.to },
  };
  if (range.cursor && ObjectId.isValid(range.cursor)) {
    filter._id = { $lt: new ObjectId(range.cursor) };
  }
  const docs = await c.shifts
    .find(filter)
    .sort({ _id: -1 })
    .limit(range.limit + 1)
    .toArray();
  const items = docs.slice(0, range.limit);
  return { items, nextCursor: docs.length > range.limit ? items.at(-1)?._id.toHexString() ?? null : null };
}

export async function listShiftsForSites(
  c: Collections,
  siteIds: ObjectId[],
  range: ShiftRange,
  userId?: string,
) {
  if (!siteIds.length) return { items: [], nextCursor: null };
  const filter: Record<string, unknown> = {
    siteId: { $in: siteIds },
    startedAt: { $gte: range.from, $lte: range.to },
  };
  if (userId) filter.userId = userId;
  if (range.cursor && ObjectId.isValid(range.cursor)) {
    filter._id = { $lt: new ObjectId(range.cursor) };
  }
  const docs = await c.shifts
    .find(filter)
    .sort({ _id: -1 })
    .limit(range.limit + 1)
    .toArray();
  const items = docs.slice(0, range.limit);
  return { items, nextCursor: docs.length > range.limit ? items.at(-1)?._id.toHexString() ?? null : null };
}

export async function countWorkingShifts(c: Collections, siteId: ObjectId, userId?: string) {
  return c.shifts.countDocuments({ siteId, status: 'WORKING', ...(userId ? { userId } : {}) });
}

export async function insertObservation(
  c: Collections,
  observation: ObservationDoc,
  session?: ClientSession,
) {
  await c.observations.insertOne(observation, { session });
  return observation;
}

export async function observationExists(
  c: Collections,
  userId: string,
  clientObservationId: string,
) {
  return c.observations.findOne({ userId, clientObservationId });
}

export async function observationSummary(c: Collections, shiftId: ObjectId) {
  const recent = await c.observations.find({ shiftId }).sort({ capturedAt: -1 }).limit(1).toArray();
  const count = await c.observations.countDocuments({ shiftId });
  const last = recent[0];
  return {
    count,
    lastAccuracyMeters: last?.accuracyMeters ?? null,
    lastCapturedAt: last?.capturedAt ?? null,
  };
}

/**
 * Removes precise coordinates once they pass the configured retention window.
 * Distances, accuracy, and outcomes stay on the evidence rows so attendance
 * decisions remain reviewable; only the raw points are discarded.
 */
export async function purgeExpiredLocations(c: Collections, before: Date, limit = 500) {
  const observationIds = await c.observations
    .find({ createdAt: { $lt: before } }, { projection: { _id: 1 } })
    .limit(limit)
    .toArray();
  const eventIds = await c.attendanceEvents
    .find(
      { capturedAt: { $lt: before }, location: { $type: 'object' } },
      { projection: { _id: 1 } },
    )
    .limit(limit)
    .toArray();
  const incidentIds = await c.incidents
    .find(
      { detectedAt: { $lt: before }, detectionLocation: { $type: 'object' } },
      { projection: { _id: 1 } },
    )
    .limit(limit)
    .toArray();

  const observations =
    observationIds.length === 0
      ? 0
      : (await c.observations.deleteMany({ _id: { $in: observationIds.map((doc) => doc._id) } }))
          .deletedCount;
  const events =
    eventIds.length === 0
      ? 0
      : (
          await c.attendanceEvents.updateMany(
            { _id: { $in: eventIds.map((doc) => doc._id) } },
            { $unset: { location: '' } },
          )
        ).modifiedCount;
  const incidents =
    incidentIds.length === 0
      ? 0
      : (
          await c.incidents.updateMany(
            { _id: { $in: incidentIds.map((doc) => doc._id) } },
            { $unset: { detectionLocation: '' } },
          )
        ).modifiedCount;

  return { observations, events, incidents };
}

export async function listShiftsForCorrectionScan(c: Collections, limit = 100) {
  return c.shifts
    .find({ status: 'WORKING', staleFlaggedAt: null })
    .sort({ startedAt: 1 })
    .limit(limit)
    .toArray();
}

export async function createCorrection(c: Collections, doc: CorrectionDoc) {
  await c.corrections.insertOne(doc);
  return doc;
}

export async function findCorrection(c: Collections, correctionId: ObjectId) {
  return c.corrections.findOne({ _id: correctionId });
}

export async function findPendingCorrectionForShift(c: Collections, shiftId: ObjectId) {
  return c.corrections.findOne({ shiftId, status: 'PENDING' });
}

export async function listCorrectionsForSites(
  c: Collections,
  siteIds: ObjectId[],
  status: CorrectionDoc['status'] | undefined,
  cursor: string | undefined,
  limit: number,
) {
  if (!siteIds.length) return { items: [], nextCursor: null };
  const filter: Record<string, unknown> = { siteId: { $in: siteIds } };
  if (status) filter.status = status;
  if (cursor && ObjectId.isValid(cursor)) filter._id = { $lt: new ObjectId(cursor) };
  const docs = await c.corrections
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .toArray();
  const items = docs.slice(0, limit);
  return { items, nextCursor: docs.length > limit ? items.at(-1)?._id.toHexString() ?? null : null };
}

export async function listCorrectionsForWorker(c: Collections, workerId: string) {
  return c.corrections.find({ workerId }).sort({ createdAt: -1 }).limit(50).toArray();
}

export async function decideCorrection(
  c: Collections,
  input: {
    correctionId: ObjectId;
    expectedVersion: number;
    status: 'APPROVED' | 'REJECTED';
    reviewerId: string;
    reviewerNote: string | null;
  },
  session?: ClientSession,
): Promise<CorrectionDoc | null> {
  return c.corrections.findOneAndUpdate(
    {
      _id: input.correctionId,
      status: 'PENDING',
      version: input.expectedVersion,
    },
    {
      $set: {
        status: input.status,
        reviewerId: input.reviewerId,
        reviewerNote: input.reviewerNote,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
    { returnDocument: 'after', session },
  );
}

export async function applyShiftAmendment(
  c: Collections,
  input: {
    shiftId: ObjectId;
    startedAt: Date;
    endedAt: Date | null;
    reviewState: ShiftDoc['reviewState'];
  },
  session?: ClientSession,
) {
  await c.shifts.updateOne(
    { _id: input.shiftId },
    {
      $set: {
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        reviewState: input.reviewState,
        reviewReason: null,
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
    { session },
  );
}

export async function pendingCorrectionShiftIds(c: Collections, shiftIds: ObjectId[]) {
  if (!shiftIds.length) return new Set<string>();
  const docs = await c.corrections
    .find({ shiftId: { $in: shiftIds }, status: 'PENDING' })
    .toArray();
  return new Set(docs.map((doc) => doc.shiftId.toHexString()));
}
