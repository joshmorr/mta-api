#!/usr/bin/env bun
/**
 * static-probe — inspect the MTA's published static GTFS ZIPs without importing them.
 *
 * The three feeds this project consumes (subway, LIRR, MNR) were produced by
 * three different teams and disagree about quoting, which optional files exist,
 * and which columns are populated. Before writing a parser rule or asserting
 * "the feeds do X", check it here against the bytes the MTA is serving today.
 *
 * Downloads are cached under $TMPDIR so repeated probing is cheap; the
 * supplemented subway ZIP is ~19 MB and rebuilt hourly.
 *
 * Usage:
 *   bun .claude/skills/mta-gtfs/scripts/static-probe.ts --list
 *   bun .claude/skills/mta-gtfs/scripts/static-probe.ts <feed> --files
 *   bun .claude/skills/mta-gtfs/scripts/static-probe.ts <feed> --head <file.txt> [-n 5]
 *   bun .claude/skills/mta-gtfs/scripts/static-probe.ts <feed> --columns <file.txt>
 *   bun .claude/skills/mta-gtfs/scripts/static-probe.ts <feed> --grep <file.txt> <pattern> [-n 10]
 *
 * Options:
 *   --list             HEAD every published feed: size and Last-Modified, no download
 *   --files            list the ZIP's entries with compressed/uncompressed sizes
 *   --head <file>      print raw lines verbatim -- raw matters, since it is the
 *                      only way to see LIRR's full quoting and blank columns
 *   --columns <file>   header columns plus fill rate for each (how many rows
 *                      have a non-empty value), which is how you find columns
 *                      that exist but are empty on every row
 *   --grep <file> <re> print matching raw lines
 *   --no-cache         re-download even if a cached copy exists
 *
 * Feeds: subway (supplemented), subway-regular, lirr, mnr, and the six bus ZIPs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';

const HOST = 'https://rrgtfsfeeds.s3.amazonaws.com';

const FEEDS: Record<string, { file: string; note: string }> = {
  subway: { file: 'gtfs_supplemented.zip', note: 'base timetable + ~7 days of planned changes, rebuilt ~hourly' },
  'subway-regular': { file: 'gtfs_subway.zip', note: 'base timetable only, republished a few times a year' },
  lirr: { file: 'gtfslirr.zip', note: 'Long Island Rail Road' },
  mnr: { file: 'gtfsmnr.zip', note: 'Metro-North' },
  'bus-bronx': { file: 'gtfs_bx.zip', note: 'Bronx' },
  'bus-brooklyn': { file: 'gtfs_b.zip', note: 'Brooklyn' },
  'bus-manhattan': { file: 'gtfs_m.zip', note: 'Manhattan' },
  'bus-queens': { file: 'gtfs_q.zip', note: 'Queens' },
  'bus-si': { file: 'gtfs_si.zip', note: 'Staten Island' },
  'bus-busco': { file: 'gtfs_busco.zip', note: 'MTA Bus Company' },
};

const CACHE = join(tmpdir(), 'mta-gtfs-static-cache');

function url(feed: string): string {
  const f = FEEDS[feed];
  if (!f) throw new Error(`unknown feed "${feed}". Known: ${Object.keys(FEEDS).join(', ')}`);
  return `${HOST}/${f.file}`;
}

/**
 * Last-Modified on these objects is reliable, so a HEAD is the cheap way to
 * decide whether a multi-minute re-import would actually change anything.
 */
async function listFeeds() {
  console.log('\nfeed             size        Last-Modified                    note');
  for (const [name, meta] of Object.entries(FEEDS)) {
    const res = await fetch(`${HOST}/${meta.file}`, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
    const len = Number(res.headers.get('content-length') ?? 0);
    const lm = res.headers.get('last-modified') ?? '?';
    const mb = len ? `${(len / 1e6).toFixed(1)} MB` : '?';
    console.log(`${name.padEnd(16)} ${mb.padEnd(11)} ${lm.padEnd(32)} ${meta.note}`);
  }
  console.log();
}

async function download(feed: string, noCache: boolean): Promise<Uint8Array> {
  if (!FEEDS[feed]) throw new Error(`unknown feed "${feed}". Known: ${Object.keys(FEEDS).join(', ')}`);
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, FEEDS[feed].file);
  if (!noCache && existsSync(path)) {
    process.stderr.write(`(using cached ${path}; --no-cache to refetch)\n`);
    return new Uint8Array(readFileSync(path));
  }
  process.stderr.write(`downloading ${url(feed)} ...\n`);
  const res = await fetch(url(feed), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url(feed)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path, buf);
  process.stderr.write(`cached ${buf.length} bytes at ${path}\n`);
  return buf;
}

