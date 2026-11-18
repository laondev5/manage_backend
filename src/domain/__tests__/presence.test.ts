import { describe, expect, it } from 'vitest';
import { emptyPresence, evaluatePresence, markStalePresence } from '../presence.js';

const policy = {
  radiusMeters: 150,
  exitBufferMeters: 30,
  entryBufferMeters: 15,
  maxAccuracyMeters: 50,
  freshnessSeconds: 120,
  graceSeconds: 120,
};

const site = { latitude: 6.4281, longitude: 3.4219 };

const readingAt = (latitude: number, longitude: number, secondsAgo: number) => {
  const now = new Date('2026-11-16T10:00:00.000Z');
  return {
    point: { latitude, longitude },
    accuracyMeters: 10,
    capturedAt: new Date(now.getTime() - secondsAgo * 1000),
    receivedAt: now,
  };
};

describe('presence state machine', () => {
  it('moves to INSIDE on a qualifying inside reading', () => {
    const { point, accuracyMeters, capturedAt, receivedAt } = readingAt(6.4281, 3.4219, 5);
    const decision = evaluatePresence({
      previous: emptyPresence(),
      reading: { point, accuracyMeters, capturedAt },
      receivedAt,
      site,
      policy,
    });
    expect(decision.next.state).toBe('INSIDE');
    expect(decision.action).toBe('NONE');
  });

  it('starts a candidate outside reading instead of immediately alerting', () => {
    const inside = readingAt(6.4281, 3.4219, 20);
    const insideDecision = evaluatePresence({
      previous: emptyPresence(),
      reading: {
        point: inside.point,
        accuracyMeters: inside.accuracyMeters,
        capturedAt: inside.capturedAt,
      },
      receivedAt: inside.receivedAt,
      site,
      policy,
    });

    const outside = readingAt(6.4381, 3.4219, 5);
    const decision = evaluatePresence({
      previous: insideDecision.next,
      reading: {
        point: outside.point,
        accuracyMeters: outside.accuracyMeters,
        capturedAt: outside.capturedAt,
      },
      receivedAt: outside.receivedAt,
      site,
      policy,
    });

    expect(decision.next.state).toBe('EXIT_PENDING');
    expect(decision.action).toBe('CANDIDATE_OPENED');
  });

  it('confirms a departure only after fresh evidence past the grace interval', () => {
    const start = new Date('2026-11-16T10:00:00.000Z');
    const pending = {
      ...emptyPresence(),
      state: 'EXIT_PENDING' as const,
      candidateSince: new Date(start.getTime() - 180 * 1000).toISOString(),
      lastQualifiedAt: new Date(start.getTime() - 180 * 1000).toISOString(),
    };
    const decision = evaluatePresence({
      previous: pending,
      reading: {
        point: { latitude: 6.44, longitude: 3.4219 },
        accuracyMeters: 10,
        capturedAt: start,
      },
      receivedAt: start,
      site,
      policy,
    });
    expect(decision.next.state).toBe('OUTSIDE');
    expect(decision.action).toBe('DEPARTURE_CONFIRMED');
  });

  it('does not confirm when the confirming reading is stale', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const pending = {
      ...emptyPresence(),
      state: 'EXIT_PENDING' as const,
      candidateSince: new Date(now.getTime() - 600 * 1000).toISOString(),
      lastQualifiedAt: new Date(now.getTime() - 600 * 1000).toISOString(),
    };
    const decision = evaluatePresence({
      previous: pending,
      reading: {
        point: { latitude: 6.44, longitude: 3.4219 },
        accuracyMeters: 10,
        capturedAt: new Date(now.getTime() - 600 * 1000),
      },
      receivedAt: now,
      site,
      policy,
    });
    expect(decision.action).not.toBe('DEPARTURE_CONFIRMED');
    expect(decision.next.state).toBe('UNKNOWN');
    expect(decision.classification).toBe('STALE');
  });

  it('cancels a pending exit when the worker returns inside', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const pending = {
      ...emptyPresence(),
      state: 'EXIT_PENDING' as const,
      candidateSince: new Date(now.getTime() - 60 * 1000).toISOString(),
      lastQualifiedAt: new Date(now.getTime() - 60 * 1000).toISOString(),
    };
    const decision = evaluatePresence({
      previous: pending,
      reading: {
        point: { latitude: 6.4281, longitude: 3.4219 },
        accuracyMeters: 10,
        capturedAt: now,
      },
      receivedAt: now,
      site,
      policy,
    });
    expect(decision.next.state).toBe('INSIDE');
    expect(decision.action).toBe('CANDIDATE_CANCELLED');
  });

  it('closes an incident when the worker returns from OUTSIDE', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const outside = {
      ...emptyPresence(),
      state: 'OUTSIDE' as const,
      lastQualifiedAt: new Date(now.getTime() - 60 * 1000).toISOString(),
    };
    const decision = evaluatePresence({
      previous: outside,
      reading: {
        point: { latitude: 6.4281, longitude: 3.4219 },
        accuracyMeters: 10,
        capturedAt: now,
      },
      receivedAt: now,
      site,
      policy,
    });
    expect(decision.action).toBe('RETURNED');
    expect(decision.next.state).toBe('INSIDE');
  });

  it('keeps history but goes unknown on stale scheduler ticks', () => {
    const now = new Date('2026-11-16T10:10:00.000Z');
    const previous = {
      ...emptyPresence(),
      state: 'INSIDE' as const,
      lastQualifiedAt: new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
    };
    const decision = markStalePresence(previous, now, 300);
    expect(decision.next.state).toBe('UNKNOWN');
    expect(decision.reason).toContain('unknown presence');
  });

  it('treats poor accuracy as uncertainty rather than absence', () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const decision = evaluatePresence({
      previous: { ...emptyPresence(), state: 'INSIDE' },
      reading: {
        point: { latitude: 6.5, longitude: 3.5 },
        accuracyMeters: 400,
        capturedAt: now,
      },
      receivedAt: now,
      site,
      policy,
    });
    expect(decision.classification).toBe('UNCERTAIN');
    expect(decision.next.state).toBe('INSIDE');
  });
});
