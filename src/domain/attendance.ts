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
      outcome: 'REJECTED',
      reviewReason: 'This clock-in is too old. Obtain a new location reading at the site.',
      distanceMeters: null,
      classification: 'NO_LOCATION',
    };
  }
  if (!context.location) {
    return {
      outcome: 'REJECTED',
      reviewReason: 'A location reading inside the site is required to clock in.',
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
    outcome: 'REJECTED',
    reviewReason:
      classified.reason && classified.classification === 'UNCERTAIN'
        ? `${classified.reason} Step outside, wait a few seconds for a stronger signal, then try again.`
        : `You are about ${Math.round(classified.distanceMeters)} m from the site centre and outside its ${context.policy.radiusMeters} m boundary. Move onto the site and try again.`,
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
