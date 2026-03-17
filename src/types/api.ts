export type FeedType = 'subway' | 'lirr' | 'mnr';

export interface StopSummary {
  feed_id: FeedType;
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

export interface StopDetail {
  feed_id: FeedType;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  platforms: PlatformDetail[];
}

export interface Arrival {
  feed_id: FeedType;
  route_id: string;
  trip_id: string;
  arrival_time: number;
  arrival_in_seconds: number;
  status: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';
}

export interface ArrivalResponse {
  feed_id: FeedType;
  stop_id: string;
  stop_name: string;
  direction?: string;
  generated_at: number;
  stale: boolean;
  feed_error?: string;
  arrivals: Arrival[];
}

export interface RouteResponse {
  feed_id: FeedType;
  route_id: string;
  name: string;
  long_name: string;
  color: string;
}

export interface VehicleResponse {
  feed_id: FeedType;
  trip_id: string;
  current_stop_id: string;
  status: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';
  timestamp: number;
}

export interface AlertResponse {
  id: string;
  routes_affected: string[];
  stops_affected: string[];
  header: string;
  description: string;
  active_periods: { start: number; end: number }[];
}

export interface ErrorResponse {
  error: string;
  code: string;
}
