import { describe, expect, it } from 'bun:test';
import {
  getScheduleServiceDates,
  getServiceDayOriginUnix,
  toGtfsSeconds,
} from '../../src/utils/serviceDate';
import { db } from '../../src/db/client';
import { resetDb, seedSubwaySchedule } from '../helpers/seed';

describe('utils/serviceDate', () => {
  describe('toGtfsSeconds', () => {
    it('parses zero-padded HH:MM:SS', () => {
      expect(toGtfsSeconds('10:05:30')).toBe(10 * 3600 + 5 * 60 + 30);
    });

    it('parses post-midnight hours beyond 23', () => {
      expect(toGtfsSeconds('25:30:00')).toBe(25 * 3600 + 30 * 60);
    });

    it('returns null for missing/empty input', () => {
      expect(toGtfsSeconds(undefined)).toBeNull();
      expect(toGtfsSeconds(null)).toBeNull();
      expect(toGtfsSeconds('')).toBeNull();
    });

    it('returns null for malformed input', () => {
      expect(toGtfsSeconds('not-a-time')).toBeNull();
      expect(toGtfsSeconds('10:05')).toBeNull();
    });
  });

  describe('getServiceDayOriginUnix', () => {
    it('lands exactly 12 hours before local noon, on an ordinary day', () => {
      const origin = getServiceDayOriginUnix('20240615');
      const noonHour = nyHour(origin + 12 * 3600);
      expect(noonHour).toBe(12);
    });

    it('produces a 24-hour gap between two consecutive ordinary days', () => {
      const day1 = getServiceDayOriginUnix('20240101');
      const day2 = getServiceDayOriginUnix('20240102');
      expect(day2 - day1).toBe(24 * 3600);
    });

    it('produces a 23-hour gap across the spring-forward DST day (2024-03-10)', () => {
      const before = getServiceDayOriginUnix('20240309');
      const dstDay = getServiceDayOriginUnix('20240310');
      expect(dstDay - before).toBe(23 * 3600);
    });

    it('produces a 25-hour gap across the fall-back DST day (2024-11-03)', () => {
      const before = getServiceDayOriginUnix('20241102');
      const dstDay = getServiceDayOriginUnix('20241103');
      expect(dstDay - before).toBe(25 * 3600);
    });

    it('resolves a 25:30:00 departure on the spring-forward date into the following day, mid-morning', () => {
      // 2024-03-10 is a 23-hour local day (clocks skip 2am->3am). A
      // 25:30:00 departure (1.5h past nominal 24:00) should land at
      // 01:30 local on 2024-03-11 - naive midnight+seconds arithmetic
      // would be off by an hour here.
      const origin = getServiceDayOriginUnix('20240310');
      const departureUnix = origin + 25 * 3600 + 30 * 60;
      expect(nyDateAndHourMinute(departureUnix)).toEqual({ date: '20240311', hour: 1, minute: 30 });
    });

    it('documents the trade-off: an 00:00:00-01:59:59 departure on the spring-forward date itself lands an hour early, the previous evening', () => {
      // This is the accepted cost of noon-anchoring, not a bug: it's what
      // makes the 25:30:00 case above land correctly. A departure_seconds
      // value below the transition point (02:00:00) on this one date per
      // year resolves an hour before its nominal wall-clock reading.
      const origin = getServiceDayOriginUnix('20240310');
      const departureUnix = origin + 30 * 60; // nominal 00:30:00
      expect(nyDateAndHourMinute(departureUnix)).toEqual({ date: '20240309', hour: 23, minute: 30 });
    });

    function nyHour(unixSeconds: number): number {
      return nyDateAndHourMinute(unixSeconds).hour;
    }

    function nyDateAndHourMinute(unixSeconds: number): { date: string; hour: number; minute: number } {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(new Date(unixSeconds * 1000));
      const get = (t: string) => parts.find((p) => p.type === t)!.value;
      return {
        date: `${get('year')}${get('month')}${get('day')}`,
        hour: Number(get('hour')) % 24,
        minute: Number(get('minute')),
      };
    }
  });

  describe('getScheduleServiceDates', () => {
    it('returns [yesterday, today, tomorrow] regardless of the hour', () => {
      // Unlike getRelevantServiceDates, this is not gated on hour < 5 -
      // queried mid-afternoon, it still returns all three.
      const result = getScheduleServiceDates(new Date('2024-01-15T15:00:00.000Z')); // Mon 10am NY
      expect(result.map((d) => d.date)).toEqual(['20240114', '20240115', '20240116']);
      expect(result.map((d) => d.weekdayColumn)).toEqual(['sunday', 'monday', 'tuesday']);
    });

    it('spans a month boundary correctly', () => {
      const result = getScheduleServiceDates(new Date('2024-02-01T15:00:00.000Z'));
      expect(result.map((d) => d.date)).toEqual(['20240131', '20240201', '20240202']);
    });
  });

  // Ties the raw seeded departure_seconds column to getServiceDayOriginUnix,
  // against a real 24+ hour rollover trip (seedSubwaySchedule's T-LATE,
  // 25:30:00 at 127N). The bug this guards against: a query that merges
  // multiple candidate service dates by OR-ing them together rather than
  // running one query per date and merging in JS. A same nominal time
  // (25:30:00) on two different service dates is two different real
  // instants, and asserting only that a row is present — not which absolute
  // timestamp it resolves to — would pass even if the dates were collapsed
  // into one indistinguishable match.
  describe('service-day origin composed with a real seeded departure_seconds column', () => {
    it('resolves the same nominal departure_seconds to distinct absolute timestamps on different service dates', () => {
      resetDb();
      seedSubwaySchedule();

      const departureSeconds = db
        .query<{ departure_seconds: number }, [string]>(
          `SELECT departure_seconds FROM stop_times WHERE trip_id = ?`,
        )
        .get('T-LATE')?.departure_seconds;
      expect(departureSeconds).toBe(25 * 3600 + 30 * 60);

      const timestampOnDay1 = getServiceDayOriginUnix('20240310') + departureSeconds!;
      const timestampOnDay2 = getServiceDayOriginUnix('20240311') + departureSeconds!;

      expect(timestampOnDay1).not.toBe(timestampOnDay2);
      // Exactly one real day (86400s) apart on either side of the DST
      // boundary, since 20240310 is the 23-hour spring-forward day: the
      // *nominal* time is identical (25:30:00) but the day lengths it's
      // measured against differ by an hour, so the gap is 24h, not 23h.
      expect(timestampOnDay2 - timestampOnDay1).toBe(24 * 3600);
    });

    it('the spring-forward rollover lands at 01:30 local the next calendar day, not 25:30 nominal', () => {
      resetDb();
      seedSubwaySchedule();

      const departureSeconds = db
        .query<{ departure_seconds: number }, [string]>(
          `SELECT departure_seconds FROM stop_times WHERE trip_id = ?`,
        )
        .get('T-LATE')!.departure_seconds;

      const departureUnix = getServiceDayOriginUnix('20240310') + departureSeconds;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(new Date(departureUnix * 1000));
      const get = (t: string) => parts.find((p) => p.type === t)!.value;

      expect(`${get('year')}${get('month')}${get('day')}`).toBe('20240311');
      expect(get('hour')).toBe('01');
      expect(get('minute')).toBe('30');
    });
  });
});
