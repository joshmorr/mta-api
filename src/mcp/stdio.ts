#!/usr/bin/env bun
/**
 * MCP server over stdio.
 *
 * Launched as a subprocess by an MCP client, which speaks JSON-RPC over this
 * process's stdin/stdout. Reads the same SQLite DB and realtime cache the HTTP
 * server does, so it needs no server running — but it does need a populated DB
 * at DB_PATH (`bun run seed`, or a prebuilt one fetched by start.sh).
 *
 * Two things this must not do:
 *
 *   - import `src/index.ts`. That runs `startup()` as an import side effect,
 *     which calls `process.exit(1)` on an empty DB. A tool client would see the
 *     server die on launch with no usable diagnostic. Migrations are run here
 *     instead, and an empty DB is reported per-call as a tool error.
 *   - write to stdout. That is the JSON-RPC channel; anything else on it
 *     corrupts the stream. All logging goes to stderr.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runMigrations } from '../db/client';
import { isDbEmpty } from '../services/static.service';
import { config } from '../config';
import { buildMcpServer } from './server';

runMigrations();

if (isDbEmpty()) {
  console.error(
    `[mcp] Warning: the DB at ${config.dbPath} is empty — schedule lookups will return nothing. ` +
    'Run `bun run seed` to build it locally, or set DB_URL and run scripts/fetch-db.ts.',
  );
}

serveStdio(buildMcpServer, {
  onerror: (err) => console.error('[mcp]', err),
});

console.error(`[mcp] mta-mcp-server ready on stdio (db: ${config.dbPath})`);
