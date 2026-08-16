import { FeedId, VehicleStopStatus } from "./gtfs";

export interface StopSummary {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  platforms: string[];
}

export interface PlatformDetail {
  stop_id: string;
  direction: string;
}

export interface TransferDetail {
  to_stop_id: string;
  to_stop_name: string;
  /** GTFS transfer_type: 0 recommended, 1 timed, 2 requires min_transfer_time, 3 not possible. */
  transfer_type: number | null;
  min_transfer_time: number | null;
  /** MNR only; null on subway/LIRR. */
  from_route_id: string | null;
  to_route_id: string | null;
  /** LIRR/MNR only; null on subway, which ships no trip-level transfers. */
  from_trip_id: string | null;
  to_trip_id: string | null;
}

export interface StopDetail {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  platforms: PlatformDetail[];
  transfers: TransferDetail[];
}

export interface Arrival {
  feed_id: FeedId;
  route_id: string;
  /** Rider-facing label for the route. Show this, not `route_id`. */
  route_name: string;
  route_long_name: string;
  trip_id: string;
  arrival_time: number | null;
  arrival_in_seconds: number | null;
  /** `null` for departure-only updates (no scheduled arrival at this stop). */
  departure_time: number | null;
  departure_in_seconds: number | null;
  /** Seconds late (positive) or early (negative); `null` if not published. */
  delay_seconds: number | null;
  /** The last stop time update's stop, i.e. the trip's true terminus. */
  destination_stop_id: string | null;
  destination: string | null;
  /**
   * Compass direction at *this* station, from the matched platform suffix.
   * Subway only - LIRR/MNR platforms carry no N/S suffix.
   */
  direction: 'NORTH' | 'SOUTH' | null;
  /**
   * Branch-relative direction, LIRR only. Not a compass direction -
   * `direction_id=1` on a "Penn Station" trip means inbound, not south.
   */
  direction_id: 0 | 1 | null;
  direction_source: 'stop_suffix' | 'rt_direction_id' | null;
  /** LIRR/MNR train number, from the vehicle descriptor label. */
  train_number: string | null;
  /**
   * Assigned track at this stop, from the MTA Railroad feed extension.
   * LIRR/MNR only; always null on subway, where the platform is the stop.
   */
  track: string | null;
  /**
   * Railroad-published trip state - `On-Time`, `Late`, `Delayed`, `Departed`,
   * `Arriving`, `Arrived`, `Canceled`, `Bus`. Metro-North only in practice
   * (LIRR sends the field empty), and the sole cancellation signal on that
   * feed, which never sets schedule_relationship=CANCELED. Passed through
   * verbatim rather than normalized; cancelled trips are still returned.
   */
  train_status: string | null;
  /** `null` when the feed doesn't publish a vehicle status for this trip. */
  status: VehicleStopStatus | null;
  source: 'realtime';
}

export interface ArrivalResponse {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  generated_at: number;
  stale: boolean;
  feed_error?: string;
  arrivals: Arrival[];
}

export interface RouteResponse {
  feed_id: FeedId;
  route_id: string;
  name: string;
  long_name: string;
  color: string;
}

export interface VehicleResponse {
  feed_id: FeedId;
  trip_id: string;
  current_stop_id: string;
  status: VehicleStopStatus;
  timestamp: number;
}

export interface InformedEntity {
  agency_id?: string;
  route_id?: string;
  stop_id?: string;
  direction_id?: 0 | 1;
}

export interface ActivePeriod {
  start: number;
  end: number;
}

export interface AlertResponse {
  id: string;
  informed_entities: InformedEntity[];
  header: string;
  description: string;
  active_periods: ActivePeriod[];
}

export interface ErrorResponse {
  error: string;
  code: string;
}

// --- Schedule (static timetable) ---

export interface ScheduledDepartureDestination {
  stop_id: string;
  stop_name: string;
  stop_sequence: number;
  arrival_time: string | null;
  arrival_timestamp: number | null;
  /** Seconds between this departure and the arrival at `to`. */
  duration_seconds: number | null;
}

export interface ScheduledDeparture {
  feed_id: FeedId;
  trip_id: string;
  route_id: string;
  route_name: string;
  route_long_name: string;
  service_id: string;
  /** The specific YYYYMMDD service date this row's timestamps were computed against. */
  service_date: string;
  stop_id: string;
  stop_sequence: number;
  arrival_time: string | null;
  departure_time: string;
  /** `null` only when the stop_time has no arrival_time published. */
  arrival_timestamp: number | null;
  departure_timestamp: number;
  departure_in_seconds: number;
  headsign: string | null;
  /** LIRR/MNR train number (trip_short_name); null on subway. */
  train_number: string | null;
  direction_id: 0 | 1 | null;
  track: string | null;
  /** LIRR/MNR fare period; null on subway, which has no such concept. */
  peak: boolean | null;
  pickup_type: number | null;
  drop_off_type: number | null;
  /** Where this trip reaches the requested `to` stop. */
  destination: ScheduledDepartureDestination;
}

export interface ScheduleResponse {
  feed_id: FeedId;
  from_stop_id: string;
  from_stop_name: string;
  to_stop_id: string;
  to_stop_name: string;
  /** The service dates actually queried, in query order. */
  service_dates: string[];
  generated_at: number;
  source: 'scheduled';
  departures: ScheduledDeparture[];
  /** Cursor for the next page (unix seconds), or `null` on a non-full page. */
  next_after: number | null;
}

export interface TripStop {
  stop_id: string;
  stop_name: string;
  parent_station_id: string | null;
  stop_sequence: number;
  arrival_time: string | null;
  departure_time: string | null;
  arrival_timestamp: number | null;
  departure_timestamp: number | null;
  track: string | null;
  pickup_type: number | null;
  drop_off_type: number | null;
}

export interface TripScheduleResponse {
  feed_id: FeedId;
  /** The trip_id as requested. */
  trip_id: string;
  /** The static trip_id the response actually describes — equals `trip_id` unless `matched_by` is `rt_trip_id_suffix`. */
  resolved_trip_id: string;
  matched_by: 'exact' | 'rt_trip_id_suffix';
  route_id: string;
  route_name: string;
  route_long_name: string;
  service_id: string;
  /**
   * The YYYYMMDD service date timestamps were computed against, or `null`
   * when none of the candidate dates had this trip's service active — in
   * that case every stop's `*_timestamp` is also `null`, but `*_time`
   * (the raw HH:MM:SS) is still populated.
   */
  service_date: string | null;
  direction_id: 0 | 1 | null;
  headsign: string | null;
  train_number: string | null;
  peak: boolean | null;
  source: 'scheduled';
  origin: TripStop;
  destination: TripStop;
  stops: TripStop[];
}
