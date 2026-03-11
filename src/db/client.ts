import { Database } from 'bun:sqlite';
import { config } from '../config';
import {
  CREATE_STOPS,
  CREATE_ROUTES,
  CREATE_TRIPS,
  CREATE_STOP_TIMES,
  CREATE_CALENDAR,
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

export function runMigrations() {
  db.run(CREATE_STOPS);
  db.run(CREATE_ROUTES);
  db.run(CREATE_TRIPS);
  db.run(CREATE_STOP_TIMES);
  db.run(CREATE_CALENDAR);
  db.run(CREATE_FEED_META);
  for (const idx of CREATE_INDEXES) {
    db.run(idx);
  }
}
