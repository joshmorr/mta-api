// `z` comes from @hono/zod-openapi, not from 'zod' directly: it is the same zod
// instance with `.openapi()` patched onto the prototype. Importing 'zod' here
// works only when some other module happens to have imported
// @hono/zod-openapi first, which leaves this file's evaluation order-dependent.
import { z } from '@hono/zod-openapi';

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

export const TransferDetailSchema = z.object({
  to_stop_id: z.string(),
  to_stop_name: z.string(),
  transfer_type: z.number().int().nullable().openapi({
    description: '0 recommended, 1 timed (vehicle guaranteed to wait), 2 requires min_transfer_time, 3 not possible.',
  }),
  min_transfer_time: z.number().int().nullable(),
  from_route_id: z.string().nullable().openapi({ description: 'MNR only; null on subway/LIRR.' }),
  to_route_id: z.string().nullable(),
  from_trip_id: z.string().nullable().openapi({ description: 'LIRR/MNR only; null on subway.' }),
  to_trip_id: z.string().nullable(),
}).openapi('TransferDetail');

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
  transfers: z.array(TransferDetailSchema),
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

// --- Route identity (shared by arrivals and vehicles) ---

const RouteIdField = z.string().openapi({
  description:
    'Internal GTFS route identifier. Not a display label — on LIRR and Metro-North it is an ' +
    'opaque number ("4" is the Ronkonkoma Branch). Use `route_name` when showing this to a user.',
  example: '4',
});

const RouteNameField = z.string().openapi({
  description:
    'Rider-facing name for the route: the subway bullet ("A", "7") or the commuter-rail branch ' +
    '("Ronkonkoma Branch"). Never empty — falls back to `route_id` if the schedule names no route.',
  example: 'Ronkonkoma Branch',
});

const RouteLongNameField = z.string().openapi({
  description: 'Longer route name where one exists, otherwise the same value as `route_name`.',
  example: 'Ronkonkoma Branch',
});

// --- Arrivals ---

export const ArrivalSchema = z.object({
  feed_id: FeedTypeSchema,
  route_id: RouteIdField,
  route_name: RouteNameField,
  route_long_name: RouteLongNameField,
  trip_id: z.string(),
  arrival_time: z.number().nullable().openapi({ description: 'Unix timestamp of arrival, or null for departure-only updates' }),
  arrival_in_seconds: z.number().nullable(),
  departure_time: z.number().nullable().openapi({ description: 'Unix timestamp of departure, or null if not published' }),
  departure_in_seconds: z.number().nullable(),
  delay_seconds: z.number().nullable().openapi({ description: 'Seconds late (positive) or early (negative); null if not published' }),
  destination_stop_id: z.string().nullable().openapi({ description: "The trip's true terminus - the last stop time update in the feed" }),
  destination: z.string().nullable().openapi({ description: 'Display name of destination_stop_id', example: 'Penn Station' }),
  direction: z.enum(['NORTH', 'SOUTH']).nullable()
    .openapi({ description: 'Compass direction at this station, from the matched platform suffix. Subway only.' }),
  direction_id: z.union([z.literal(0), z.literal(1)]).nullable()
    .openapi({ description: 'Branch-relative direction as published by LIRR - not a compass direction. LIRR only.' }),
  direction_source: z.enum(['stop_suffix', 'rt_direction_id']).nullable(),
  train_number: z.string().nullable().openapi({ description: 'LIRR/MNR train number', example: '2306' }),
  status: z.enum(['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO']).nullable()
    .openapi({ description: 'Vehicle status, or null if this feed doesn\'t publish it for this trip' }),
  source: z.literal('realtime'),
}).openapi('Arrival');

export const ArrivalResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  stop_id: z.string(),
  stop_name: z.string(),
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
  route_id: RouteIdField,
  route_name: RouteNameField,
  route_long_name: RouteLongNameField,
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

// --- Schedule (static timetable) ---

export const ScheduledDepartureDestinationSchema = z.object({
  stop_id: z.string(),
  stop_name: z.string(),
  stop_sequence: z.number().int(),
  arrival_time: z.string().nullable(),
  arrival_timestamp: z.number().nullable(),
  duration_seconds: z.number().nullable().openapi({ description: 'Seconds between this departure and the arrival at `to`.' }),
}).openapi('ScheduledDepartureDestination');

