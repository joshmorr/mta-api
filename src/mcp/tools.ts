import type { McpServer } from '@modelcontextprotocol/server';
import { searchStops, getStopDetail } from '../services/stops.service';
import { listRoutes, getRoute } from '../services/routes.service';
import { getAlerts, parseDirection } from '../services/alerts.service';
import { getArrivalsForStop, getVehiclesForRoute, NotFoundError } from '../services/realtime.service';
import { getSchedule, getTripSchedule } from '../services/schedule.service';
import {
  StopListResponseSchema,
  StopDetailSchema,
  RouteListResponseSchema,
  RouteResponseSchema,
  ArrivalResponseSchema,
  VehicleListResponseSchema,
  ScheduleResponseSchema,
  TripScheduleResponseSchema,
} from '../schemas/api';
import {
  SearchStopsInput,
  GetStopInput,
  ListRoutesInput,
  GetRouteInput,
  GetArrivalsInput,
  GetVehiclesInput,
  GetAlertsInput,
  AlertToolOutput,
  GetScheduleInput,
  GetTripInput,
} from './schemas';

/** Static-schedule tools read the local SQLite snapshot; nothing leaves the process. */
const STATIC = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Realtime tools fetch live GTFS-RT feeds from the MTA. */
const REALTIME = { ...STATIC, openWorldHint: true } as const;

const FEED_NOTE =
  'The MTA reuses IDs across systems, so `feed` selects which one: "subway", ' +
  '"lirr" (Long Island Rail Road), or "mnr" (Metro-North Railroad).';

const ROUTE_NAME_NOTE =
  'Always refer to a route by `route_name` — never by `route_id`. On LIRR and Metro-North the ID ' +
  'is an opaque number, so showing it produces meaningless labels like "Route 4" where the rider ' +
  'expects "Ronkonkoma Branch". On the subway `route_name` is the familiar bullet ("A", "7").';

