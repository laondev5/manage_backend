import { ObjectId, type ClientSession } from 'mongodb';
import type { Collections, IncidentDoc, SiteDoc, ShiftDoc } from '../collections.js';

export async function findOpenIncident(c: Collections, shiftId: ObjectId) {
  return c.incidents.findOne({ shiftId, open: true });
}

export async function upsertCandidateIncident(
  c: Collections,
  input: {
    site: SiteDoc;
    shift: ShiftDoc;
    detectedAt: Date;
    lastEvidenceAt: Date;
    distanceMeters: number;
    accuracyMeters: number;
    latitude: number;
    longitude: number;
  },
  session?: ClientSession,
): Promise<IncidentDoc> {
  const now = new Date();
  const incident = await c.incidents.findOneAndUpdate(
    { shiftId: input.shift._id, open: true },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        organizationId: input.site.organizationId,
        siteId: input.site._id,
        shiftId: input.shift._id,
        userId: input.shift.userId,
        state: 'CANDIDATE',
        open: true,
        detectedAt: input.detectedAt,
        confirmedAt: null,
        returnedAt: null,
        cancelledAt: null,
        cancelledReason: null,
        detectionLocation: {
          type: 'Point',
          coordinates: [input.longitude, input.latitude],
        },
        radiusMeters: input.site.policy.radiusMeters,
        policyVersion: input.site.policyVersion,
        createdAt: now,
      },
      $set: {
        lastEvidenceAt: input.lastEvidenceAt,
        distanceMeters: input.distanceMeters,
        detectionAccuracyMeters: input.accuracyMeters,
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after', session },
  );
  if (!incident) throw new Error('Incident upsert did not return a document.');
  return incident;
}

export async function confirmIncident(
  c: Collections,
  input: {
    incidentId: ObjectId;
    confirmedAt: Date;
    lastEvidenceAt: Date;
    distanceMeters: number;
    accuracyMeters: number;
    latitude: number;
    longitude: number;
  },
  session?: ClientSession,
): Promise<IncidentDoc | null> {
  return c.incidents.findOneAndUpdate(
    { _id: input.incidentId, state: 'CANDIDATE' },
    {
      $set: {
        state: 'CONFIRMED',
        confirmedAt: input.confirmedAt,
        lastEvidenceAt: input.lastEvidenceAt,
        distanceMeters: input.distanceMeters,
        detectionAccuracyMeters: input.accuracyMeters,
        detectionLocation: { type: 'Point', coordinates: [input.longitude, input.latitude] },
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', session },
  );
}

export async function closeIncident(
  c: Collections,
  input: {
    incidentId: ObjectId;
    state: 'RETURNED' | 'CANCELLED';
    at: Date;
    reason: string | null;
  },
  session?: ClientSession,
): Promise<IncidentDoc | null> {
  return c.incidents.findOneAndUpdate(
    { _id: input.incidentId, open: true },
    {
      $set: {
        state: input.state,
        open: false,
        returnedAt: input.state === 'RETURNED' ? input.at : null,
        cancelledAt: input.state === 'CANCELLED' ? input.at : null,
        cancelledReason: input.reason,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after', session },
  );
}

export async function touchIncident(
  c: Collections,
  incidentId: ObjectId,
  lastEvidenceAt: Date,
  session?: ClientSession,
) {
  await c.incidents.updateOne(
    { _id: incidentId },
    { $set: { lastEvidenceAt, updatedAt: new Date() } },
    { session },
  );
}

export async function listIncidentsForShift(c: Collections, shiftId: ObjectId) {
  return c.incidents.find({ shiftId }).sort({ createdAt: 1 }).toArray();
}

export async function findIncident(c: Collections, incidentId: ObjectId) {
  return c.incidents.findOne({ _id: incidentId });
}
