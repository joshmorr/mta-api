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
  summary: 'Get scheduled trips between two stations',
  description:
    'Returns scheduled trips from `from` to `to`, sourced from the static GTFS timetable (not realtime). ' +
    'Every departure reaches `to` later in its trip and carries a `destination` block with the arrival ' +
    'time there and duration_seconds. Unlike /arrivals, results are unaffected by feed outages and extend ' +
    'arbitrarily far into the future. For single-station departures right now, use /arrivals instead.',
  request: {
    query: z.object({
      from: z.string().openapi({ description: 'Origin stop ID', example: '44' }),
      feed: z.enum(['subway', 'lirr', 'mnr']).openapi({ description: 'Feed both stops belong to' }),
      to: z.string({
        message: 'required - /schedule returns trips between two stations; use /arrivals for single-station departures',
      }).openapi({ description: 'Destination stop ID', example: '237' }),
      after: z.coerce.number({ message: 'must be a number' }).int().nonnegative({ message: 'must be >= 0' }).optional()
        .openapi({ description: 'Unix seconds cursor - only departures at or after this instant are returned. Defaults to now, or the start of `date` if `date` is given without `after`.', example: 1754651400 }),
      date: z.string().regex(YYYYMMDD, { message: 'must be YYYYMMDD' }).optional()
        .openapi({ description: 'Pin the query to a single YYYYMMDD service date instead of the default 3-day [yesterday, today, tomorrow] window - gives the whole day\'s timetable when `after` is also omitted.', example: '20260810' }),
      limit: z.coerce.number({ message: 'must be a number' }).int().positive({ message: 'must be greater than 0' }).default(20).transform((n) => Math.min(n, 100))
        .openapi({ description: 'Max departures to return (clamped to 100, default 20)', example: 20 }),
    }),
  },
  responses: {
    200: { content: { 'application/json': { schema: ScheduleResponseSchema } }, description: 'Scheduled trips between the two stops' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Invalid parameters' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Origin or destination stop not found' },
  },
});

scheduleRouter.openapi(getScheduleRoute, (c) => {
  const { from, feed, to, after, date, limit } = c.req.valid('query');

  try {
    const result = getSchedule({ fromStopId: from, feedId: feed, toStopId: to, after, date, limit });
    return c.json(result, 200 as const);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message, code: 'NOT_FOUND' }, 404 as const);
    }
    throw err;
  }
});
