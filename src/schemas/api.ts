import { z } from 'zod';

export const FeedTypeSchema = z.enum(['subway', 'lirr', 'mnr']).openapi({
  description: 'Transit feed identifier',
  example: 'subway',
});

export const ErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
}).openapi('Error');

// --- Stops ---

export const PlatformDetailSchema = z.object({
  stop_id: z.string(),
  direction: z.string(),
}).openapi('PlatformDetail');

export const StopSummarySchema = z.object({
  feed_id: FeedTypeSchema,
  stop_id: z.string(),
  stop_name: z.string(),
  lat: z.number(),
  lon: z.number(),
  platforms: z.array(z.string()),
}).openapi('StopSummary');

export const StopDetailSchema = z.object({
  feed_id: FeedTypeSchema,
  stop_id: z.string(),
  stop_name: z.string(),
  lat: z.number(),
  lon: z.number(),
  platforms: z.array(PlatformDetailSchema),
}).openapi('StopDetail');

export const StopListResponseSchema = z.object({
  stops: z.array(StopSummarySchema),
}).openapi('StopListResponse');

// --- Routes ---

export const RouteResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  route_id: z.string(),
  name: z.string(),
  long_name: z.string(),
  color: z.string(),
}).openapi('Route');

export const RouteListResponseSchema = z.object({
  routes: z.array(RouteResponseSchema),
}).openapi('RouteListResponse');

// --- Arrivals ---

export const ArrivalSchema = z.object({
  feed_id: FeedTypeSchema,
  route_id: z.string(),
  trip_id: z.string(),
  arrival_time: z.number().openapi({ description: 'Unix timestamp of arrival' }),
  arrival_in_seconds: z.number(),
  status: z.enum(['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO']),
}).openapi('Arrival');

export const ArrivalResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  stop_id: z.string(),
  stop_name: z.string(),
  direction: z.string().optional(),
  generated_at: z.number().openapi({ description: 'Unix timestamp when the feed was generated' }),
  stale: z.boolean(),
  feed_error: z.string().optional(),
  arrivals: z.array(ArrivalSchema),
}).openapi('ArrivalResponse');

// --- Vehicles ---

export const VehicleResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  trip_id: z.string(),
  current_stop_id: z.string(),
  status: z.enum(['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO']),
  timestamp: z.number(),
}).openapi('Vehicle');

export const VehicleListResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  route_id: z.string(),
  generated_at: z.number(),
  vehicles: z.array(VehicleResponseSchema),
}).openapi('VehicleListResponse');

// --- Alerts ---

export const ActivePeriodSchema = z.object({
  start: z.number(),
  end: z.number(),
}).openapi('ActivePeriod');

export const AlertSchema = z.object({
  id: z.string(),
  routes_affected: z.array(z.string()),
  stops_affected: z.array(z.string()),
  header: z.string(),
  description: z.string(),
  active_periods: z.array(ActivePeriodSchema),
}).openapi('Alert');

export const AlertListResponseSchema = z.object({
  generated_at: z.number(),
  stale: z.boolean(),
  feed_error: z.string().optional(),
  alerts: z.array(AlertSchema),
}).openapi('AlertListResponse');

// --- Shared query params ---

export const FeedQuerySchema = z.object({
  feed: FeedTypeSchema,
});

export const OptionalFeedQuerySchema = z.object({
  feed: FeedTypeSchema.optional(),
});

// --- Health ---

export const FeedHealthSchema = z.object({
  last_synced: z.number().nullable(),
  stop_count: z.number(),
  route_count: z.number(),
}).openapi('FeedHealth');

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  totals: z.object({
    stop_count: z.number(),
    route_count: z.number(),
  }),
  static_feeds: z.object({
    subway: FeedHealthSchema,
    lirr: FeedHealthSchema,
    mnr: FeedHealthSchema,
  }),
}).openapi('HealthResponse');
