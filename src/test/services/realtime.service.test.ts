import { describe, expect, it } from 'bun:test';
import { getNyDateParts, getRelevantServiceDates } from '../../services/realtime.service';

// All dates chosen to have unambiguous NY equivalents:
//   EST = UTC-5 (winter), EDT = UTC-4 (summer)
//   Jan 15 2024 = Monday, Jul 4 2024 = Thursday (2024 is a leap year)

describe('getNyDateParts', () => {
  it('returns correct date, weekday, and hour during EST (winter)', () => {
    // 2024-01-15 15:00 UTC = 10:00 EST (Monday)
    const result = getNyDateParts(new Date('2024-01-15T15:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 10 });
  });

  it('returns correct date, weekday, and hour during EDT (summer)', () => {
    // 2024-07-04 17:00 UTC = 13:00 EDT (Thursday)
    const result = getNyDateParts(new Date('2024-07-04T17:00:00.000Z'));
    expect(result).toEqual({ date: '20240704', weekdayColumn: 'thursday', hour: 13 });
  });

  it('handles early morning (hour < 5)', () => {
    // 2024-01-15 07:00 UTC = 02:00 EST (Monday)
    const result = getNyDateParts(new Date('2024-01-15T07:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 2 });
  });

  it('handles exactly midnight NY time', () => {
    // 2024-01-15 05:00 UTC = 00:00 EST (Monday)
    const result = getNyDateParts(new Date('2024-01-15T05:00:00.000Z'));
    expect(result).toEqual({ date: '20240115', weekdayColumn: 'monday', hour: 0 });
  });

  it('formats date as YYYYMMDD (zero-padded)', () => {
    // 2024-03-02 = Saturday, 2024-03-02 14:00 UTC = 10:00 EST
    const result = getNyDateParts(new Date('2024-03-02T15:00:00.000Z'));
    expect(result.date).toBe('20240302');
  });

  it('handles the DST spring-forward boundary (Mar 10 2024)', () => {
    // 2024-03-10 12:00 UTC = 08:00 EDT (clocks spring forward at 2am)
    const result = getNyDateParts(new Date('2024-03-10T12:00:00.000Z'));
    expect(result.date).toBe('20240310');
    expect(result.hour).toBe(8);
    expect(result.weekdayColumn).toBe('sunday');
  });
});

describe('getRelevantServiceDates', () => {
  it('returns only current day when hour >= 5', () => {
    // 2024-01-15 15:00 UTC = 10:00 EST Monday
    const result = getRelevantServiceDates(new Date('2024-01-15T15:00:00.000Z'));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '20240115', weekdayColumn: 'monday' });
  });

  it('includes previous day when hour < 5 (late-night service extension)', () => {
    // 2024-01-15 07:00 UTC = 02:00 EST Monday — early morning means overnight trains still running
    const result = getRelevantServiceDates(new Date('2024-01-15T07:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: '20240115', weekdayColumn: 'monday' });
    expect(result[1]).toEqual({ date: '20240114', weekdayColumn: 'sunday' });
  });

  it('does NOT include previous day when hour is exactly 5', () => {
    // 2024-01-15 10:00 UTC = 05:00 EST Monday — boundary: 5 is not < 5
    const result = getRelevantServiceDates(new Date('2024-01-15T10:00:00.000Z'));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ date: '20240115', weekdayColumn: 'monday' });
  });

  it('handles week boundary correctly (Monday 1am → previous day is Sunday)', () => {
    // 2024-01-15 06:00 UTC = 01:00 EST Monday
    const result = getRelevantServiceDates(new Date('2024-01-15T06:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[0].weekdayColumn).toBe('monday');
    expect(result[1].weekdayColumn).toBe('sunday');
  });

  it('handles month boundary correctly (Feb 1 midnight → previous day is Jan 31)', () => {
    // 2024-02-01 05:00 UTC = 00:00 EST Thursday
    const result = getRelevantServiceDates(new Date('2024-02-01T05:00:00.000Z'));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ date: '20240201', weekdayColumn: 'thursday' });
    expect(result[1]).toEqual({ date: '20240131', weekdayColumn: 'wednesday' });
  });
});
