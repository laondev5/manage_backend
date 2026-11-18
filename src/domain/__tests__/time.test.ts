import { describe, expect, it } from 'vitest';
import { expectedWindowToday, formatInTimeZone, zonedDayRange, zonedTimeToUtc } from '../time.js';

describe('timezone handling', () => {
  it('computes a Lagos day boundary in UTC', () => {
    const date = new Date('2026-11-16T12:00:00.000Z');
    const range = zonedDayRange(date, 'Africa/Lagos');
    expect(range.start.toISOString()).toBe('2026-11-15T23:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-16T23:00:00.000Z');
  });

  it('handles a New York daylight-saving transition day', () => {
    const date = new Date('2026-11-01T16:00:00.000Z');
    const range = zonedDayRange(date, 'America/New_York');
    expect(range.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(Math.round((range.end.getTime() - range.start.getTime()) / 3600000)).toBe(25);
  });

  it('formats times in the site timezone', () => {
    const date = new Date('2026-11-16T08:30:00.000Z');
    expect(formatInTimeZone(date, 'Africa/Lagos')).toContain('9:30');
  });

  it('treats an overnight expected window as ending the next day', () => {
    const date = new Date('2026-11-16T12:00:00.000Z');
    const window = expectedWindowToday({ start: '22:00', end: '06:00', days: [1] }, date, 'Africa/Lagos');
    expect(window).not.toBeNull();
    expect(window!.end.getTime()).toBeGreaterThan(window!.start.getTime());
    expect(window!.end.getTime() - window!.start.getTime()).toBe(8 * 3600000);
  });

  it('converts zoned wall time to UTC', () => {
    const utc = zonedTimeToUtc(2026, 11, 16, 9, 0, 'Africa/Lagos');
    expect(utc.toISOString()).toBe('2026-11-16T08:00:00.000Z');
  });
});
