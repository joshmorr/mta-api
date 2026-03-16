/**
 * One-off script to seed the database from all static GTFS feeds.
 * Run with: bun run scripts/seed.ts
 */
import { resetStaticData, runMigrations } from '../src/db/client';
import { syncSubwayFeed, syncLirrFeed, syncMnrFeed } from '../src/services/static.service';

async function main() {
  console.error('[seed] Running migrations...');
  runMigrations();
  resetStaticData();

  console.error('[seed] Downloading and importing all feeds (this may take a minute)...');
  await syncSubwayFeed();
  await syncLirrFeed();
  await syncMnrFeed();

  console.error('[seed] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] Error:', err);
  process.exit(1);
});
