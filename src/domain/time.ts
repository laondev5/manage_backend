const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour === 24 ? 0 : (values.hour ?? 0),
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let offset = offsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  const secondOffset = offsetMs(new Date(result), timeZone);
  if (secondOffset !== offset) {
    offset = secondOffset;
    result = guess - offset;
  }
  return new Date(result);
}

export function zonedDayRange(date: Date, timeZone: string): { start: Date; end: Date } {
  const p = zonedParts(date, timeZone);
  const start = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
  const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedTimeToUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return { start, end };
}

export function formatInTimeZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' },
): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
}

export function formatDayInTimeZone(date: Date, timeZone: string): string {
  return formatInTimeZone(date, timeZone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRangeInTimeZone(start: Date, end: Date | null, timeZone: string): string {
  const day = formatDayInTimeZone(start, timeZone);
  const startTime = formatInTimeZone(start, timeZone);
  if (!end) return `${day}, ${startTime}`;
  const endTime = formatInTimeZone(end, timeZone);
  return `${day}, ${startTime} – ${endTime}`;
}

export function expectedWindowToday(
  expected: { start: string; end: string; days: number[] } | null,
  date: Date,
  timeZone: string,
): { start: Date; end: Date } | null {
  if (!expected) return null;
  const p = zonedParts(date, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (!expected.days.includes(day)) return null;
  const [startHour, startMinute] = expected.start.split(':').map(Number);
  const [endHour, endMinute] = expected.end.split(':').map(Number);
  const start = zonedTimeToUtc(p.year, p.month, p.day, startHour ?? 0, startMinute ?? 0, timeZone);
  let end = zonedTimeToUtc(p.year, p.month, p.day, endHour ?? 0, endMinute ?? 0, timeZone);
  if (end <= start) {
    const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    end = zonedTimeToUtc(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      endHour ?? 0,
      endMinute ?? 0,
      timeZone,
    );
  }
  return { start, end };
}

export const displayDuration = (minutes: number | null): string => {
  if (minutes === null) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
};
