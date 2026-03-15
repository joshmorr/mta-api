export const CREATE_STOPS = `
CREATE TABLE IF NOT EXISTS stops (
  feed_id         TEXT NOT NULL,
  stop_id         TEXT NOT NULL,
  stop_name       TEXT NOT NULL,
  stop_lat        REAL,
  stop_lon        REAL,
  location_type   INTEGER,
  parent_station  TEXT,
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
  PRIMARY KEY (feed_id, route_id)
)`;

export const CREATE_TRIPS = `
CREATE TABLE IF NOT EXISTS trips (
  feed_id      TEXT NOT NULL,
  trip_id      TEXT NOT NULL,
  route_id     TEXT NOT NULL,
  service_id   TEXT,
  direction_id INTEGER,
  shape_id     TEXT,
  PRIMARY KEY (feed_id, trip_id),
  FOREIGN KEY (feed_id, route_id) REFERENCES routes(feed_id, route_id)
)`;

export const CREATE_STOP_TIMES = `
CREATE TABLE IF NOT EXISTS stop_times (
  feed_id        TEXT NOT NULL,
  trip_id        TEXT NOT NULL,
  stop_id        TEXT NOT NULL,
  arrival_time   TEXT,
  departure_time TEXT,
  stop_sequence  INTEGER,
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

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times(feed_id, stop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stop_times_trip_id ON stop_times(feed_id, trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_route_id     ON trips(feed_id, route_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stops_name         ON stops(stop_name COLLATE NOCASE)`,
  `CREATE INDEX IF NOT EXISTS idx_routes_type        ON routes(feed_id, route_type)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_dates     ON calendar_dates(feed_id, date)`,
];
