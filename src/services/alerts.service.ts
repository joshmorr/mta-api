import { getFeed } from '../cache/rtCache';
import { ALERTS_FEED_PATH } from './feed.service';
import type { AlertResponse, InformedEntity } from '../types/api';
import {
  toNumber,
  getEnglishText,
  mercuryAlert,
  mercurySortOrder,
  nonEmpty,
  priorityFromSortOrder,
} from '../utils/realtime';

export async function fetchAlerts(): Promise<{
  generated_at: number;
  stale: boolean;
  feed_error?: string;
  alerts: AlertResponse[];
}> {
  const { feedMessage, stale, feed_error } = await getFeed(ALERTS_FEED_PATH);

  const generated_at = toNumber(feedMessage.header.timestamp);
  const alerts: AlertResponse[] = [];

  for (const entity of feedMessage.entity) {
    if (!entity.alert) continue;
    const a = entity.alert;

    // The Mercury rank lives per informed entity, but ranking a list of alerts
    // needs one number per alert, so take the highest across them. Ranks run
    // 1 (lowest) to 35 (highest, = Suspended) over the MTA's shared list.
    let priority: number | null = null;

    const informed_entities: InformedEntity[] = a.informedEntity.map((e) => {
      const ie: InformedEntity = {};
      if (e.agencyId) ie.agency_id = e.agencyId;
      if (e.routeId) ie.route_id = e.routeId;
      if (e.stopId) ie.stop_id = e.stopId;
      // protobufjs exposes proto2 scalar defaults via the prototype, so we
      // need own-property presence to distinguish "unset" from "set to 0".
      if (Object.prototype.hasOwnProperty.call(e, 'directionId')) {
        if (e.directionId === 0 || e.directionId === 1) ie.direction_id = e.directionId;
      }

      const rank = priorityFromSortOrder(mercurySortOrder(e));
      if (rank !== null && (priority === null || rank > priority)) priority = rank;

      return ie;
    });

    const active_periods = a.activePeriod.map((p) => ({
      start: toNumber(p.start),
      end: toNumber(p.end),
    }));

    // The MTA never sets the standard cause/effect, so what kind of alert this
    // is lives entirely in the Mercury extension.
    const mercury = mercuryAlert(a);

    alerts.push({
      id: entity.id,
      informed_entities,
      header: getEnglishText(a.headerText),
      description: getEnglishText(a.descriptionText),
      active_periods,
      alert_type: nonEmpty(mercury?.alertType),
      priority,
      human_readable_active_period: nonEmpty(
        getEnglishText(mercury?.humanReadableActivePeriod ?? undefined),
      ),
      updated_at: mercury?.updatedAt !== undefined ? toNumber(mercury.updatedAt) : null,
    });
  }

  return { generated_at, stale, feed_error, alerts };
}

/**
 * The alerts snapshot's own publish timestamp, without decoding a single alert.
 *
 * This is the cheap half of `fetchAlerts`: `getFeed` is a cache-map lookup on a
 * hit, and `header.timestamp` is the value the feed itself stamps, so a caller
 * can decide whether anything changed before paying for the entity walk, the
 * Mercury parsing and serializing the largest payload in the system
 * (`camsys/all-alerts` runs 570-585 KB against a publish interval measured in
 * minutes). `HTTP /alerts` uses it to answer a conditional GET with a 304.
 *
 * `stale` is passed through so callers can decline to report "unchanged" while
 * upstream is broken - the timestamp is frozen precisely *because* nothing new
 * is arriving, which is the opposite of what a 304 tells a client.
 */
export async function getAlertsSnapshotTimestamp(): Promise<{
  generated_at: number;
  stale: boolean;
}> {
  const { feedMessage, stale } = await getFeed(ALERTS_FEED_PATH);
  return { generated_at: toNumber(feedMessage.header.timestamp), stale };
}

export interface AlertFilter {
  routes?: string[];
  stopId?: string;
  direction?: 0 | 1;
}

/**
 * Active alerts, narrowed to the routes and/or stop the caller cares about.
 *
 * `stale` and `feed_error` are passed through rather than thrown on, so a
 * degraded upstream still yields whatever the last good fetch held.
 */
export async function getAlerts({ routes, stopId, direction }: AlertFilter = {}): Promise<{
  generated_at: number;
  stale: boolean;
  feed_error?: string;
  alerts: AlertResponse[];
}> {
  const { generated_at, stale, feed_error, alerts } = await fetchAlerts();

  let filtered = alerts;
  if (routes) {
    filtered = filtered.filter((a) =>
      a.informed_entities.some((ie) => ie.route_id && routes.includes(ie.route_id))
    );
  }
  if (stopId) {
    // Per §5.2: evaluate each informed_entity independently. An entry with
    // stop_id and no direction_id means both directions are affected.
    filtered = filtered.filter((a) =>
      a.informed_entities.some((ie) =>
        ie.stop_id === stopId &&
        (direction === undefined || ie.direction_id === undefined || ie.direction_id === direction)
      )
    );
  }

  return { generated_at, stale, feed_error, alerts: filtered };
}

/** GTFS direction_id is 0/1; the API also accepts the friendlier N/S aliases. */
export function parseDirection(value: 'N' | 'S' | '0' | '1' | undefined): 0 | 1 | undefined {
  if (value === 'N' || value === '0') return 0;
  if (value === 'S' || value === '1') return 1;
  return undefined;
}
