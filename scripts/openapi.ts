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
// buildOpenApiDocument() already normalizes Hono `:param` keys to `{param}`,
// matching what the live `/doc` endpoint serves.
const doc = buildOpenApiDocument();

writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

const pathCount = Object.keys(doc.paths ?? {}).length;
console.error(`[openapi] wrote ${outPath} (${pathCount} paths)`);
