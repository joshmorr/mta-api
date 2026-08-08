/**
 * One-off script to seed the database from all static GTFS feeds.
 * Run with: bun run scripts/seed.ts
 */
import { analyzeDb, resetStaticData, runMigrations } from '../src/db/client';
import { syncSubwayFeed, syncLirrFeed, syncMnrFeed } from '../src/services/static.service';

async function main() {
  console.error('[seed] Running migrations...');
  // Safe here (unlike server boot): every feed is reimported right below, so
  // dropping out-of-date tables never leaves the DB emptier than it started.
  runMigrations({ allowDestructiveRebuild: true });
  resetStaticData();

  console.error('[seed] Downloading and importing all feeds (this may take a minute)...');
  await syncSubwayFeed();
  await syncLirrFeed();
  await syncMnrFeed();

  // Must run after every feed is imported — stats describe the data as it
  // stands, and the query planner needs them to pick the right index on the
  // arrivals path. See analyzeDb() in src/db/client.ts.
  console.error('[seed] Analyzing (collecting query planner statistics)...');
  analyzeDb();

  console.error('[seed] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
