import { describe, expect, it } from 'bun:test';
import { toIntOrNull } from '../../src/utils/gtfsParse';

describe('utils/gtfsParse', () => {
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
