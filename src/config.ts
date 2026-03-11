export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/mta.db',
  rtCacheTtlMs: Number(process.env.RT_CACHE_TTL_MS ?? 20_000),
  subwaySyncIntervalMs: Number(process.env.SUBWAY_SYNC_INTERVAL_MS ?? 3_600_000),
  railSyncIntervalMs: Number(process.env.RAIL_SYNC_INTERVAL_MS ?? 86_400_000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
