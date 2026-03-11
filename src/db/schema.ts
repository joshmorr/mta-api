export const CREATE_STOPS = `
CREATE TABLE IF NOT EXISTS stops (
  stop_id         TEXT PRIMARY KEY,
  stop_name       TEXT NOT NULL,
  stop_lat        REAL,
  stop_lon        REAL,
  location_type   INTEGER,
  parent_station  TEXT
)`;

export const CREATE_ROUTES = `
CREATE TABLE IF NOT EXISTS routes (
  route_id         TEXT PRIMARY KEY,
  route_short_name TEXT,
  route_long_name  TEXT,
  route_color      TEXT,
  route_type       INTEGER
)`;

export const CREATE_TRIPS = `
CREATE TABLE IF NOT EXISTS trips (
  trip_id      TEXT PRIMARY KEY,
  route_id     TEXT NOT NULL,
  service_id   TEXT,
  direction_id INTEGER,
  shape_id     TEXT,
  FOREIGN KEY (route_id) REFERENCES routes(route_id)
)`;

export const CREATE_STOP_TIMES = `
CREATE TABLE IF NOT EXISTS stop_times (
  trip_id        TEXT NOT NULL,
  stop_id        TEXT NOT NULL,
  arrival_time   TEXT,
  departure_time TEXT,
  stop_sequence  INTEGER,
  PRIMARY KEY (trip_id, stop_id, stop_sequence),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id),
  FOREIGN KEY (stop_id) REFERENCES stops(stop_id)
)`;

export const CREATE_CALENDAR = `
CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday     INTEGER, tuesday   INTEGER, wednesday INTEGER,
  thursday   INTEGER, friday    INTEGER, saturday  INTEGER, sunday INTEGER,
  start_date TEXT,
  end_date   TEXT
)`;

export const CREATE_FEED_META = `
CREATE TABLE IF NOT EXISTS feed_meta (
  feed_id     TEXT PRIMARY KEY,
  last_synced INTEGER NOT NULL
)`;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times(stop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stop_times_trip_id ON stop_times(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_route_id     ON trips(route_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stops_name         ON stops(stop_name COLLATE NOCASE)`,
];
