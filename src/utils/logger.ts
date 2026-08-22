/**
 * The one and only pino instance in this process.
 *
 * **Everything here writes to fd 2 (stderr), deliberately and non-negotiably.**
 * `src/mcp/stdio.ts` speaks JSON-RPC over stdout, so a single line written to
 * fd 1 corrupts the stream and every MCP tool call fails in a way that looks
 * like a client bug. pino's *default* destination is stdout, which is why no
 * other module may call `pino()` directly — import `log` from here instead.
 * `.oxlintrc.json` bans `console` everywhere but this file to keep that honest.
 *
 * Pretty-printing is dev-only: it routes through a worker thread
 * (pino-pretty/thread-stream), which is fine under Bun but is pure overhead in
 * production, where Fly ingests the JSON lines directly.
 */
import pino from 'pino';
import { config } from '../config';

const isProduction = process.env.NODE_ENV === 'production';

// `lat`/`lon` on /stops are a user's physical location. They arrive as query
// params and would otherwise be written verbatim into the access log, so they
// are censored at the logger rather than at each call site.
//
// The access log records the full request header set, which is useful for
// debugging and carries nothing sensitive *today* — this API has no auth. The
// credential headers are censored anyway so that adding auth, or sitting behind
// a proxy that injects one, can't quietly start writing secrets to the log.
const REDACT_PATHS = [
  'query.lat',
  'query.lon',
  'req.query.lat',
  'req.query.lon',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
];

export const log = pino(
  {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // `pid`/`hostname` are noise on Fly, which already tags every line with the
    // machine and app. Keep the base minimal; add fields per-call instead.
    base: undefined,
    ...(isProduction
      ? {}
      : { transport: { target: 'pino-pretty', options: { destination: 2, colorize: true, ignore: 'pid,hostname' } } }),
  },
  // In production, bind the destination explicitly. With a transport configured
  // (dev), pino owns the stream and pino-pretty is told `destination: 2` above.
  isProduction ? pino.destination(2) : undefined,
);

/**
 * Normalizes a caught `unknown` into something the `err` serializer renders
 * with type/message/stack, so `catch` sites don't each reinvent the check.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
