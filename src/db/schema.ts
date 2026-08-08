export const CREATE_STOPS = `
CREATE TABLE IF NOT EXISTS stops (
  feed_id             TEXT NOT NULL,
  stop_id             TEXT NOT NULL,
  stop_name           TEXT NOT NULL,
  stop_lat            REAL,
  stop_lon            REAL,
  location_type       INTEGER,
  parent_station      TEXT,
  stop_code           TEXT,
  stop_desc           TEXT,
  zone_id             TEXT,
  wheelchair_boarding INTEGER,
  PRIMARY KEY (feed_id, stop_id)
)`;

export const CREATE_ROUTES = `
CREATE TABLE IF NOT EXISTS routes (
  feed_id          TEXT NOT NULL,
  route_id         TEXT NOT NULL,
  agency_id        TEXT,
  route_short_name TEXT,
  route_long_name  TEXT,
  route_color      TEXT,
  route_type       INTEGER,
  route_desc       TEXT,
  route_url        TEXT,
  route_text_color TEXT,
  route_sort_order INTEGER,
  PRIMARY KEY (feed_id, route_id)
)`;

export const CREATE_TRIPS = `
CREATE TABLE IF NOT EXISTS trips (
  feed_id               TEXT NOT NULL,
  trip_id               TEXT NOT NULL,
  route_id              TEXT NOT NULL,
  service_id            TEXT,
  direction_id          INTEGER,
  shape_id              TEXT,
  trip_headsign         TEXT,
  trip_short_name       TEXT,
  block_id              TEXT,
  wheelchair_accessible INTEGER,
  peak_offpeak          INTEGER,
  PRIMARY KEY (feed_id, trip_id),
  FOREIGN KEY (feed_id, route_id) REFERENCES routes(feed_id, route_id)
)`;

export const CREATE_STOP_TIMES = `
CREATE TABLE IF NOT EXISTS stop_times (
  feed_id           TEXT NOT NULL,
  trip_id           TEXT NOT NULL,
  stop_id           TEXT NOT NULL,
  arrival_time      TEXT,
  departure_time    TEXT,
  stop_sequence     INTEGER,
  track             TEXT,
  note_id           TEXT,
  pickup_type       INTEGER,
  drop_off_type     INTEGER,
  arrival_seconds   INTEGER,
  departure_seconds INTEGER,
  PRIMARY KEY (feed_id, trip_id, stop_id, stop_sequence),
  FOREIGN KEY (feed_id, trip_id) REFERENCES trips(feed_id, trip_id),
  FOREIGN KEY (feed_id, stop_id) REFERENCES stops(feed_id, stop_id)
)`;

export const CREATE_CALENDAR = `
CREATE TABLE IF NOT EXISTS calendar (
  feed_id    TEXT NOT NULL,
  service_id TEXT NOT NULL,
  monday     INTEGER, tuesday   INTEGER, wednesday INTEGER,
  thursday   INTEGER, friday    INTEGER, saturday  INTEGER, sunday INTEGER,
  start_date TEXT,
  end_date   TEXT,
  PRIMARY KEY (feed_id, service_id)
)`;

export const CREATE_CALENDAR_DATES = `
CREATE TABLE IF NOT EXISTS calendar_dates (
  feed_id        TEXT NOT NULL,
  service_id     TEXT NOT NULL,
  date           TEXT NOT NULL,
  exception_type INTEGER NOT NULL,
  PRIMARY KEY (feed_id, service_id, date)
)`;

export const CREATE_FEED_META = `
CREATE TABLE IF NOT EXISTS feed_meta (
  feed_id     TEXT PRIMARY KEY,
  last_synced INTEGER NOT NULL
)`;

// Plain rowid table, no declared PK. MNR alone has 13,744 rows over 114
// stops that differ only by from_trip_id/to_trip_id (per-trip guaranteed
// transfers); a (feed_id, from_stop_id, to_stop_id) PK would silently
// collapse most of them under INSERT OR REPLACE.
export const CREATE_TRANSFERS = `
CREATE TABLE IF NOT EXISTS transfers (
  feed_id           TEXT NOT NULL,
  from_stop_id      TEXT NOT NULL,
  to_stop_id        TEXT NOT NULL,
  transfer_type     INTEGER,
  min_transfer_time INTEGER,
  from_route_id     TEXT,
  to_route_id       TEXT,
  from_trip_id      TEXT,
  to_trip_id        TEXT
)`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times(feed_id, stop_id)`,
  // Covering index for the arrivals hot path (getServedRouteIdsByStopIds): that
  // query filters on (feed_id, stop_id) and then joins to trips on trip_id.
  // Carrying trip_id in the index lets SQLite answer the whole scan from the
  // index alone, with no row lookup into the 2.9M-row stop_times table.
  `CREATE INDEX IF NOT EXISTS idx_stop_times_stop_trip ON stop_times(feed_id, stop_id, trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stop_times_trip_id ON stop_times(feed_id, trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_route_id     ON trips(feed_id, route_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stops_name         ON stops(stop_name COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_routes_type        ON routes(feed_id, route_type)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_dates     ON calendar_dates(feed_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_transfers_from     ON transfers(feed_id, from_stop_id)`,
];
