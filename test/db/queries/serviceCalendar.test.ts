import { describe, expect, it } from 'bun:test';
import { activeServicePredicate } from '../../../src/db/queries/serviceCalendar';
import { db } from '../../../src/db/client';
import { resetDb } from '../../helpers/seed';

describe('db/queries/serviceCalendar', () => {
  describe('activeServicePredicate', () => {
    it('emits exactly four positional placeholders, all bound to serviceDate.date', () => {
      const { sql, params } = activeServicePredicate('t', { date: '20240115', weekdayColumn: 'monday' });
      expect((sql.match(/\?/g) ?? []).length).toBe(4);
      expect(params).toEqual(['20240115', '20240115', '20240115', '20240115']);
    });

    it('qualifies every column reference with the given alias', () => {
      const { sql } = activeServicePredicate('xyz', { date: '20240115', weekdayColumn: 'monday' });
      expect(sql).toContain('xyz.feed_id');
      expect(sql).toContain('xyz.service_id');
      expect(sql).not.toMatch(/[^.\w]t\./); // no stray references to the old hardcoded "t" alias
    });

    it('produces a working predicate against a real query, under a non-"t" alias', () => {
      resetDb();
      db.run(
        `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
         VALUES ('subway', 'R', '', 'R', 'R', NULL, 1)`,
      );
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T1', 'R', 'WKDY', 0, NULL)`,
      );
      db.run(
        `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
         VALUES ('subway', 'WKDY', 1, 1, 1, 1, 1, 0, 0, '20200101', '20991231')`,
      );

      const { sql, params } = activeServicePredicate('trips_alias', { date: '20240115', weekdayColumn: 'monday' });
      const row = db
        .query<{ trip_id: string }, string[]>(
          `SELECT trip_id FROM trips trips_alias WHERE trips_alias.trip_id = 'T1' AND ${sql}`,
        )
        .get(...params);
      expect(row?.trip_id).toBe('T1');
    });

    it('the predicate is false when the weekday does not match', () => {
      resetDb();
      db.run(
        `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
         VALUES ('subway', 'R', '', 'R', 'R', NULL, 1)`,
      );
      db.run(
        `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
         VALUES ('subway', 'T1', 'R', 'WKDY', 0, NULL)`,
      );
      db.run(
        `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
         VALUES ('subway', 'WKDY', 1, 1, 1, 1, 1, 0, 0, '20200101', '20991231')`,
      );

      // Sunday, not Monday - WKDY should not be active.
      const { sql, params } = activeServicePredicate('t', { date: '20240114', weekdayColumn: 'sunday' });
      const row = db
        .query<{ trip_id: string }, string[]>(`SELECT trip_id FROM trips t WHERE t.trip_id = 'T1' AND ${sql}`)
        .get(...params);
      expect(row).toBeNull();
    });
  });
});
