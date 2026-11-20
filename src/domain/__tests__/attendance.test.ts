import { describe, expect, it } from 'vitest';
import { classifyReading, distanceMeters } from '../geo.js';
import { decideClockIn } from '../attendance.js';
import { safeCsvCell, toCsv } from '../csv.js';
import { capabilitiesFor } from '../policy.js';
import { backoffMs } from '../outbox.js';

const policy = {
  radiusMeters: 150,
  exitBufferMeters: 30,
  entryBufferMeters: 15,
  maxAccuracyMeters: 50,
  graceSeconds: 120,
  freshnessSeconds: 120,
};

const site = { latitude: 6.4281, longitude: 3.4219 };

describe('geo classification', () => {
  it('computes a realistic distance', () => {
    const distance = distanceMeters(site, { latitude: 6.4291, longitude: 3.4219 });
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });

  it('classifies outside beyond radius plus buffer', () => {
    const result = classifyReading({ latitude: 6.4351, longitude: 3.4219 }, 10, site, policy);
    expect(result.classification).toBe('OUTSIDE');
  });

  it('treats the buffer band as uncertain', () => {
    const result = classifyReading({ latitude: 6.4296, longitude: 3.4219 }, 10, site, policy);
    expect(result.classification).toBe('UNCERTAIN');
  });
});

describe('clock-in decisions', () => {
  const now = new Date('2026-11-16T08:00:00.000Z');
  const base = {
    assignmentActive: true,
    siteActive: true,
    hasWorkingShift: false,
    site,
    policy,
    capturedAt: now,
    now,
  };

  it('accepts a verified inside clock-in', () => {
    const decision = decideClockIn({
      ...base,
      location: { point: site, accuracyMeters: 12 },
    });
    expect(decision.outcome).toBe('ACCEPTED');
  });

  it('rejects an outside clock-in', () => {
    const decision = decideClockIn({
      ...base,
      location: { point: { latitude: 6.45, longitude: 3.4219 }, accuracyMeters: 12 },
    });
    expect(decision.outcome).toBe('REJECTED');
    expect(decision.reviewReason).toContain('outside');
  });

  it('rejects clock-in when GPS is missing', () => {
    const decision = decideClockIn({ ...base, location: null });
    expect(decision.outcome).toBe('REJECTED');
  });

  it('rejects an unassigned site', () => {
    const decision = decideClockIn({
      ...base,
      assignmentActive: false,
      location: { point: site, accuracyMeters: 12 },
    });
    expect(decision.outcome).toBe('REJECTED');
  });

  it('rejects a duplicate active shift', () => {
    const decision = decideClockIn({
      ...base,
      hasWorkingShift: true,
      location: { point: site, accuracyMeters: 12 },
    });
    expect(decision.outcome).toBe('REJECTED');
  });
});

describe('csv safety', () => {
  it('neutralises formula injection including whitespace variants', () => {
    expect(safeCsvCell('=SUM(A1:A3)')).toBe("'=SUM(A1:A3)");
    expect(safeCsvCell('  @cmd')).toBe("'  @cmd");
    expect(safeCsvCell('+1234')).toBe("'+1234");
    expect(safeCsvCell('-1')).toBe("'-1");
    expect(safeCsvCell('plain')).toBe('plain');
  });

  it('escapes quotes and newlines', () => {
    expect(safeCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    const csv = toCsv(['name', 'value'], [['site, one', 2]]);
    expect(csv).toContain('"site, one",2');
  });
});

describe('capabilities', () => {
  it('never grants admin capabilities to owners', () => {
    const capabilities = capabilitiesFor([{ role: 'SITE_OWNER', status: 'ACTIVE' }]);
    expect(capabilities).toContain('owner.sites');
    expect(capabilities).not.toContain('admin.users');
  });

  it('ignores suspended memberships', () => {
    expect(capabilitiesFor([{ role: 'SITE_OWNER', status: 'SUSPENDED' }])).toEqual([]);
  });
});

describe('outbox backoff', () => {
  it('grows and stays bounded', () => {
    const options = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0, random: () => 0.5 };
    expect(backoffMs(1, options)).toBe(1000);
    expect(backoffMs(3, options)).toBe(4000);
    expect(backoffMs(20, options)).toBe(60_000);
  });
});
