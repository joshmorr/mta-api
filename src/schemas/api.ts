import { z } from 'zod';

export const FeedTypeSchema = z.enum(['subway', 'lirr', 'mnr']).openapi({
  description: 'Transit feed identifier',
  example: 'subway',
});

export const ErrorCodeSchema = z.enum([
  'INVALID_PARAM',
  'NOT_FOUND',
  'FEED_ERROR',
  'RATE_LIMITED',
  'INTERNAL',
]).openapi('ErrorCode', {
  description:
    'Stable machine-readable error code for client branching. ' +
    '`INVALID_PARAM`: a query/path parameter failed validation (400). ' +
    '`NOT_FOUND`: the requested entity or route does not exist (404). ' +
    '`FEED_ERROR`: an upstream realtime feed was unavailable and no cache could be served (503). ' +
    '`RATE_LIMITED`: too many requests (429). ' +
    '`INTERNAL`: an unexpected server error (500).',
  example: 'NOT_FOUND',
});

export const ErrorSchema = z.object({
  error: z.string().openapi({ description: 'Human-readable error message', example: 'Stop 999 not found' }),
  code: ErrorCodeSchema,
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

export const InformedEntitySchema = z.object({
  agency_id: z.string().optional(),
  route_id: z.string().optional(),
  stop_id: z.string().optional(),
  direction_id: z.union([z.literal(0), z.literal(1)]).optional().openapi({
    description: 'Affected direction of travel: 0 = Northbound, 1 = Southbound. Omitted when impact applies to both directions.',
  }),
}).openapi('InformedEntity');

export const AlertSchema = z.object({
  id: z.string(),
  informed_entities: z.array(InformedEntitySchema).openapi({
    description: 'Per-entry impact selectors preserving the (route, stop, direction) pairing from the upstream feed.',
  }),
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
