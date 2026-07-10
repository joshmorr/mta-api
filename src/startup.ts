import { runMigrations } from './db/client';
import { isDbEmpty } from './services/static.service';
import { refreshHealthCache } from './services/healthCache';

export async function startup() {
  runMigrations();
  // Prime the /health cache from whatever is already on disk before serving.
  refreshHealthCache();

  if (isDbEmpty()) {
    console.error(
      '[startup] DB is empty — run `bun run seed` to build it locally, or provide ' +
      'a prebuilt DB via DB_URL/start.sh; see README.',
    );
    process.exit(1);
  }
}
