import { Database } from 'bun:sqlite';
import { config } from '../config';
import {
  CREATE_STOPS,
  CREATE_ROUTES,
  CREATE_TRIPS,
  CREATE_STOP_TIMES,
  CREATE_CALENDAR,
  CREATE_CALENDAR_DATES,
  CREATE_FEED_META,
  CREATE_INDEXES,
} from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

function createDb(): Database {
  if (config.dbPath !== ':memory:') {
    mkdirSync(dirname(config.dbPath), { recursive: true });
  }
  const db = new Database(config.dbPath, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

export const db = createDb();

function hasColumn(tableName: string, columnName: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function recreateStaticTables() {
  db.run('DROP TABLE IF EXISTS stop_times');
  db.run('DROP TABLE IF EXISTS trips');
  db.run('DROP TABLE IF EXISTS calendar_dates');
  db.run('DROP TABLE IF EXISTS calendar');
  db.run('DROP TABLE IF EXISTS routes');
  db.run('DROP TABLE IF EXISTS stops');
}

export function resetStaticData() {
  db.run('DELETE FROM stop_times');
  db.run('DELETE FROM trips');
  db.run('DELETE FROM calendar_dates');
  db.run('DELETE FROM calendar');
  db.run('DELETE FROM routes');
  db.run('DELETE FROM stops');
  db.run('DELETE FROM feed_meta');
}

export function runMigrations() {
  const needsRebuild =
    hasColumn('stops', 'stop_id') && !hasColumn('stops', 'feed_id');

  if (needsRebuild) {
    recreateStaticTables();
  }

  db.run(CREATE_STOPS);
  db.run(CREATE_ROUTES);
  db.run(CREATE_TRIPS);
  db.run(CREATE_STOP_TIMES);
  db.run(CREATE_CALENDAR);
  db.run(CREATE_CALENDAR_DATES);
  db.run(CREATE_FEED_META);
  for (const idx of CREATE_INDEXES) {
    db.run(idx);
  }
}
