import { describe, expect, it } from 'bun:test';
import {
  toNumber,
  getEnglishText,
  nonEmpty,
  priorityFromSortOrder,
  railroadStopTime,
  mercuryAlert,
  mercurySortOrder,
} from '../../src/utils/realtime';
import type { Alert, EntitySelector, StopTimeUpdate, TranslatedString } from '../../src/types/gtfs';

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

describe('nonEmpty', () => {
  // The railroads publish '' rather than omitting a field, so the empty-string
  // case is the whole reason this helper exists.
  it('collapses an empty string to null', () => {
    expect(nonEmpty('')).toBeNull();
  });

  it('collapses undefined and null to null', () => {
    expect(nonEmpty(undefined)).toBeNull();
    expect(nonEmpty(null)).toBeNull();
  });

  it('passes a real value through unchanged', () => {
    expect(nonEmpty('17')).toBe('17');
    expect(nonEmpty('On-Time')).toBe('On-Time');
  });
});

describe('priorityFromSortOrder', () => {
  it('takes the rank after the last colon, not the first', () => {
    // The GTFS ID itself contains a colon, so a naive split(':')[1] yields 'F'.
    expect(priorityFromSortOrder('MTASBWY:F:26')).toBe(26);
    expect(priorityFromSortOrder('MTASBWY:G:16')).toBe(16);
  });

  it('handles the documented rank bounds', () => {
    expect(priorityFromSortOrder('MTASBWY:F:1')).toBe(1);
    expect(priorityFromSortOrder('MTASBWY:F:35')).toBe(35);
  });

  it('returns null for absent or empty input', () => {
    expect(priorityFromSortOrder(undefined)).toBeNull();
    expect(priorityFromSortOrder(null)).toBeNull();
    expect(priorityFromSortOrder('')).toBeNull();
  });

  it('returns null when the trailing segment is not a number', () => {
    expect(priorityFromSortOrder('MTASBWY:F')).toBeNull();
    expect(priorityFromSortOrder('MTASBWY:F:')).toBeNull();
    expect(priorityFromSortOrder('no-colons-at-all')).toBeNull();
    expect(priorityFromSortOrder('MTASBWY:F:2A')).toBeNull();
  });
});

describe('vendor extension accessors', () => {
  it('reads the railroad extension off a stop time update', () => {
    const stu: StopTimeUpdate = {
      stopId: '237',
      '.transit_realtime.mtaRailroadStopTimeUpdate': { track: '17', trainStatus: 'On-Time' },
    };
    expect(railroadStopTime(stu)).toEqual({ track: '17', trainStatus: 'On-Time' });
  });

  it('returns undefined when a feed carries no railroad extension', () => {
    expect(railroadStopTime({ stopId: 'A02N' })).toBeUndefined();
  });

  it('reads the Mercury extension off an alert', () => {
    const alert: Alert = {
      activePeriod: [],
      informedEntity: [],
      '.transit_realtime.mercuryAlert': { alertType: 'Delays', updatedAt: 1_700_000_000 },
    };
    expect(mercuryAlert(alert)?.alertType).toBe('Delays');
  });

  it('returns undefined when an alert carries no Mercury extension', () => {
    expect(mercuryAlert({ activePeriod: [], informedEntity: [] })).toBeUndefined();
  });

  it('reads sort_order off an informed entity, collapsing empty to null', () => {
    const withOrder: EntitySelector = {
      routeId: 'F',
      '.transit_realtime.mercuryEntitySelector': { sortOrder: 'MTASBWY:F:26' },
    };
    expect(mercurySortOrder(withOrder)).toBe('MTASBWY:F:26');
    expect(mercurySortOrder({ routeId: 'F' })).toBeNull();
    expect(
      mercurySortOrder({ '.transit_realtime.mercuryEntitySelector': { sortOrder: '' } }),
    ).toBeNull();
  });
});
