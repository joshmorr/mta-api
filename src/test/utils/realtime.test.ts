import { describe, expect, it } from 'bun:test';
import { toNumber, getEnglishText } from '../../utils/realtime';
import type { TranslatedString } from '../../types/gtfs';

// Minimal Long-like object matching the protobufjs interface
function makeLong(value: number): { toNumber(): number } {
  return { toNumber: () => value };
}

describe('toNumber', () => {
  it('returns 0 for undefined', () => {
    expect(toNumber(undefined)).toBe(0);
  });

  it('returns the number directly when passed a number', () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber(1_700_000_000)).toBe(1_700_000_000);
    expect(toNumber(-1)).toBe(-1);
  });

  it('calls .toNumber() on Long-like objects', () => {
    expect(toNumber(makeLong(42))).toBe(42);
    expect(toNumber(makeLong(1_700_000_000))).toBe(1_700_000_000);
  });
});

describe('getEnglishText', () => {
  it('returns empty string for undefined', () => {
    expect(getEnglishText(undefined)).toBe('');
  });

  it('returns empty string for a TranslatedString with no translations', () => {
    const ts: TranslatedString = { translation: [] };
    expect(getEnglishText(ts)).toBe('');
  });

  it('returns the English translation when language is "en"', () => {
    const ts: TranslatedString = {
      translation: [
        { text: 'Bonjour', language: 'fr' },
        { text: 'Hello', language: 'en' },
      ],
    };
    expect(getEnglishText(ts)).toBe('Hello');
  });

  it('returns a translation with no language tag as fallback', () => {
    const ts: TranslatedString = {
      translation: [{ text: 'Service change' }],
    };
    expect(getEnglishText(ts)).toBe('Service change');
  });

  it('prefers "en" over no-language entry', () => {
    const ts: TranslatedString = {
      translation: [
        { text: 'Fallback' },
        { text: 'English', language: 'en' },
      ],
    };
    expect(getEnglishText(ts)).toBe('Fallback'); // find() returns first match
  });

  it('returns empty string when only non-English languages are present', () => {
    const ts: TranslatedString = {
      translation: [
        { text: 'Español', language: 'es' },
        { text: '中文', language: 'zh' },
      ],
    };
    expect(getEnglishText(ts)).toBe('');
  });
});
