#!/usr/bin/env bun
/**
 * Emit the OpenAPI 3.0 spec to a static `openapi.json` at the repo root.
 *
 * The committed file is the artifact client/codegen tools and coding agents
 * consume (openapi-typescript, orval, openapi-generator, …) without booting
 * the server or seeding the database. Regenerate after changing any route or
 * schema:  `bun run openapi:dump`
 *
 * Runs with DB_PATH=:memory: (set by the package.json script) so importing the
 * routers never touches the on-disk database.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildOpenApiDocument } from '../src/openapi';

const outPath = join(import.meta.dir, '..', 'openapi.json');
const doc = buildOpenApiDocument();

// The routes are registered with Hono's `:param` path syntax, which zod-openapi
// carries verbatim into the emitted path keys (e.g. `/stops/:stop_id`). Standard
// OpenAPI — and the codegen tools that consume this file — expect `{param}`.
// Normalize the path templates here so the committed artifact is spec-compliant
// without changing the runtime routes (path parameters are already declared
// correctly under `parameters`).
const normalizedPaths: Record<string, unknown> = {};
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  normalizedPaths[path.replace(/:([^/]+)/g, '{$1}')] = item;
}
doc.paths = normalizedPaths as typeof doc.paths;

writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

const pathCount = Object.keys(doc.paths ?? {}).length;
console.error(`[openapi] wrote ${outPath} (${pathCount} paths)`);
