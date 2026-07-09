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

export interface StopDetail {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  platforms: PlatformDetail[];
}

export interface Arrival {
  feed_id: FeedId;
  route_id: string;
  trip_id: string;
  arrival_time: number;
  arrival_in_seconds: number;
  status: VehicleStopStatus;
}

export interface ArrivalResponse {
  feed_id: FeedId;
  stop_id: string;
  stop_name: string;
  direction?: string;
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

export interface AlertResponse {
  id: string;
  informed_entities: InformedEntity[];
  header: string;
  description: string;
  active_periods: { start: number; end: number }[];
}

export interface ErrorResponse {
  error: string;
  code: string;
}
