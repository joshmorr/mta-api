import { describe, expect, it } from 'bun:test';
import {
  getScheduleServiceDates,
  getServiceDayOriginUnix,
  toGtfsSeconds,
} from '../../src/utils/serviceDate';

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
});
