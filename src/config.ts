export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/mta.db',
  rtCacheTtlMs: Number(process.env.RT_CACHE_TTL_MS ?? 20_000),
  rtFetchTimeoutMs: Number(process.env.RT_FETCH_TIMEOUT_MS ?? 10_000),
  staticFetchTimeoutMs: Number(process.env.STATIC_FETCH_TIMEOUT_MS ?? 60_000),
  subwaySyncIntervalMs: Number(process.env.SUBWAY_SYNC_INTERVAL_MS ?? 3_600_000),
  railSyncIntervalMs: Number(process.env.RAIL_SYNC_INTERVAL_MS ?? 86_400_000),
  // When false, this instance never downloads/writes static feeds — it only
  // reads whatever is already in its DB. Every instance owns its own SQLite
  // volume today, so this stays true; it's the seam for a future topology where
  // one writer syncs a DB that read-only replicas share.
  syncEnabled: process.env.SYNC_ENABLED !== 'false',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
