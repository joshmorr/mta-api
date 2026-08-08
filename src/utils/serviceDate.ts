import type { ServiceDateFilter, WeekdayColumn } from '../db/queries/serviceCalendar';

const TIME_ZONE = 'America/New_York';

export function getNyDateParts(date: Date): {
  date: string;
  weekdayColumn: WeekdayColumn;
  hour: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(date);

  const year = getDatePart(parts, 'year');
  const month = getDatePart(parts, 'month');
  const day = getDatePart(parts, 'day');
  const hour = Number(getDatePart(parts, 'hour'));
  const weekday = getDatePart(parts, 'weekday').toLowerCase() as WeekdayColumn;

  return {
    date: `${year}${month}${day}`,
    weekdayColumn: weekday,
    hour,
  };
}

const WEEKDAYS_BY_JS_DAY: WeekdayColumn[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

/**
 * The weekday column for a bare YYYYMMDD calendar date — no timezone
 * involved. Unlike `getNyDateParts`, this doesn't resolve an instant against
 * a timezone; a calendar date's day-of-week is the same regardless of where
 * on Earth you compute it, so plain UTC-anchored `Date` arithmetic is exact
 * and DST-irrelevant here.
 */
export function weekdayColumnForDate(yyyymmdd: string): WeekdayColumn {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  return WEEKDAYS_BY_JS_DAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function getDatePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((entry) => entry.type === type);
  if (!part) {
    throw new Error(`Missing date part: ${type}`);
  }
  return part.value;
}

/**
 * "What's running right now" — today, plus yesterday when it's early enough
 * that a 24+ hour overnight stop_time from yesterday's service day could
 * still be active. Right for the realtime arrivals path; wrong for a
 * whole-day board query (see getScheduleServiceDates), so existing callers
 * and tests assert this exact shape — don't change it here.
 */
export function getRelevantServiceDates(now: Date = new Date()): ServiceDateFilter[] {
  const current = getNyDateParts(now);
  const serviceDates: ServiceDateFilter[] = [
    {
      date: current.date,
      weekdayColumn: current.weekdayColumn,
    },
  ];

  // GTFS service days often extend past midnight via 24+ hour stop_times.
  if (current.hour < 5) {
    const previous = getNyDateParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (previous.date !== current.date) {
      serviceDates.push({
        date: previous.date,
        weekdayColumn: previous.weekdayColumn,
      });
    }
  }

  return serviceDates;
}

/**
 * The three service dates whose stop_times can plausibly contain a departure
 * visible "now": yesterday (its overnight 24+ hour trips), today, and
 * tomorrow (queried near midnight, "now" may already be tomorrow's early
 * service in wall-clock terms while still being late enough in yesterday's
 * or today's service day to matter). Unlike getRelevantServiceDates, this
 * isn't gated on the hour — a whole-day schedule board needs the full
 * window regardless of when it's queried.
 */
export function getScheduleServiceDates(now: Date = new Date()): ServiceDateFilter[] {
  const yesterday = getNyDateParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const today = getNyDateParts(now);
  const tomorrow = getNyDateParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  return [yesterday, today, tomorrow].map((p) => ({ date: p.date, weekdayColumn: p.weekdayColumn }));
}

/**
 * The UTC offset (milliseconds to ADD to a UTC instant `utcMillis` to obtain
 * the same instant expressed as if its `timeZone` wall-clock digits were
 * themselves UTC) — the standard trick for resolving an IANA zone's offset
 * without a timezone library: format the instant in the zone, reinterpret
 * those digits as UTC, and diff.
 */
function tzOffsetMillis(utcMillis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMillis));

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(getDatePart(parts, type));
  // hourCycle 'h23' can render midnight as "24" in some ICU builds; normalize.
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return utcMillis - asIfUtc;
}

/**
 * The GTFS service-day origin for `yyyymmdd`, as a unix timestamp (seconds):
 * local noon on that date, minus exactly 12 real hours.
 *
 * This is not equivalent to "local midnight", and deliberately so. Local
 * noon is never ambiguous (US DST transitions happen around 2am, never at
 * noon), so resolving it and subtracting a fixed 43200-second duration is
 * well-defined on every date — but on the two transition dates it lands an
 * hour away from nominal local midnight, not on it:
 *   - spring-forward (e.g. 2024-03-10, a 23-hour local day): the origin
 *     lands at 23:00 the *previous* evening, an hour BEFORE nominal
 *     midnight — verified: `getServiceDayOriginUnix('20240310')` is
 *     `2024-03-09T23:00 EST`.
 *   - fall-back (e.g. 2024-11-03, a 25-hour local day): the origin lands an
 *     hour AFTER nominal midnight — `getServiceDayOriginUnix('20241103')`
 *     is `2024-11-03T01:00 EDT`.
 * That shift is the whole point, not a defect: it's what makes
 * `departure_seconds` values that cross 24:00:00 resolve to the *literal*
 * following-morning clock reading a rider would expect. A 25:30:00
 * departure on the spring-forward date resolves to 2024-03-11 01:30 EDT
 * (25:30 minus 24:00 = "1:30 the next day", exactly as scheduled) — a
 * true-midnight-anchored origin would instead land it an hour late, at
 * 02:30, because it naively spends 25.5 real hours on a calendar day that
 * only had 23. The cost of this trade-off is narrow and specific: a
 * departure_seconds value in the *skipped-hour-adjacent* window
 * (00:00:00-01:59:59) scheduled for the spring-forward date itself lands an
 * hour early, on the previous evening. Every other date, and every other
 * time on this date, resolves correctly.
 */
export function getServiceDayOriginUnix(yyyymmdd: string): number {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));

  const utcNoonGuess = Date.UTC(year, month - 1, day, 12, 0, 0);
  const localNoonUtcMillis = utcNoonGuess + tzOffsetMillis(utcNoonGuess, TIME_ZONE);

  return Math.floor((localNoonUtcMillis - 12 * 3600 * 1000) / 1000);
}

/**
 * Parses a zero-padded GTFS `HH:MM:SS` time (hours may exceed 23 for
 * post-midnight service) into seconds since the start of the service day.
 * Returns `null` for missing/blank/malformed input rather than fabricating 0.
 */
export function toGtfsSeconds(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, h, mi, s] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s);
}
