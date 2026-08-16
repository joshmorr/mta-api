import type {
  Alert,
  EntitySelector,
  MercuryAlert,
  MtaRailroadStopTimeUpdate,
  StopTimeUpdate,
  TranslatedString,
} from '../types/gtfs';

export function toNumber(val: number | { toNumber(): number } | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'object') return val.toNumber();
  return val;
}

export function getEnglishText(ts: TranslatedString | undefined): string {
  if (!ts) return '';
  const en = ts.translation.find((t) => t.language === 'en' || !t.language);
  return en?.text ?? '';
}

/**
 * Collapse a proto2 `optional string` to null.
 *
 * The vendor extensions publish empty strings rather than omitting fields -
 * LIRR sends `track: ''` and `trainStatus: ''` on stop time updates it has no
 * data for - so `hasOwnProperty` is the wrong presence test here. It is also
 * what `getEnglishText` returns when there is no usable translation.
 */
export function nonEmpty(value: string | undefined | null): string | null {
  return value ? value : null;
}

/**
 * The rank in a Mercury `sort_order`, which is `GTFS-ID:Priority` - e.g.
 * `MTASBWY:F:26` is priority 26. The GTFS ID itself contains colons, so the
 * rank is the segment after the *last* one.
 *
 * Ranks run 1 (lowest) to 35 (highest) over the MTA's shared status list.
 */
export function priorityFromSortOrder(sortOrder: string | undefined | null): number | null {
  if (!sortOrder) return null;
  const rank = sortOrder.slice(sortOrder.lastIndexOf(':') + 1);
  if (!/^\d+$/.test(rank)) return null;
  return Number(rank);
}

// --- Vendor extension accessors -------------------------------------------
//
// protobufjs exposes extension fields under their fully-qualified name, so
// these keep the magic strings in one place instead of spread through the
// services. A feed that doesn't carry the extension simply yields undefined.

export function railroadStopTime(stu: StopTimeUpdate): MtaRailroadStopTimeUpdate | undefined {
  return stu['.transit_realtime.mtaRailroadStopTimeUpdate'];
}

export function mercuryAlert(alert: Alert): MercuryAlert | undefined {
  return alert['.transit_realtime.mercuryAlert'];
}

export function mercurySortOrder(entity: EntitySelector): string | null {
  return nonEmpty(entity['.transit_realtime.mercuryEntitySelector']?.sortOrder);
}
