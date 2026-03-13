import { getFeed } from '../cache/rtCache';
import type { TranslatedString } from '../types/gtfs';
import type { AlertResponse } from '../types/api';

const ALERTS_FEED_PATH = 'camsys/all-alerts';

function toNumber(val: number | { toNumber(): number } | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'object') return val.toNumber();
  return val;
}

function getEnglishText(ts: TranslatedString | undefined): string {
  if (!ts) return '';
  const en = ts.translation.find((t) => t.language === 'en' || !t.language);
  return en?.text ?? '';
}

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

    const routes_affected = Array.from(
      new Set(a.informedEntity.map((e) => e.routeId).filter((r): r is string => !!r))
    );
    const stops_affected = Array.from(
      new Set(a.informedEntity.map((e) => e.stopId).filter((s): s is string => !!s))
    );
    const active_periods = a.activePeriod.map((p) => ({
      start: toNumber(p.start),
      end: toNumber(p.end),
    }));

    alerts.push({
      id: entity.id,
      routes_affected,
      stops_affected,
      header: getEnglishText(a.headerText),
      description: getEnglishText(a.descriptionText),
      active_periods,
    });
  }

  return { generated_at, stale, feed_error, alerts };
}
