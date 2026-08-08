import { db, resetStaticData } from '../../src/db/client';

/** Wipe every static table. Call at the top of each DB-touching test (or in beforeEach). */
export function resetDb(): void {
  resetStaticData();
}

/**
 * Seed a small subway fixture:
 *   - Parent station "127" with platforms "127N" and "127S" (location_type 0, parent_station "127")
 *   - Route "1" (subway)
 *   - Trip "T1" on route "1", service "WKDY"
 *   - stop_times for T1 at both platforms
 *   - calendar row for "WKDY" active Mon–Fri across a wide date range
 */
export function seedSubway(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('subway', '127',  'Times Sq-42 St', 40.755477, -73.987691, 1, NULL),
       ('subway', '127N', 'Times Sq-42 St', 40.755477, -73.987691, 0, '127'),
       ('subway', '127S', 'Times Sq-42 St', 40.755477, -73.987691, 0, '127')`,
  );
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('subway', '1', 'MTA NYCT', '1', 'Broadway - 7 Avenue Local', '#EE352E', 1)`,
  );
  db.run(
    `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
     VALUES ('subway', 'T1', '1', 'WKDY', 0, NULL)`,
  );
  db.run(
    `INSERT INTO stop_times (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence)
     VALUES
       ('subway', 'T1', '127N', '10:00:00', '10:00:00', 1),
       ('subway', 'T1', '127S', '10:05:00', '10:05:00', 2)`,
  );
  db.run(
    `INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
     VALUES ('subway', 'WKDY', 1, 1, 1, 1, 1, 0, 0, '20200101', '20991231')`,
  );
}

/** Seed a small LIRR fixture (flat stop model, no parent/child). */
export function seedLirr(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('lirr', '1', 'Penn Station',     40.7505, -73.9934, 0, NULL),
       ('lirr', '2', 'Jamaica',          40.7000, -73.8090, 0, NULL)`,
  );
  // route_short_name is NULL to match production: LIRR and MNR publish only a
  // long name, so the branch name is the sole rider-facing label. A fixture
  // that fills in a short name hides every bug in the name-fallback path.
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('lirr', 'PW', 'LI', NULL, 'Port Washington Branch', '#00985F', 2)`,
  );
}

/** Seed a small MNR fixture. */
export function seedMnr(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('mnr', '1', 'Grand Central',  40.7527, -73.9772, 0, NULL),
       ('mnr', '2', 'Harlem-125 St',  40.8050, -73.9407, 0, NULL)`,
  );
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('mnr', 'HUDSON', 'MNR', NULL, 'Hudson Line', '#009B3A', 2)`,
  );
}

// --- Schedule fixtures --------------------------------------------------
//
// Added for the static schedule surfaces (stop_times.departure_seconds,
// the service-date layer). Layered ADDITIVELY on top of the fixtures
// above — seedSubway()/seedLirr()/seedMnr() are unchanged, since five
// existing suites assert against their exact current shape.

function gtfsSeconds(hh: number, mm: number, ss = 0): number {
  return hh * 3600 + mm * 60 + ss;
}

/**
 * Adds a physically real, single-direction subway trip along the 1 line —
 * Van Cortlandt Park-242 St(101N) -> 238 St(103N) -> Times Sq-42 St(127N) —
 * on top of seedSubway(). The existing `T1` fixture trip serves 127N then
 * 127S, which no real subway trip does, so it can't stand in for an A→B
 * schedule query that needs three genuinely distinct, sequentially ordered
 * stops. Also adds:
 *   - a trip whose departure rolls past midnight (25:30:00), for testing
 *     service-day origin/seconds arithmetic against real seeded columns
 *     rather than a same-calendar-day timestamp;
 *   - calendar_dates rows of BOTH exception types against WKDY, re-covering
 *     the exception_type=2-beats-a-matching-weekday case with real data
 *     after the activeServicePredicate rewrite.
 *
 * Calls seedSubway() internally — use this OR seedSubway(), not both, to
 * avoid a duplicate-PK insert on stop 127.
 */