function ok<T>(structuredContent: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

function fail(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/**
 * Turn a thrown service error into a tool error the agent can act on.
 *
 * NotFoundError is the common case and almost always means the caller guessed
 * an ID or picked the wrong feed, so the message says which lookup tool to
 * reach for next rather than just restating the failure.
 */
function toToolError(err: unknown, hint: string) {
  if (err instanceof NotFoundError) return fail(`${err.message}. ${hint}`);
  const message = err instanceof Error ? err.message : String(err);
  return fail(`Upstream realtime feed unavailable: ${message}. The MTA feed may be down; retry shortly.`);
}

/**
 * The schedule/trip tools read only the static SQLite snapshot — there is no
 * upstream feed to blame a failure on, so unlike `toToolError` this doesn't
 * invent a "feed unavailable" story for whatever isn't a NotFoundError. A
 * NotFoundError means the caller guessed an ID; anything else is a genuine
 * bug and is rethrown rather than mislabeled.
 */
function toNotFoundToolError(err: unknown, hint: string) {
  if (err instanceof NotFoundError) return fail(`${err.message}. ${hint}`);
  throw err;
}

export function registerMtaTools(server: McpServer): void {
  server.registerTool(
    'mta_search_stops',
    {
      title: 'Search MTA stops',
      description:
        'Find MTA stops (stations) by name, by proximity to a coordinate, or unfiltered. ' +
        `Returns each stop's ID, name, coordinates, and — for the subway — its platform IDs. ${FEED_NOTE}\n\n` +
        'This is the entry point for most questions: other tools take a stop_id, and this is how you get one. ' +
        'Subway results are always parent stations, never individual platforms.\n\n' +
        'Give `q` for a name search, or `lat`+`lon` for a proximity search. If both are given, proximity wins. ' +
        'Give neither to page through every stop.',
      inputSchema: SearchStopsInput,
      outputSchema: StopListResponseSchema,
      annotations: STATIC,
    },
    async ({ q, lat, lon, feed, radius, limit }) => {
      if ((lat === undefined) !== (lon === undefined)) {
        return fail('A proximity search needs both lat and lon. Provide both, or use q for a name search.');
      }
      const stops = searchStops({ q, lat, lon, feed, radius, limit });
      if (stops.length === 0) {
        return fail(
          q
            ? `No stops match "${q}"${feed ? ` in the ${feed} feed` : ''}. Try a shorter substring — matching is on the stop name, so "42 St" beats "42nd Street".`
            : 'No stops found. Try widening the radius or dropping the feed filter.',
        );
      }
      return ok({ stops });
    },
  );

  server.registerTool(
    'mta_get_stop',
    {
      title: 'Get an MTA stop',
      description:
        'Full detail for one stop: name, coordinates, its platforms with the direction each serves, and any ' +
        'GTFS transfers.txt connections to other stops. ' +
        `${FEED_NOTE}\n\n` +
        'Subway stops are hierarchical — passing a platform ID such as "127N" returns its parent station "127" ' +
        'with every platform listed. LIRR and Metro-North stops are flat and have no platforms.\n\n' +
        'transfers[] lists other stops reachable via a declared transfer; from_route_id/to_route_id are MNR-only ' +
        'and from_trip_id/to_trip_id are LIRR/MNR-only (per-trip guaranteed transfers) — expect duplicate ' +
        'to_stop_id entries when a station has several such trip pairs.\n\n' +
        'Use mta_search_stops first if you have a station name rather than an ID.',
      inputSchema: GetStopInput,
      outputSchema: StopDetailSchema,
      annotations: STATIC,
    },
    async ({ stop_id, feed }) => {
      const stop = getStopDetail(stop_id, feed);
      if (!stop) {
        return fail(
          `No stop "${stop_id}" in the ${feed} feed. The same ID may exist in another feed — ` +
          'check the others, or use mta_search_stops to find the right ID by name.',
        );
      }
      return ok(stop);
    },
  );

  server.registerTool(
    'mta_list_routes',
    {
      title: 'List MTA routes',
      description:
        'Every route (subway line or commuter-rail branch), optionally restricted to one system. ' +
        `${FEED_NOTE}\n\n` +
        'Returns route ID, short and long name, and the official hex colour. Subway route IDs are the ' +
        'familiar single characters ("A", "7", "L"); LIRR and Metro-North use branch codes ("PW", "HUDSON").\n\n' +
        'The full list is small — use this to discover valid route IDs for mta_get_vehicles or mta_get_alerts.',
      inputSchema: ListRoutesInput,
      outputSchema: RouteListResponseSchema,
      annotations: STATIC,
    },
    async ({ feed }) => ok({ routes: listRoutes(feed) }),
  );

  server.registerTool(
    'mta_get_route',
    {
      title: 'Get an MTA route',
      description:
        `Detail for one route: its names and official colour. ${FEED_NOTE}\n\n` +
        'Use mta_list_routes to discover valid route IDs.',
      inputSchema: GetRouteInput,
      outputSchema: RouteResponseSchema,
      annotations: STATIC,
    },
    async ({ route_id, feed }) => {
      const route = getRoute(route_id, feed);
      if (!route) {
        return fail(
          `No route "${route_id}" in the ${feed} feed. Use mta_list_routes to see the valid IDs for that feed.`,
        );
      }
      return ok(route);
    },
  );

  server.registerTool(
    'mta_get_schedule',
    {
      title: 'Get the static timetable for an MTA stop',
      description:
        'Scheduled departures from a stop, sourced from the static GTFS timetable rather than a realtime ' +
        `feed. ${FEED_NOTE}\n\n` +
        'Unlike mta_get_arrivals, results are unaffected by feed outages and extend arbitrarily far into the ' +
        'future or past: use `date` to look up a specific day\'s whole timetable, or the default rolling ' +
        '[yesterday, today, tomorrow] window with `after` (Unix seconds) to page forward through it. Give ' +
        '`to` to filter to departures whose trip reaches a specific destination stop — each then carries a ' +
        '`destination` object with the arrival time there and duration_seconds.\n\n' +
        `${ROUTE_NAME_NOTE}\n\n` +
        'Answers "what time do trains run" or "how do I get from A to B and how long does it take" — for ' +
        '"when is the next train right now" prefer mta_get_arrivals instead, since this tool cannot see live ' +
        'delays, reroutes, or cancellations.\n\n' +
        'Use mta_search_stops first to turn a station name into an ID.',
      inputSchema: GetScheduleInput,
      outputSchema: ScheduleResponseSchema,
      annotations: STATIC,
    },
    async ({ stop, feed, to, after, date, limit }) => {
      try {
        return ok(getSchedule({ stopId: stop, feedId: feed, toStopId: to, after, date, limit }));
      } catch (err) {
        return toNotFoundToolError(
          err,
          `Check the stop (and destination, if given) exist in the ${feed} feed with mta_search_stops.`,
        );
      }
    },
  );

  server.registerTool(
    'mta_get_trip',
    {
      title: 'Get the static schedule for one MTA trip',
      description:
        'Resolves a trip_id — typically read off the trip_id field of mta_get_arrivals or mta_get_schedule — ' +
        'to its full static stop-by-stop schedule: every stop the trip visits, in order, with scheduled ' +
        `arrival/departure times and Unix timestamps. ${FEED_NOTE}\n\n` +
        'LIRR trip IDs must match exactly. Subway realtime trip IDs are frequently a *suffix* of the static ' +
        'ID and are resolved via a fallback match narrowed to the active service window — check `matched_by` ' +
        '("exact" or "rt_trip_id_suffix") and `resolved_trip_id` if you need to know which happened. ' +
        '**Metro-North realtime trip IDs cannot be resolved to a static trip at all** — the two ID schemes ' +
        'are unrelated for that feed, so an MNR trip_id read off mta_get_arrivals will always fail here. ' +
        'Do not retry with the same ID.\n\n' +
        `${ROUTE_NAME_NOTE}\n\n` +
        'Use `date` to pin which service date the timestamps are computed against; omitted, it defaults to ' +
        'the first of [yesterday, today, tomorrow] the trip is actually running on, or — if none of those ' +
        'three are — `service_date: null` with raw HH:MM:SS times only and every timestamp null.',
      inputSchema: GetTripInput,
      outputSchema: TripScheduleResponseSchema,
      annotations: STATIC,
    },
    async ({ trip_id, feed, date }) => {
      try {
        return ok(getTripSchedule({ tripId: trip_id, feedId: feed, date }));
      } catch (err) {
        return toNotFoundToolError(err, 'Check the trip_id and feed with mta_get_schedule or mta_get_arrivals.');
      }
    },
  );

  server.registerTool(
    'mta_get_arrivals',
    {
      title: 'Get upcoming MTA arrivals',
      description:
        'Live upcoming arrivals at a stop, soonest first, from the realtime GTFS-RT feeds. ' +
        `${FEED_NOTE}\n\n` +
        'Each arrival gives the route, trip ID, a Unix arrival timestamp, seconds until arrival, ' +
        'destination (the true terminus, from the last stop time update), and whether the train is ' +
        'approaching, stopped, or in transit - any of these may be null when the feed doesn\'t publish ' +
        'them for that trip. Pass a parent station ID to cover every platform, or a specific platform ID ' +
        'for one direction (or use the `direction` filter instead).\n\n' +
        'Direction is feed-honest, not uniform: subway `direction` (NORTH/SOUTH) comes from the matched ' +
        'platform, LIRR `direction_id` (0/1) is branch-relative (not compass) and comes straight from the ' +
        "railroad, and Metro-North has neither - its direction IS `destination`.\n\n" +
        `${ROUTE_NAME_NOTE}\n\n` +
        'Answers "when is the next train". Use mta_search_stops first to turn a station name into an ID.\n\n' +
        'The response carries `stale: true` when the upstream feed could not be reached and cached data ' +
        'was served instead, with `feed_error` explaining why. Data is cached for about 10 seconds, so ' +
        'calling repeatedly in quick succession returns the same result.',
      inputSchema: GetArrivalsInput,
      outputSchema: ArrivalResponseSchema,
      annotations: REALTIME,
    },
    async ({ stop, feed, limit, routes, direction }) => {
      try {
        return ok(await getArrivalsForStop(stop, limit, feed, routes, direction));
      } catch (err) {
        return toToolError(err, `Check the stop exists in the ${feed} feed with mta_search_stops.`);
      }
    },
  );

  server.registerTool(
    'mta_get_vehicles',
    {
      title: 'Get active MTA vehicles',
      description:
        'Every train currently active on a route, with its trip ID, the stop it is approaching or ' +
        `stopped at, and a Unix timestamp for the position. ${FEED_NOTE}\n\n` +
        `${ROUTE_NAME_NOTE}\n\n` +
        'Answers "how many trains are running" or "where are they right now". For arrivals at a ' +
        'particular station use mta_get_arrivals instead — this is the whole-line view.\n\n' +
        'Use mta_list_routes to discover valid route IDs.',
      inputSchema: GetVehiclesInput,
      outputSchema: VehicleListResponseSchema,
      annotations: REALTIME,
    },
    async ({ route, feed }) => {
      try {
        return ok(await getVehiclesForRoute(route, feed));
      } catch (err) {
        return toToolError(err, `Check the route exists in the ${feed} feed with mta_list_routes.`);
      }
    },
  );

  server.registerTool(
    'mta_get_alerts',
    {
      title: 'Get MTA service alerts',
      description:
        'Active service alerts — delays, planned work, reroutes, elevator outages — across all three ' +
        'systems, optionally narrowed to specific routes or a stop.\n\n' +
        'Each alert carries a header, a description, the active periods it applies to, and the ' +
        '(route, stop, direction) selectors it names. Unlike the other tools this one is not ' +
        'feed-scoped: alerts for all three systems come from a single upstream feed and are returned ' +
        'together, so filter by route or stop instead.\n\n' +
        'Answers "is anything wrong with the L train" or "why is my train delayed".\n\n' +
        'Alert descriptions are long. Narrow with `routes` or `stop_id` rather than raising `limit`; ' +
        'the response sets `truncated: true` and `total_matched` when `limit` dropped matching alerts.',
      inputSchema: GetAlertsInput,
      outputSchema: AlertToolOutput,
      annotations: REALTIME,
    },
    async ({ routes, stop_id, direction, limit }) => {
      try {
        const result = await getAlerts({
          routes,
          stopId: stop_id,
          direction: parseDirection(direction),
        });
        const total = result.alerts.length;
        const alerts = result.alerts.slice(0, limit);
        return ok({
          ...result,
          alerts,
          ...(total > alerts.length ? { truncated: true, total_matched: total } : {}),
        });
      } catch (err) {
        return toToolError(err, 'The alerts feed is upstream of this server.');
      }
    },
  );
}
