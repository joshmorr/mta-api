import { describe, expect, it } from 'bun:test';
import { toGtfsSeconds, toIntOrNull } from '../../src/utils/gtfsParse';

describe('utils/gtfsParse', () => {
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

  describe('toIntOrNull', () => {
    it('parses a numeric string, including a real 0', () => {
      expect(toIntOrNull('0')).toBe(0);
      expect(toIntOrNull('1')).toBe(1);
      expect(toIntOrNull('42')).toBe(42);
    });

    it('returns null rather than fabricating 0 for missing/blank/invalid input', () => {
      expect(toIntOrNull(undefined)).toBeNull();
      expect(toIntOrNull(null)).toBeNull();
      expect(toIntOrNull('')).toBeNull();
      expect(toIntOrNull('n/a')).toBeNull();
    });
  });
});
