import { getFeed } from '../cache/rtCache';
import type { AlertResponse, InformedEntity } from '../types/api';
import { toNumber, getEnglishText } from '../utils/realtime';

const ALERTS_FEED_PATH = 'camsys/all-alerts';

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
      return ie;
    });

    const active_periods = a.activePeriod.map((p) => ({
      start: toNumber(p.start),
      end: toNumber(p.end),
    }));

    alerts.push({
      id: entity.id,
      informed_entities,
      header: getEnglishText(a.headerText),
      description: getEnglishText(a.descriptionText),
      active_periods,
    });
  }

  return { generated_at, stale, feed_error, alerts };
}
