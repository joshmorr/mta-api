/**
 * Produce a clean, single-file copy of a SQLite DB for publishing.
 *
 * `VACUUM INTO` writes a fully-checkpointed, compacted copy with no -wal/-shm
 * sidecars, so the published artifact is a single self-contained file. Used by
 * the CI build (.github/workflows/build-db.yml) after `bun run seed`.
 *
 * Usage: bun run scripts/vacuum-into.ts <src.db> <dest.db>
 */
import { Database } from 'bun:sqlite';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: bun run scripts/vacuum-into.ts <src.db> <dest.db>');
  process.exit(1);
}

const db = new Database(src);
db.run('PRAGMA wal_checkpoint(TRUNCATE)');
db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.error(`[vacuum] wrote ${dest} from ${src}`);
