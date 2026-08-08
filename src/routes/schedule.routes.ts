import { createRoute, z } from '@hono/zod-openapi';
import { getSchedule } from '../services/schedule.service';
import { NotFoundError } from '../services/realtime.service';
import { createApiRouter } from '../utils/openapi';
import { ScheduleResponseSchema, ErrorSchema } from '../schemas/api';

export const scheduleRouter = createApiRouter();

const YYYYMMDD = /^\d{8}$/;

const getScheduleRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Schedule'],
  operationId: 'getSchedule',
  summary: 'Get the static timetable for a stop',
  description:
    'Returns scheduled departures from a stop, sourced from the static GTFS timetable (not realtime). ' +
    'Unlike /arrivals, results are unaffected by feed outages and extend arbitrarily far into the future. ' +
    'Provide `to` to filter to departures that reach a specific destination stop, with duration_seconds included.',
  request: {
    query: z.object({
      stop: z.string().openapi({ description: 'Stop ID', example: '44' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed the stop belongs to' }),
      to: z.string().optional().openapi({ description: 'Destination stop ID to filter departures by', example: '237' }),
      after: z.coerce.number({ message: 'must be a number' }).int().nonnegative({ message: 'must be >= 0' }).optional()
        .openapi({ description: 'Unix seconds cursor - only departures at or after this instant are returned. Defaults to now, or the start of `date` if `date` is given without `after`.', example: 1754651400 }),
      date: z.string().regex(YYYYMMDD, { message: 'must be YYYYMMDD' }).optional()
        .openapi({ description: 'Pin the query to a single YYYYMMDD service date instead of the default 3-day [yesterday, today, tomorrow] window - gives the whole day\'s timetable when `after` is also omitted.', example: '20260810' }),
      limit: z.coerce.number({ message: 'must be a number' }).int().positive({ message: 'must be greater than 0' }).default(20).transform((n) => Math.min(n, 100))
        .openapi({ description: 'Max departures to return (clamped to 100, default 20)', example: 20 }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: ScheduleResponseSchema } }, description: 'Scheduled departures' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Stop (or destination stop) not found' },
  },
});

scheduleRouter.openapi(getScheduleRoute, (c) => {
  const { stop, feed, to, after, date, limit } = c.req.valid('query');

  try {
    const result = getSchedule({ stopId: stop, feedId: feed, toStopId: to, after, date, limit });
    return c.json(result, 200 as const);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404 as const);
    }
    throw err;
  }
});
