// Bun test preload — runs before any test module is imported.
// Forces the SQLite client to use an in-memory DB so tests never touch ./data/mta.db,
// then runs migrations so the schema exists for any query run by tests.
process.env.DB_PATH = ':memory:';

const { runMigrations } = await import('../src/db/client');
runMigrations();

export {};
