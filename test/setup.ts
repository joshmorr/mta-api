// Bun test preload — runs before any test module is imported.
// Forces the SQLite client to use an in-memory DB so tests never touch ./data/mta.db,
// then runs migrations so the schema exists for any query run by tests.
process.env.DB_PATH = ':memory:';

// Several suites deliberately exercise upstream-failure paths, which now log at
// error level — that would bury the test output. Silence the logger unless the
// developer asked for it explicitly (`LOG_LEVEL=info bun test`).
process.env.LOG_LEVEL ??= 'silent';

const { runMigrations } = await import('../src/db/client');
runMigrations();

export {};
