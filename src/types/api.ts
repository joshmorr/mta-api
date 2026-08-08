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
