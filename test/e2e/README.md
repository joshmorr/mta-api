# Hurl HTTP tests

Black-box tests that hit the **real running server** over HTTP, complementing
the in-process `bun:test` suite (which uses `app.request()` against `:memory:`).
They cover the boundary bun:test can't: the live socket, the inline middleware
in `src/index.ts` (`onError`, `notFound`), and response headers.

Hurl is a separate binary — install it first:
<https://hurl.dev/docs/installation.html> (e.g. `brew install hurl`,
`cargo install hurl`, or your distro package). It is intentionally **not** a
`package.json` dependency.

## Run

```sh
bun run test:hurl        # contract + stops suites (default dev DB)
bun run test:hurl:all    # + realtime smoke (hits live MTA feeds)
```

Or drive the runner directly:

```sh
sh scripts/hurl.sh test/e2e/contract.hurl                 # one suite
DB_PATH=:memory: sh scripts/hurl.sh test/e2e/contract.hurl test/e2e/stops.hurl
```

The runner (`scripts/hurl.sh`) boots the server, waits for readiness, runs the
suites in `--test` mode, then tears the server down. The server no longer
auto-seeds on boot, so `DB_PATH` must point at an already-seeded DB (run
`bun run seed` once, or use the default `./data/mta.db` if you've seeded it
before) — an empty DB makes the server exit immediately.

### Against a deployed instance

Set `BASE_URL` to run any suite(s) against an already-running server instead of
booting one locally. The runner skips the local boot (and ignores `DB_PATH` /
`PORT`), pointing `{{base}}` at the remote host:

```sh
BASE_URL=https://mta-api-restless-pond-4321.fly.dev \
  sh scripts/hurl.sh test/e2e/contract.hurl test/e2e/stops.hurl test/e2e/realtime.hurl
```

## Suites (tiers by determinism)

| File | Tier | Needs | Notes |
|---|---|---|---|
| `contract.hurl` | 1 | seeded+ready server | validation 400s, 404s, `{error,code}` envelope, rate-limit / Server-Timing headers, `/doc`. Independent of *which* data is seeded. |
| `stops.hurl` | 2 | seeded data | stop/route shape + stable GTFS IDs (e.g. subway `127` = Times Sq–42 St). Shows capture→chain. |
| `realtime.hurl` | 3 | live MTA feeds | arrivals/vehicles. Non-deterministic — asserts loosely (status range + JSON). Keep out of required CI. |

## CI

Run tiers 1–2 as a required job against a seeded DB (cache a pre-seeded
`data/mta.db` between runs — a cold seed is too slow per-run). Run tier 3 as a
separate allowed-to-fail job. `hurl --report-junit` emits CI-friendly output.