/** Decompress only what was asked for -- subway stop_times.txt alone is ~145 MB. */
function extract(zip: Uint8Array, want: string | null): Record<string, Uint8Array> {
  const sizes: Record<string, { size: number; originalSize: number }> = {};
  const files = unzipSync(zip, {
    filter: (f) => {
      sizes[f.name] = { size: f.size, originalSize: f.originalSize };
      return want !== null && f.name === want;
    },
  });
  (files as Record<string, unknown>).__sizes = sizes as unknown as Uint8Array;
  return files;
}

function listFiles(zip: Uint8Array) {
  const files = extract(zip, null);
  const sizes = files.__sizes as unknown as Record<string, { size: number; originalSize: number }>;
  console.log('\nfile                     uncompressed');
  for (const [name, s] of Object.entries(sizes)) {
    console.log(`${name.padEnd(24)} ${(s.originalSize / 1e6).toFixed(2)} MB`);
  }
  console.log();
}

function text(zip: Uint8Array, name: string): string {
  const files = extract(zip, name);
  const bytes = files[name];
  if (!bytes) {
    const sizes = files.__sizes as unknown as Record<string, unknown>;
    throw new Error(`${name} is not in this ZIP. Present: ${Object.keys(sizes).filter((k) => k !== '__sizes').join(', ')}`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A real CSV parse (quote-aware). Splitting on commas produces IDs with literal
 * quote characters on LIRR, which then fail every lookup silently.
 */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function head(zip: Uint8Array, name: string, n: number) {
  const lines = text(zip, name).split(/\r?\n/).slice(0, n + 1);
  console.log(`\n--- ${name} (raw, first ${n} data rows) ---`);
  for (const l of lines) console.log(l);
  console.log();
}

function columns(zip: Uint8Array, name: string) {
  const body = text(zip, name);
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = parseLine(lines[0]);
  const total = lines.length - 1;
  const filled = new Array(headers.length).fill(0);
  const samples: string[] = new Array(headers.length).fill('');
  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i]);
    for (let c = 0; c < headers.length; c++) {
      if (row[c] !== undefined && row[c] !== '') {
        filled[c]++;
        if (!samples[c]) samples[c] = row[c];
      }
    }
  }
  console.log(`\n--- ${name}: ${total} data rows, ${headers.length} columns ---`);
  const w = Math.max(...headers.map((h) => h.length));
  for (let c = 0; c < headers.length; c++) {
    const pct = total ? (filled[c] / total) * 100 : 0;
    // A column filled on a handful of rows is a different fact from one that is
    // never filled, and rounding a percentage hides that -- so print the count.
    const shown = filled[c] === 0 || pct >= 1 ? `${Math.round(pct)}%` : '<1%';
    const flag = filled[c] === 0 ? '  <- ALWAYS EMPTY' : '';
    const count = `${filled[c]}/${total}`;
    console.log(
      `  ${headers[c].padEnd(w)}  ${shown.padStart(4)} filled ${count.padStart(13)}   e.g. ${samples[c].slice(0, 40)}${flag}`,
    );
  }
  console.log();
}

function grep(zip: Uint8Array, name: string, pattern: string, n: number) {
  const re = new RegExp(pattern);
  const lines = text(zip, name).split(/\r?\n/);
  const header = lines[0];
  console.log(`\n--- ${name} matching /${pattern}/ ---`);
  console.log(header);
  let count = 0;
  for (let i = 1; i < lines.length && count < n; i++) {
    if (re.test(lines[i])) { console.log(lines[i]); count++; }
  }
  console.log(`(${count} shown)\n`);
}

// --- main ----------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => argv[argv.indexOf(f) + 1];
const n = Number(val('-n')) || (has('--grep') ? 10 : 5);

if (argv.length === 0 || has('--help') || has('-h')) {
  console.log(
    [
      'Usage: bun static-probe.ts --list',
      '       bun static-probe.ts <feed> --files',
      '       bun static-probe.ts <feed> --head <file.txt> [-n 5]',
      '       bun static-probe.ts <feed> --columns <file.txt>',
      '       bun static-probe.ts <feed> --grep <file.txt> <regex> [-n 10]',
      '',
      'Feeds:',
      ...Object.entries(FEEDS).map(([k, v]) => `  ${k.padEnd(16)} ${v.file.padEnd(24)} ${v.note}`),
    ].join('\n'),
  );
  process.exit(0);
}

// A missing file or unknown feed is a normal outcome here (the feeds disagree about
// which optional files exist), so report it as a message rather than a stack trace.
process.on('uncaughtException', (err: Error) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});

if (has('--list')) {
  await listFeeds();
  process.exit(0);
}

const feed = argv[0];
const zip = await download(feed, has('--no-cache'));

if (has('--files')) listFiles(zip);
else if (has('--head')) head(zip, val('--head'), n);
else if (has('--columns')) columns(zip, val('--columns'));
else if (has('--grep')) grep(zip, val('--grep'), argv[argv.indexOf('--grep') + 2], n);
else listFiles(zip);
