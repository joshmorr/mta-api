/**
 * Parsing helpers shared by the static GTFS import (`staticFeed.ts`).
 *
 * Kept separate from the `|| 0` coercions already used elsewhere in that file:
 * those default missing/blank values to a meaningful `0` (e.g.
 * `location_type`, `stop_sequence`), which several call sites structurally
 * depend on. The helpers here are for genuinely new, optional columns where
 * "absent" must stay distinguishable from a real `0` — see CLAUDE.md /
 * `staticFeed.ts` for the specific traps.
 *
 * `toGtfsSeconds` (for the `arrival_time`/`departure_time` columns) lives in
 * `src/utils/serviceDate.ts` instead, alongside the rest of the service-date
 * arithmetic that also needs it.
 */

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
