import { createRoute, z } from '@hono/zod-openapi';
import { getTripSchedule } from '../services/schedule.service';
import { NotFoundError } from '../services/realtime.service';
import { createApiRouter } from '../utils/openapi';
import { TripScheduleResponseSchema, ErrorSchema } from '../schemas/api';

export const tripsRouter = createApiRouter();

const YYYYMMDD = /^\d{8}$/;

const getTripRoute = createRoute({
  method: 'get',
  path: '/:trip_id',
  tags: ['Schedule'],
  operationId: 'getTrip',
  summary: 'Get the static schedule for a trip',
  description:
    'Resolves a trip_id - typically read off /arrivals or /schedule - to its full static stop-by-stop timetable. ' +
    'LIRR trip IDs must match exactly. Subway realtime trip IDs are frequently a suffix of the static ID and are ' +
    'resolved via a fallback match narrowed to the active service window. Metro-North realtime trip IDs cannot be ' +
    'resolved to a static trip at all - the two ID schemes are unrelated for that feed, so /arrivals-sourced MNR ' +
    'trip IDs will 404 here.',
  request: {
    params: z.object({
      trip_id: z.string().openapi({ description: 'Trip ID, as returned by /arrivals or /schedule', example: 'GO201_26_2701' }),
    }),
    query: z.object({
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the trip belongs to' }),
      date: z.string().regex(YYYYMMDD, { message: 'must be YYYYMMDD' }).optional()
        .openapi({ description: 'YYYYMMDD service date to compute timestamps against. Defaults to the first of [yesterday, today, tomorrow] the trip\'s service is active on; if none are, timestamps are null and raw HH:MM:SS times are returned instead.', example: '20260810' }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: TripScheduleResponseSchema } }, description: 'Trip schedule' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Trip not found (or unresolvable, for MNR)' },
  },
});

tripsRouter.openapi(getTripRoute, (c) => {
  const { trip_id: tripId } = c.req.valid('param');
  const { feed: feedId, date } = c.req.valid('query');

  try {
    const result = getTripSchedule({ tripId, feedId, date });
    return c.json(result, 200 as const);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404 as const);
    }
    throw err;
  }
});
