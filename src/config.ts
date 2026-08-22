const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 100);

// Pino throws on an unrecognized level *inside* `pino()`, which runs at module
// load — so a typo in `fly secrets set LOG_LEVEL` used to kill the process at
// import time and crash-loop every machine. A logging knob must not be able to
// take the app down, so an unusable value falls back to the default instead.
//
// The full pino set is accepted here even though only info/warn/error/silent are
// documented: `debug` and `trace` are real levels that simply have no call sites
// today, and rejecting them would be a lie about why nothing was printed.
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
const DEFAULT_LOG_LEVEL = 'info';

const rawLogLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const logLevelIsUsable = !rawLogLevel || (LOG_LEVELS as readonly string[]).includes(rawLogLevel);

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
  logLevel: logLevelIsUsable && rawLogLevel ? rawLogLevel : DEFAULT_LOG_LEVEL,
  // Set only when LOG_LEVEL was present but unusable. src/utils/logger.ts reports
  // it once the logger exists; config cannot log, because the logger imports config.
  invalidLogLevel: logLevelIsUsable ? undefined : process.env.LOG_LEVEL,
} as const;
