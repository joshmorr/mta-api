import { Hono } from 'hono';
import type { StopDetail } from '../types/api';
import { getStopById, getPlatforms, getParentId } from '../db/queries/stops';
import { parseFeedId } from './feedParams';

export const feedStopsRouter = new Hono();

feedStopsRouter.get('/:feed_id/stops/:stop_id', (c) => {
  const stopId = c.req.param('stop_id');
  const feedId = parseFeedId(c.req.param('feed_id'));

  if (!feedId) {
    return c.json({ error: 'feed_id must be one of subway, lirr, mnr', code: 'INVALID_PARAM' }, 400);
  }

  const stop = getStopById(stopId, feedId);

  if (!stop) {
    return c.json({ error: `Stop ${stopId} not found`, code: 'NOT_FOUND' }, 404);
  }

  const parentId = stop.feed_id === 'subway' && stop.location_type === 0
    ? getParentId(stop.feed_id, stopId) ?? stopId
    : stopId;
  const parent = parentId !== stopId
    ? getStopById(parentId, stop.feed_id) ?? stop
    : stop;

  const platforms = parent.feed_id === 'subway' ? getPlatforms(parent.feed_id, parent.stop_id) : [];

  const detail: StopDetail = {
    feed_id: parent.feed_id,
    stop_id: parent.stop_id,
    stop_name: parent.stop_name,
    lat: parent.stop_lat,
    lon: parent.stop_lon,
    platforms: platforms.map((platform) => ({
      stop_id: platform.stop_id,
      direction: inferDirection(platform.stop_id),
    })),
  };

  return c.json(detail);
});

function inferDirection(stopId: string): string {
  if (stopId.endsWith('N')) return 'Uptown / Northbound';
  if (stopId.endsWith('S')) return 'Downtown / Southbound';
  return stopId;
}