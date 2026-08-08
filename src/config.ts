const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 100);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './data/mta.db',
  rtCacheTtlMs: Number(process.env.RT_CACHE_TTL_MS ?? 10_000),
  alertsRtCacheTtlMs: Number(process.env.ALERTS_RT_CACHE_TTL_MS ?? 30_000),
  rtFetchTimeoutMs: Number(process.env.RT_FETCH_TIMEOUT_MS ?? 10_000),
  staticFetchTimeoutMs: Number(process.env.STATIC_FETCH_TIMEOUT_MS ?? 60_000),
  rateLimitMax,
  // MCP is chattier per unit of work than REST — a session spends 3 requests on
  // the handshake before any data, and an agent turn is routinely several tool
  // calls. Defaults to 5x the REST ceiling so tuning RATE_LIMIT_MAX carries.
  mcpRateLimitMax: Number(process.env.MCP_RATE_LIMIT_MAX ?? rateLimitMax * 5),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
