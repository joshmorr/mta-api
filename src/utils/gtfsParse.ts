/**
 * Parsing helpers shared by the static GTFS import (`staticFeed.ts`).
 *
 * Kept separate from the `|| 0` coercions already used elsewhere in that file:
 * those default missing/blank values to a meaningful `0` (e.g.
 * `location_type`, `stop_sequence`), which several call sites structurally
 * depend on. The helpers here are for genuinely new, optional columns where
 * "absent" must stay distinguishable from a real `0` — see CLAUDE.md /
 * `staticFeed.ts` for the specific traps.
 */

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

/**
 * Parses an integer CSV field, returning `null` when the value is
 * missing/blank/non-numeric instead of coercing to 0. Use this for columns
 * where 0 is a distinct, meaningful value (most GTFS enums) so "the feed
 * didn't ship this column" stays distinguishable from "the feed said 0".
 */
export function toIntOrNull(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}
