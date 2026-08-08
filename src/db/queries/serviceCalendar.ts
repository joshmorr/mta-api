export type WeekdayColumn =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type ServiceDateFilter = {
  date: string;
  weekdayColumn: WeekdayColumn;
};

/**
 * SQL predicate deciding whether `${alias}.service_id` (on the joined `trips`
 * row identified by `alias`) is active on `serviceDate`, standard GTFS
 * calendar + calendar_dates override logic:
 *
 *   active = (added via calendar_dates exception_type=1)
 *         OR (calendar says so for the weekday, in [start_date, end_date])
 *            AND NOT (removed via calendar_dates exception_type=2)
 *
 * Parameterized on `alias` so a query joining `trips` under a different name
 * (or more than once) doesn't have to duplicate this string. Returns the
 * params in the order the four `?` placeholders appear in `sql` — the caller
 * must spread them in that position, not hand-assemble a matching count.
 */
export function activeServicePredicate(
  alias: string,
  serviceDate: ServiceDateFilter,
): { sql: string; params: string[] } {
  const { date, weekdayColumn } = serviceDate;
  const sql = `(
    EXISTS (
      SELECT 1
      FROM calendar_dates cd_added
      WHERE cd_added.feed_id = ${alias}.feed_id
        AND cd_added.service_id = ${alias}.service_id
        AND cd_added.date = ?
        AND cd_added.exception_type = 1
    )
    OR (
      EXISTS (
        SELECT 1
        FROM calendar c
        WHERE c.feed_id = ${alias}.feed_id
          AND c.service_id = ${alias}.service_id
          AND c.start_date <= ?
          AND c.end_date >= ?
          AND c.${weekdayColumn} = 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM calendar_dates cd_removed
        WHERE cd_removed.feed_id = ${alias}.feed_id
          AND cd_removed.service_id = ${alias}.service_id
          AND cd_removed.date = ?
          AND cd_removed.exception_type = 2
      )
    )
  )`;
  return { sql, params: [date, date, date, date] };
}
