import { ObjectId } from 'mongodb';
import type { z } from 'zod';
import { conflict, notFound, validationError, type observationInputSchema } from '../contracts/index.js';
import { evaluatePresence, type PresenceRecord } from '../domain/index.js';
import {
  confirmIncident,
  createIncidentAlerts,
  findOpenIncident,
  findShiftById,
  findSite,
  getPolicyAtVersion,
  insertObservation,
  isDuplicateKey,
  markIncidentAlertsUpdated,
  observationExists,
  resolveAlertRecipients,
  touchIncident,
  updateShiftPresence,
  upsertCandidateIncident,
  withTransaction,
  type Database,
  type ShiftDoc,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

type ObservationInput = z.infer<typeof observationInputSchema>;

const toPresenceRecord = (shift: ShiftDoc): PresenceRecord => ({
  state: shift.presence.state,
  candidateSince: shift.presence.candidateSince?.toISOString() ?? null,
  lastQualifiedAt: shift.presence.lastQualifiedAt?.toISOString() ?? null,
  lastAccuracyMeters: shift.presence.lastAccuracyMeters,
  lastDistanceMeters: shift.presence.lastDistanceMeters,
});

const sitePoint = (site: SiteDoc, record: Awaited<ReturnType<typeof getPolicyAtVersion>>) =>
  record
    ? {
        latitude: record.center.coordinates[1],
        longitude: record.center.coordinates[0],
      }
    : {
        latitude: site.location.coordinates[1],
        longitude: site.location.coordinates[0],
      };

export async function ingestObservation(
  db: Database,
  auth: AuthContext,
  input: ObservationInput,
) {
  const shift = await findShiftById(db.c, new ObjectId(input.shiftId));
  if (!shift || shift.userId !== auth.user.id) throw notFound('Active shift not found.');
  if (shift.status !== 'WORKING') {
    throw conflict('This shift has ended, so location collection is stopped.', 'SHIFT_NOT_ACTIVE');
  }
  if (shift.siteId.toHexString() !== input.siteId) {
    throw validationError('The observation does not match the active shift site.', {
      siteId: ['Use the site of the active shift.'],
    });
  }

  const duplicate = await observationExists(db.c, auth.user.id, input.clientObservationId);
  if (duplicate) {
    return {
      accepted: duplicate.classification !== 'STALE',
      presence: shift.presence.state,
      recordedAt: duplicate.receivedAt.toISOString(),
      reason: 'This observation was already recorded.',
    };
  }

  const site = await findSite(db.c, shift.siteId);
  if (!site) throw notFound('Site not found.');

  const now = new Date();
  const capturedAt = new Date(input.capturedAt);
  const policyRecord = await getPolicyAtVersion(db.c, shift.siteId, shift.policyVersion);
  const policy = policyRecord?.policy ?? site.policy;
  const decision = evaluatePresence({
    previous: toPresenceRecord(shift),
    reading: {
      point: { latitude: input.latitude, longitude: input.longitude },
      accuracyMeters: input.accuracyMeters,
      capturedAt,
    },
    site: sitePoint(site, policyRecord),
    policy,
    receivedAt: now,
  });

  const observationId = new ObjectId();
  const presenceUpdate: ShiftDoc['presence'] = {
    state: decision.next.state,
    candidateSince: decision.next.candidateSince ? new Date(decision.next.candidateSince) : null,
    lastQualifiedAt: decision.next.lastQualifiedAt ? new Date(decision.next.lastQualifiedAt) : null,
    lastAccuracyMeters: decision.next.lastAccuracyMeters,
    lastDistanceMeters: decision.next.lastDistanceMeters,
    updatedAt: now,
  };

  try {
    await withTransaction(db, async (session) => {
      await insertObservation(
        db.c,
        {
          _id: observationId,
          organizationId: shift.organizationId,
          siteId: shift.siteId,
          shiftId: shift._id,
          userId: auth.user.id,
          clientObservationId: input.clientObservationId,
          location: { type: 'Point', coordinates: [input.longitude, input.latitude] },
          accuracyMeters: input.accuracyMeters,
          capturedAt,
          receivedAt: now,
          source: input.source,
          policyVersion: policyRecord?.version ?? shift.policyVersion,
          classification: decision.classification,
          distanceMeters: decision.distanceMeters ?? 0,
          action: decision.action,
          createdAt: now,
        },
        session,
      );
      await updateShiftPresence(
        db.c,
        { shiftId: shift._id, presence: presenceUpdate },
        session,
      );

      // The candidate incident already exists, so a shift that is still inside can
      // have a reading that arrives after the confirm window. Confirm it on the next
      // inside reading so a departure is never lost between worker ticks.
      if (
        decision.classification === 'INSIDE' &&
        (decision.action === 'CANDIDATE_CANCELLED' || decision.action === 'RETURNED')
      ) {
        const open = await findOpenIncident(db.c, shift._id);
        if (open?.state === 'CANDIDATE') {
          const confirmed = await confirmIncident(
            db.c,
            {
              incidentId: open._id,
              confirmedAt: capturedAt,
              lastEvidenceAt: open.lastEvidenceAt,
              distanceMeters: open.distanceMeters ?? 0,
              accuracyMeters: open.detectionAccuracyMeters ?? 0,
              latitude: open.detectionLocation?.coordinates[1] ?? 0,
              longitude: open.detectionLocation?.coordinates[0] ?? 0,
            },
            session,
          );
          if (confirmed) {
            const recipients = await resolveAlertRecipients(db.c, site);
            await createIncidentAlerts(db.c, { incident: confirmed, site, recipients }, session);
          }
        }
      }

      if (decision.action === 'CANDIDATE_OPENED') {
        await upsertCandidateIncident(
          db.c,
          {
            site,
            shift,
            detectedAt: capturedAt,
            lastEvidenceAt: capturedAt,
            distanceMeters: decision.distanceMeters ?? 0,
            accuracyMeters: input.accuracyMeters,
            latitude: input.latitude,
            longitude: input.longitude,
          },
          session,
        );
      }

      if (decision.action === 'DEPARTURE_CONFIRMED') {
        let incident = await findOpenIncident(db.c, shift._id);
        if (!incident) {
          incident = await upsertCandidateIncident(
            db.c,
            {
              site,
              shift,
              detectedAt: capturedAt,
              lastEvidenceAt: capturedAt,
              distanceMeters: decision.distanceMeters ?? 0,
              accuracyMeters: input.accuracyMeters,
              latitude: input.latitude,
              longitude: input.longitude,
            },
            session,
          );
        }
        if (incident.state === 'CANDIDATE') {
          const confirmed = await confirmIncident(
            db.c,
            {
              incidentId: incident._id,
              confirmedAt: capturedAt,
              lastEvidenceAt: capturedAt,
              distanceMeters: decision.distanceMeters ?? 0,
              accuracyMeters: input.accuracyMeters,
              latitude: input.latitude,
              longitude: input.longitude,
            },
            session,
          );
          if (confirmed) {
            const recipients = await resolveAlertRecipients(db.c, site);
            await createIncidentAlerts(db.c, { incident: confirmed, site, recipients }, session);
          }
        } else {
          await touchIncident(db.c, incident._id, capturedAt, session);
          await markIncidentAlertsUpdated(db.c, incident._id, session);
        }
      }

      if (decision.action === 'RETURNED') {
        const incident = await findOpenIncident(db.c, shift._id);
        if (incident) {
          await db.c.incidents.updateOne(
            { _id: incident._id, open: true },
            {
              $set: {
                open: false,
                state: 'RETURNED',
                returnedAt: capturedAt,
                lastEvidenceAt: capturedAt,
                updatedAt: now,
              },
            },
            { session },
          );
          await markIncidentAlertsUpdated(db.c, incident._id, session);
        }
      }

      if (decision.action === 'CANDIDATE_CANCELLED') {
        const incident = await findOpenIncident(db.c, shift._id);
        if (incident) {
          await db.c.incidents.updateOne(
            { _id: incident._id, open: true },
            {
              $set: {
                open: false,
                state: 'CANCELLED',
                cancelledAt: capturedAt,
                cancelledReason: 'The worker was detected inside the boundary during the grace interval.',
                lastEvidenceAt: capturedAt,
                updatedAt: now,
              },
            },
            { session },
          );
          await db.c.outbox.updateMany(
            { incidentId: incident._id, state: { $in: ['PENDING', 'FAILED'] } },
            { $set: { state: 'CANCELLED', updatedAt: now } },
            { session },
          );
        }
      }

      if (decision.classification === 'OUTSIDE' && decision.action === 'NONE') {
        const incident = await findOpenIncident(db.c, shift._id);
        if (incident) {
          await touchIncident(db.c, incident._id, capturedAt, session);
          if (incident.state === 'CONFIRMED') {
            await markIncidentAlertsUpdated(db.c, incident._id, session);
          }
        }
      }
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const latest = await findShiftById(db.c, shift._id);
      return {
        accepted: false,
        presence: latest?.presence.state ?? shift.presence.state,
        recordedAt: now.toISOString(),
        reason: 'This observation was already recorded.',
      };
    }
    throw error;
  }

  return {
    accepted: decision.classification !== 'STALE',
    presence: decision.next.state,
    recordedAt: now.toISOString(),
    reason: decision.reason,
  };
}
