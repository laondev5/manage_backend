import type { PresenceState, SitePolicy } from '../contracts/index.js';
import { classifyReading, type GeoPoint } from './geo.js';

export type PresenceReading = {
  point: GeoPoint;
  accuracyMeters: number;
  capturedAt: Date;
};

export type PresenceRecord = {
  state: PresenceState;
  candidateSince: string | null;
  lastQualifiedAt: string | null;
  lastAccuracyMeters: number | null;
  lastDistanceMeters: number | null;
};

export const emptyPresence = (): PresenceRecord => ({
  state: 'UNKNOWN',
  candidateSince: null,
  lastQualifiedAt: null,
  lastAccuracyMeters: null,
  lastDistanceMeters: null,
});

export type PresenceAction =
  | 'NONE'
  | 'CANDIDATE_OPENED'
  | 'CANDIDATE_CANCELLED'
  | 'DEPARTURE_CONFIRMED'
  | 'RETURNED'
  | 'WENT_UNKNOWN';

export type PresenceDecision = {
  next: PresenceRecord;
  action: PresenceAction;
  reason: string | null;
  classification: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'STALE';
  distanceMeters: number | null;
};

export type EvaluatePresenceInput = {
  previous: PresenceRecord;
  reading: PresenceReading;
  site: GeoPoint;
  policy: Pick<
    SitePolicy,
    | 'radiusMeters'
    | 'exitBufferMeters'
    | 'entryBufferMeters'
    | 'maxAccuracyMeters'
    | 'freshnessSeconds'
    | 'graceSeconds'
  >;
  receivedAt: Date;
  staleAfterSeconds?: number;
};

const SECONDS = 1000;

export function evaluatePresence(input: EvaluatePresenceInput): PresenceDecision {
  const { previous, reading, site, policy, receivedAt } = input;
  const ageSeconds = (receivedAt.getTime() - reading.capturedAt.getTime()) / SECONDS;

  if (ageSeconds > policy.freshnessSeconds) {
    return {
      next: {
        ...previous,
        state: 'UNKNOWN',
      },
      action: 'NONE',
      classification: 'STALE',
      distanceMeters: previous.lastDistanceMeters,
      reason:
        'This reading arrived late, so it is kept as history and cannot confirm a current departure.',
    };
  }

  const classified = classifyReading(reading.point, reading.accuracyMeters, site, policy);

  if (classified.classification === 'UNCERTAIN') {
    return {
      next: {
        ...previous,
        lastAccuracyMeters: reading.accuracyMeters,
        lastDistanceMeters: classified.distanceMeters,
      },
      action: 'NONE',
      classification: 'UNCERTAIN',
      distanceMeters: classified.distanceMeters,
      reason: classified.reason,
    };
  }

  const base: PresenceRecord = {
    ...previous,
    lastQualifiedAt: reading.capturedAt.toISOString(),
    lastAccuracyMeters: reading.accuracyMeters,
    lastDistanceMeters: classified.distanceMeters,
  };

  if (classified.classification === 'INSIDE') {
    const action: PresenceAction =
      previous.state === 'EXIT_PENDING'
        ? 'CANDIDATE_CANCELLED'
        : previous.state === 'OUTSIDE'
          ? 'RETURNED'
          : 'NONE';
    return {
      next: { ...base, state: 'INSIDE', candidateSince: null },
      action,
      classification: 'INSIDE',
      distanceMeters: classified.distanceMeters,
      reason: null,
    };
  }

  switch (previous.state) {
    case 'OUTSIDE':
      return {
        next: { ...base, state: 'OUTSIDE', candidateSince: null },
        action: 'NONE',
        classification: 'OUTSIDE',
        distanceMeters: classified.distanceMeters,
        reason: null,
      };
    case 'EXIT_PENDING': {
      const candidateSince = previous.candidateSince
        ? new Date(previous.candidateSince)
        : reading.capturedAt;
      const candidateAge = (reading.capturedAt.getTime() - candidateSince.getTime()) / SECONDS;
      if (candidateAge >= policy.graceSeconds) {
        return {
          next: { ...base, state: 'OUTSIDE', candidateSince: null },
          action: 'DEPARTURE_CONFIRMED',
          classification: 'OUTSIDE',
          distanceMeters: classified.distanceMeters,
          reason: null,
        };
      }
      return {
        next: { ...base, state: 'EXIT_PENDING', candidateSince: candidateSince.toISOString() },
        action: 'NONE',
        classification: 'OUTSIDE',
        distanceMeters: classified.distanceMeters,
        reason: 'Outside reading is inside the grace interval; waiting for fresh confirmation.',
      };
    }
    case 'INSIDE':
    case 'UNKNOWN':
    default:
      return {
        next: {
          ...base,
          state: 'EXIT_PENDING',
          candidateSince: reading.capturedAt.toISOString(),
        },
        action: 'CANDIDATE_OPENED',
        classification: 'OUTSIDE',
        distanceMeters: classified.distanceMeters,
        reason: 'A possible departure is being observed during the grace interval.',
      };
  }
}

export function markStalePresence(
  previous: PresenceRecord,
  now: Date,
  staleAfterSeconds = 300,
): PresenceDecision {
  const last = previous.lastQualifiedAt ? new Date(previous.lastQualifiedAt) : null;
  const age = last ? (now.getTime() - last.getTime()) / 1000 : Number.POSITIVE_INFINITY;
  if (last && age <= staleAfterSeconds) {
    return {
      next: previous,
      action: 'NONE',
      classification: 'UNCERTAIN',
      distanceMeters: previous.lastDistanceMeters,
      reason: null,
    };
  }
  return {
    next: { ...previous, state: 'UNKNOWN' },
    action: previous.state === 'UNKNOWN' ? 'NONE' : 'WENT_UNKNOWN',
    classification: 'STALE',
    distanceMeters: previous.lastDistanceMeters,
    reason:
      'No fresh location evidence is available. This is unknown presence, not an absence.',
  };
}