export const ScheduledDepartureSchema = z.object({
  feed_id: FeedTypeSchema,
  trip_id: z.string(),
  route_id: RouteIdField,
  route_name: RouteNameField,
  route_long_name: RouteLongNameField,
  service_id: z.string(),
  service_date: z.string().openapi({
    description: 'YYYYMMDD service date this row\'s timestamps were computed against.',
    example: '20260810',
  }),
  stop_id: z.string(),
  stop_sequence: z.number().int(),
  arrival_time: z.string().nullable().openapi({ description: 'Raw GTFS HH:MM:SS, or null if this stop_time has no arrival.' }),
  departure_time: z.string(),
  arrival_timestamp: z.number().nullable().openapi({ description: 'Unix timestamp, or null only when arrival_time is null.' }),
  departure_timestamp: z.number(),
  departure_in_seconds: z.number(),
  headsign: z.string().nullable(),
  train_number: z.string().nullable().openapi({ description: 'LIRR/MNR train number (trip_short_name); null on subway.' }),
  direction_id: z.union([z.literal(0), z.literal(1)]).nullable().openapi({
    description: 'Static GTFS direction_id, as published - not derived or inferred.',
  }),
  track: z.string().nullable(),
  peak: z.boolean().nullable().openapi({ description: 'LIRR/MNR fare period; null on subway, which has no such concept.' }),
  pickup_type: z.number().int().nullable(),
  drop_off_type: z.number().int().nullable(),
  destination: ScheduledDepartureDestinationSchema.openapi({
    description: 'Where this trip reaches the requested `to` stop, including duration_seconds.',
  }),
}).openapi('ScheduledDeparture');

export const ScheduleResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  from_stop_id: z.string(),
  from_stop_name: z.string(),
  to_stop_id: z.string(),
  to_stop_name: z.string(),
  service_dates: z.array(z.string()).openapi({ description: 'The service dates actually queried, in query order.' }),
  generated_at: z.number(),
  source: z.literal('scheduled'),
  departures: z.array(ScheduledDepartureSchema),
  next_after: z.number().nullable().openapi({ description: 'Cursor for the next page (unix seconds), or null on a non-full page.' }),
}).openapi('ScheduleResponse');

export const TripStopSchema = z.object({
  stop_id: z.string(),
  stop_name: z.string(),
  parent_station_id: z.string().nullable(),
  stop_sequence: z.number().int(),
  arrival_time: z.string().nullable(),
  departure_time: z.string().nullable(),
  arrival_timestamp: z.number().nullable(),
  departure_timestamp: z.number().nullable(),
  track: z.string().nullable(),
  pickup_type: z.number().int().nullable(),
  drop_off_type: z.number().int().nullable(),
}).openapi('TripStop');

export const TripScheduleResponseSchema = z.object({
  feed_id: FeedTypeSchema,
  trip_id: z.string().openapi({ description: 'The trip_id as requested.' }),
  resolved_trip_id: z.string().openapi({
    description: 'The static trip_id this response actually describes - equals `trip_id` unless `matched_by` is `rt_trip_id_suffix`.',
  }),
  matched_by: z.enum(['exact', 'rt_trip_id_suffix']),
  route_id: RouteIdField,
  route_name: RouteNameField,
  route_long_name: RouteLongNameField,
  service_id: z.string(),
  service_date: z.string().nullable().openapi({
    description: 'YYYYMMDD service date timestamps were computed against, or null when no candidate date had this trip\'s service active - every stop\'s *_timestamp is then also null, but *_time (raw HH:MM:SS) is still populated.',
  }),
  direction_id: z.union([z.literal(0), z.literal(1)]).nullable(),
  headsign: z.string().nullable(),
  train_number: z.string().nullable(),
  peak: z.boolean().nullable(),
  source: z.literal('scheduled'),
  origin: TripStopSchema,
  destination: TripStopSchema,
  stops: z.array(TripStopSchema),
}).openapi('TripScheduleResponse');

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