export function seedSubwaySchedule(): void {
  seedSubway();

  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('subway', '101',  'Van Cortlandt Park-242 St', 40.889248, -73.898583, 1, NULL),
       ('subway', '101N', 'Van Cortlandt Park-242 St', 40.889248, -73.898583, 0, '101'),
       ('subway', '103',  '238 St',                    40.884667, -73.900870, 1, NULL),
       ('subway', '103N', '238 St',                    40.884667, -73.900870, 0, '103')`,
  );
  db.run(
    `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
     VALUES ('subway', 'T-LOCAL', '1', 'WKDY', 0, NULL)`,
  );
  db.run(
    `INSERT INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
     VALUES
       ('subway', 'T-LOCAL', '101N', '09:00:00', '09:00:00', 1, ${gtfsSeconds(9, 0)}, ${gtfsSeconds(9, 0)}),
       ('subway', 'T-LOCAL', '103N', '09:05:00', '09:05:00', 2, ${gtfsSeconds(9, 5)}, ${gtfsSeconds(9, 5)}),
       ('subway', 'T-LOCAL', '127N', '09:30:00', '09:30:00', 3, ${gtfsSeconds(9, 30)}, ${gtfsSeconds(9, 30)})`,
  );

  db.run(
    `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id)
     VALUES ('subway', 'T-LATE', '1', 'WKDY', 0, NULL)`,
  );
  db.run(
    `INSERT INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
     VALUES ('subway', 'T-LATE', '127N', '25:30:00', '25:30:00', 1, ${gtfsSeconds(25, 30)}, ${gtfsSeconds(25, 30)})`,
  );

  db.run(
    `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
     VALUES
       ('subway', 'WKDY', '20240120', 1),
       ('subway', 'WKDY', '20240122', 2)`,
  );
}

/**
 * A physically real LIRR trip on the Ronkonkoma Branch: Deer Park(44) ->
 * Wyandanch(220, intermediate) -> Penn Station(237). Service is
 * calendar_dates-ONLY, exception_type=1, with NO calendar row — LIRR ships
 * no calendar.txt in production, so this is its only service path, and it
 * has zero fixture coverage without this helper (a bug here fails silently
 * as an empty array, not a thrown error).
 */
export function seedLirrSchedule(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('lirr', '44',  'Deer Park',    40.76948364, -73.29356494, 0, NULL),
       ('lirr', '220', 'Wyandanch',    40.75480101, -73.35806588, 0, NULL),
       ('lirr', '237', 'Penn Station', 40.75058844, -73.99358408, 0, NULL)`,
  );
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('lirr', 'RONK', 'LI', NULL, 'Ronkonkoma Branch', '#009B3A', 2)`,
  );
  db.run(
    `INSERT INTO trips
       (feed_id, trip_id, route_id, service_id, direction_id, shape_id,
        trip_headsign, trip_short_name, block_id, wheelchair_accessible, peak_offpeak)
     VALUES
       ('lirr', 'GO201_26_SCHED', 'RONK', 'SCHED', 1, NULL, 'Penn Station', '1013', 'B1', 1, 0)`,
  );
  db.run(
    `INSERT INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence,
        track, pickup_type, drop_off_type, arrival_seconds, departure_seconds)
     VALUES
       ('lirr', 'GO201_26_SCHED', '44',  '12:22:00', '12:22:00', 1, NULL, 0, 0, ${gtfsSeconds(12, 22)}, ${gtfsSeconds(12, 22)}),
       ('lirr', 'GO201_26_SCHED', '220', '12:35:00', '12:36:00', 2, '2',  0, 0, ${gtfsSeconds(12, 35)}, ${gtfsSeconds(12, 36)}),
       ('lirr', 'GO201_26_SCHED', '237', '13:30:00', '13:30:00', 3, '18', 0, 0, ${gtfsSeconds(13, 30)}, ${gtfsSeconds(13, 30)})`,
  );
  db.run(
    `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
     VALUES ('lirr', 'SCHED', '20240115', 1)`,
  );
}

/**
 * A physically real MNR (New Haven Line) trip: Grand Central(1) ->
 * Harlem-125 St(4) -> Stamford(124). Like LIRR, MNR ships no calendar.txt —
 * calendar_dates-ONLY service, exception_type=1, no calendar row.
 */
export function seedMnrSchedule(): void {
  db.run(
    `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
     VALUES
       ('mnr', '1',   'Grand Central', 40.752998, -73.977056, 0, NULL),
       ('mnr', '4',   'Harlem-125 St', 40.805157, -73.939149, 0, NULL),
       ('mnr', '124', 'Stamford',      41.046611, -73.542846, 0, NULL)`,
  );
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('mnr', 'NH', 'MNR', NULL, 'New Haven', '#EE0034', 2)`,
  );
  db.run(
    `INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, shape_id, trip_headsign)
     VALUES ('mnr', 'MNR-SCHED-1', 'NH', 'SCHED', 0, NULL, 'Stamford')`,
  );
  db.run(
    `INSERT INTO stop_times
       (feed_id, trip_id, stop_id, arrival_time, departure_time, stop_sequence, arrival_seconds, departure_seconds)
     VALUES
       ('mnr', 'MNR-SCHED-1', '1',   '09:07:00', '09:07:00', 1, ${gtfsSeconds(9, 7)},  ${gtfsSeconds(9, 7)}),
       ('mnr', 'MNR-SCHED-1', '4',   '09:17:00', '09:17:00', 2, ${gtfsSeconds(9, 17)}, ${gtfsSeconds(9, 17)}),
       ('mnr', 'MNR-SCHED-1', '124', '09:56:00', '09:56:00', 3, ${gtfsSeconds(9, 56)}, ${gtfsSeconds(9, 56)})`,
  );
  db.run(
    `INSERT INTO calendar_dates (feed_id, service_id, date, exception_type)
     VALUES ('mnr', 'SCHED', '20240115', 1)`,
  );
}

/** A couple of transfers.txt-shaped rows for GET /stops/{id} coverage. */
export function seedTransfers(): void {
  db.run(
    `INSERT INTO transfers (feed_id, from_stop_id, to_stop_id, transfer_type, min_transfer_time)
     VALUES ('subway', '127', '902', 2, 180)`,
  );
  db.run(
    `INSERT INTO transfers (feed_id, from_stop_id, to_stop_id, from_trip_id, to_trip_id, transfer_type)
     VALUES ('lirr', '237', '237', 'GO201_26_SCHED', 'GO201_26_SCHED_2', 1)`,
  );
}
