import { z } from 'zod';
import { AlertListResponseSchema } from '../schemas/api';

/**
 * Tool input schemas.
 *
 * These deliberately do not reuse the request schemas in `src/schemas/api.ts`.
 * Those exist to parse a query string, so every numeric field is wrapped in
 * `z.coerce`; MCP arguments arrive as already-typed JSON, where coercion would
 * silently accept a string where a number belongs. The descriptions here are
 * also written for an agent choosing a tool rather than for a Swagger reader.
 *
 * Response schemas *are* reused — see `outputSchemas` below.
 */

const FEED_DESCRIPTION =
  'Which transit system the ID belongs to. Required, because the MTA reuses IDs ' +
  'across systems: stop_id "1" is a valid stop in all three feeds and means a ' +
  'different place in each.';

const FeedSchema = z.enum(['subway', 'lirr', 'mnr']);

export const SearchStopsInput = z.object({
  q: z.string().min(1).optional()
    .describe('Case-insensitive substring of the stop name, e.g. "Times Sq" or "Jamaica".'),
  lat: z.number().min(-90).max(90).optional()
    .describe('Latitude for a proximity search. Must be given together with lon.'),
  lon: z.number().min(-180).max(180).optional()
    .describe('Longitude for a proximity search. Must be given together with lat.'),
  feed: FeedSchema.optional()
    .describe('Restrict to one system. Omit to search all three.'),
  radius: z.number().positive().max(1600).default(400)
    .describe('Proximity search radius in metres (max 1600). Ignored unless lat and lon are given.'),
  limit: z.number().int().positive().max(50).default(20)
    .describe('Maximum stops to return.'),
}).strict();

export const GetStopInput = z.object({
  stop_id: z.string().min(1)
    .describe('Stop ID. A subway platform ID such as "127N" resolves up to its parent station.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
}).strict();

export const ListRoutesInput = z.object({
  feed: FeedSchema.optional()
    .describe('Restrict to one system. Omit to list routes across all three.'),
}).strict();

export const GetRouteInput = z.object({
  route_id: z.string().min(1)
    .describe('Route ID, e.g. "A" or "7" for subway, "PW" for LIRR, "HUDSON" for Metro-North.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
}).strict();

export const GetArrivalsInput = z.object({
  stop: z.string().min(1)
    .describe('Stop ID to get arrivals for. Use a parent station ID to cover every platform.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
  limit: z.number().int().positive().max(50).default(5)
    .describe('Maximum arrivals to return, soonest first.'),
  routes: z.array(z.string().min(1)).nonempty().optional()
    .describe('Only return arrivals for these route IDs. Omit for every route serving the stop.'),
  direction: z.enum(['NORTH', 'SOUTH']).optional()
    .describe('Filter to arrivals in this compass direction. Subway only - LIRR/MNR arrivals never carry a direction, so this excludes them entirely.'),
}).strict();

const YYYYMMDD_DESCRIPTION = 'YYYYMMDD, e.g. "20260810". Not a wall-clock string — a bare calendar date.';

export const GetScheduleInput = z.object({
  from: z.string().min(1)
    .describe('Origin stop ID. Use a parent station ID to cover every platform.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
  to: z.string().min(1)
    .describe('Destination stop ID. Only trips that reach this stop later are returned, each carrying a ' +
      '`destination` object with the arrival time there and duration_seconds. Required — for departures ' +
      'from a single station with no destination in mind, use mta_get_arrivals instead.'),
  after: z.number().int().nonnegative().optional()
    .describe('Unix seconds cursor — only departures at or after this instant are returned. Omit for "starting ' +
      'now" (or the start of `date`, if `date` is given without this).'),
  date: z.string().regex(/^\d{8}$/, 'must be YYYYMMDD').optional()
    .describe(`Pin the query to a single service date (${YYYYMMDD_DESCRIPTION}) instead of the default ` +
      '[yesterday, today, tomorrow] window — gives the whole day\'s timetable when `after` is also omitted.'),
  limit: z.number().int().positive().max(100).default(20)
    .describe('Maximum trips to return, soonest first.'),
}).strict();

export const GetTripInput = z.object({
  trip_id: z.string().min(1)
    .describe('Trip ID, typically read off the trip_id field of mta_get_arrivals or mta_get_schedule results.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
  date: z.string().regex(/^\d{8}$/, 'must be YYYYMMDD').optional()
    .describe(`Service date to compute timestamps against (${YYYYMMDD_DESCRIPTION}). Omit to default to the ` +
      'first of [yesterday, today, tomorrow] the trip\'s service is actually active on.'),
}).strict();

export const GetVehiclesInput = z.object({
  route: z.string().min(1)
    .describe('Route ID to list active vehicles for.'),
  feed: FeedSchema.describe(FEED_DESCRIPTION),
}).strict();

export const GetAlertsInput = z.object({
  routes: z.array(z.string().min(1)).nonempty().optional()
    .describe('Only return alerts naming one of these route IDs.'),
  stop_id: z.string().min(1).optional()
    .describe('Only return alerts naming this stop.'),
  direction: z.enum(['N', 'S']).optional()
    .describe('Narrow to one direction of travel at stop_id. Has no effect without stop_id. ' +
      'Alerts that name no direction affect both and are always kept.'),
  limit: z.number().int().positive().max(50).default(20)
    .describe('Maximum alerts to return after filtering. Alert descriptions are long, so ' +
      'prefer narrowing by route or stop over raising this.'),
}).strict();

/**
 * The alerts tool applies `limit` itself, so its result can hold fewer alerts
 * than the feed did. The extra field records that, and the API's response
 * schema has no place for it.
 */
export const AlertToolOutput = AlertListResponseSchema.extend({
  truncated: z.boolean().optional()
    .describe('True when `limit` dropped alerts that matched the filter.'),
  total_matched: z.number().optional()
    .describe('How many alerts matched the filter before `limit` was applied.'),
});
