import type { SitePolicy } from '../contracts/index.js';

export type GeoPoint = { latitude: number; longitude: number };

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type ReadingClassification = 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN';

export type ClassifiedReading = {
  classification: ReadingClassification;
  distanceMeters: number;
  reason: string | null;
};

export function classifyReading(
  point: GeoPoint,
  accuracyMeters: number,
  site: GeoPoint,
  policy: Pick<SitePolicy, 'radiusMeters' | 'exitBufferMeters' | 'entryBufferMeters' | 'maxAccuracyMeters'>,
): ClassifiedReading {
  const distance = distanceMeters(point, site);
  if (accuracyMeters > policy.maxAccuracyMeters) {
    return {
      classification: 'UNCERTAIN',
      distanceMeters: distance,
      reason: `Location accuracy ±${Math.round(accuracyMeters)} m exceeds the site limit of ±${policy.maxAccuracyMeters} m.`,
    };
  }
  if (distance + accuracyMeters < policy.radiusMeters - policy.entryBufferMeters) {
    return { classification: 'INSIDE', distanceMeters: distance, reason: null };
  }
  if (distance - accuracyMeters > policy.radiusMeters + policy.exitBufferMeters) {
    return { classification: 'OUTSIDE', distanceMeters: distance, reason: null };
  }
  return {
    classification: 'UNCERTAIN',
    distanceMeters: distance,
    reason: 'The location falls inside the boundary uncertainty band.',
  };
}
