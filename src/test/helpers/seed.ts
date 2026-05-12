import { db, resetStaticData } from '../../db/client';

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
  db.run(
    `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
     VALUES ('lirr', 'PW', 'LI', 'PW', 'Port Washington Branch', '#00985F', 2)`,
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
     VALUES ('mnr', 'HUDSON', 'MNR', 'Hudson', 'Hudson Line', '#009B3A', 2)`,
  );
}
