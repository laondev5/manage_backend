import type { SitePolicy } from '../contracts/index.js';
import { classifyReading, type GeoPoint } from './geo.js';

export type ClockInDecision = {
  outcome: 'ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';
  reviewReason: string | null;
  distanceMeters: number | null;
  classification: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'NO_LOCATION';
};

export type ClockInContext = {
  assignmentActive: boolean;
  siteActive: boolean;
  hasWorkingShift: boolean;
  site: GeoPoint;
  policy: SitePolicy;
  location: { point: GeoPoint; accuracyMeters: number } | null;
  capturedAt: Date;
  now: Date;
};

export function decideClockIn(context: ClockInContext): ClockInDecision {
  if (!context.assignmentActive) {
    return {
      outcome: 'REJECTED',
      reviewReason: 'You are not currently assigned to this site.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  if (!context.siteActive) {
    return {
      outcome: 'REJECTED',
      reviewReason: 'This site is not active.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  if (context.hasWorkingShift) {
    return {
      outcome: 'REJECTED',
      reviewReason: 'An active shift already exists for this account.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  const skewMs = context.capturedAt.getTime() - context.now.getTime();
  if (skewMs > 5 * 60 * 1000) {
    return {
      outcome: 'REJECTED',
      reviewReason: 'The device time is more than five minutes ahead of the server.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  if (skewMs < -24 * 60 * 60 * 1000) {
    return {
      outcome: 'NEEDS_REVIEW',
      reviewReason: 'The clock-in was captured more than 24 hours ago and needs review.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  if (!context.location) {
    return {
      outcome: 'NEEDS_REVIEW',
      reviewReason: 'No location was available. The clock-in is recorded for review.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  const classified = classifyReading(
    context.location.point,
    context.location.accuracyMeters,
    context.site,
    context.policy,
  );
  if (classified.classification === 'INSIDE') {
    return {
      outcome: 'ACCEPTED',
      reviewReason: null,
      distanceMeters: classified.distanceMeters,
      classification: 'INSIDE',
    };
  }
  return {
    outcome: 'NEEDS_REVIEW',
    reviewReason:
      classified.reason ??
      'The clock-in location is outside the site boundary; it is recorded as a reviewable exception.',
    distanceMeters: classified.distanceMeters,
    classification: classified.classification,
  };
}

export type ShiftState = {
  startedAt: Date;
  endedAt: Date | null;
  status: 'WORKING' | 'ENDED';
};

export const workedMinutes = (startedAt: Date, endedAt: Date): number => {
  const minutes = Math.floor((endedAt.getTime() - startedAt.getTime()) / 60000);
  return Math.max(0, minutes);
};

export const isStaleShift = (
  shift: ShiftState,
  now: Date,
  thresholdHours = 16,
): boolean => {
  if (shift.status !== 'WORKING') return false;
  return now.getTime() - shift.startedAt.getTime() > thresholdHours * 60 * 60 * 1000;
};
