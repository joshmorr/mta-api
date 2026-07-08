/**
 * Download the prebuilt SQLite DB from object storage into DB_PATH, if needed.
 *
 * Runs from start.sh BEFORE the server boots (the app opens the DB at import
 * time, so the file must be in place first). The heavy GTFS build happens once
 * in CI (see .github/workflows/build-db.yml) — instances just fetch the result.
 *
 * Object layout under DB_URL (a bucket base URL, no trailing slash):
 *   mta.db.gz       gzipped SQLite DB
 *   mta.db.version  a short version marker (CI run id / timestamp)
 *   mta.db.sha256   sha256 of the *uncompressed* DB (optional integrity check)
 *
 * A copy of the version marker is kept next to the DB (`${DB_PATH}.version`) so
 * we only re-download when the published version actually changes — cold starts
 * under Fly's auto-stop/start skip the transfer when the cache is current.
 *
 * Failure policy: if the remote is unreachable or corrupt but a usable local DB
 * already exists, warn and boot on the stale copy (don't fail a redeploy over a
 * bucket blip). If there is no usable local DB, exit non-zero so the machine
 * crash-loops out of rotation instead of serving an empty DB.
 *
 * Memory: the gzip stream is decompressed chunk-by-chunk (never buffered whole),
 * so this stays cheap even for the ~666MB DB on a 512MB machine.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'fs';

const DB_URL = process.env.DB_URL?.replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH ?? './data/mta.db';
const TIMEOUT_MS = Number(process.env.DB_FETCH_TIMEOUT_MS ?? 120_000);

const VERSION_URL = `${DB_URL}/mta.db.version`;
const GZ_URL = `${DB_URL}/mta.db.gz`;
const SHA_URL = `${DB_URL}/mta.db.sha256`;
const LOCAL_VERSION_PATH = `${DB_PATH}.version`;
const NEW_PATH = `${DB_PATH}.new`;

function log(msg: string) {
  console.error(`[fetch-db] ${msg}`);
}

/** Boot on the existing local DB if there is one, otherwise fail hard. */
function fallbackOrFail(reason: string): never {
  if (existsSync(DB_PATH)) {
    log(`WARNING: ${reason} — booting on existing local DB at ${DB_PATH}.`);
    process.exit(0);
  }
  log(`FATAL: ${reason} — and no local DB at ${DB_PATH}. Refusing to start.`);
  process.exit(1);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.text()).trim();
}

async function main() {
  if (!DB_URL) {
    log('DB_URL not set — skipping download (local/dev mode).');
    return;
  }

  // Cheap check: has the published version changed since we last downloaded?
  let remoteVersion: string;
  try {
    remoteVersion = await fetchText(VERSION_URL);
  } catch (e) {
    return fallbackOrFail(`could not read ${VERSION_URL}: ${(e as Error).message}`);
  }

  const localVersion = existsSync(LOCAL_VERSION_PATH)
    ? (await Bun.file(LOCAL_VERSION_PATH).text()).trim()
    : null;

  if (existsSync(DB_PATH) && localVersion === remoteVersion) {
    log(`Local DB is current (version ${remoteVersion}) — skipping download.`);
    return;
  }

  log(`Downloading DB version ${remoteVersion} (local: ${localVersion ?? 'none'})...`);

  // Optional integrity check against the uncompressed DB's sha256.
  let expectedSha: string | null = null;
  try {
    expectedSha = (await fetchText(SHA_URL)).split(/\s+/)[0] ?? null;
  } catch {
    log(`No ${SHA_URL} (or unreadable) — skipping checksum verification.`);
  }

  // Stream: gz response → gunzip → hash + write to NEW_PATH (bounded memory).
  const hasher = new Bun.CryptoHasher('sha256');
  try {
    const res = await fetch(GZ_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`GET ${GZ_URL} → ${res.status}`);

    const decompressed = res.body.pipeThrough(new DecompressionStream('gzip'));
    const reader = decompressed.getReader();
    const sink = Bun.file(NEW_PATH).writer();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        sink.write(value);
      }
      await sink.end();
    } catch (e) {
      try { await sink.end(); } catch { /* ignore */ }
      throw e;
    }
  } catch (e) {
    rmSync(NEW_PATH, { force: true });
    return fallbackOrFail(`download failed: ${(e as Error).message}`);
  }

  if (expectedSha) {
    const actualSha = hasher.digest('hex');
    if (actualSha !== expectedSha) {
      rmSync(NEW_PATH, { force: true });
      return fallbackOrFail(`checksum mismatch (expected ${expectedSha}, got ${actualSha})`);
    }
    log('Checksum verified.');
  }

  // Swap in the new DB. Drop any stale WAL/SHM sidecars from the previous file —
  // the published DB is a clean VACUUM INTO output with no pending WAL.
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
  renameSync(NEW_PATH, DB_PATH);
  writeFileSync(LOCAL_VERSION_PATH, `${remoteVersion}\n`);
  log(`DB updated to version ${remoteVersion}.`);
}

main().catch((err) => {
  // Any unexpected error still respects the fallback policy.
  fallbackOrFail(`unexpected error: ${err?.message ?? err}`);
});
