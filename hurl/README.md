# Hurl HTTP tests

Black-box tests that hit the **real running server** over HTTP, complementing
the in-process `bun:test` suite (which uses `app.request()` against `:memory:`).
They cover the boundary bun:test can't: the live socket, the inline middleware
in `src/index.ts` (seeding gate, `onError`, `notFound`), and response headers.

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
sh scripts/hurl.sh hurl/contract.hurl                 # one suite
DB_PATH=:memory: sh scripts/hurl.sh hurl/contract.hurl hurl/stops.hurl
```

The runner (`scripts/hurl.sh`) boots the server, waits for the seeding gate to
lift (see below), runs the suites in `--test` mode, then tears the server down.

### Against a deployed instance

Set `BASE_URL` to run any suite(s) against an already-running server instead of
booting one locally. The runner skips the local boot (and ignores `DB_PATH` /
`PORT`), pointing `{{base}}` at the remote host:

```sh
BASE_URL=https://mta-api-restless-pond-4321.fly.dev \
  sh scripts/hurl.sh hurl/contract.hurl hurl/stops.hurl hurl/realtime.hurl
```

## The seeding gate matters

On startup with an empty DB the server seeds all feeds in the background. Until
that finishes, every data route returns `503 SEEDING`, and `/health` — exempt
from that gate so it stays reachable — returns `503 {status:"seeding"}` too,
flipping to `200 {status:"ok"}` only once seeding completes. So `/health` is the
readiness signal: `_wait_ready.hurl` probes it and the runner retries for up to
~4 min to cover a cold seed. With an already-seeded `./data/mta.db` it's ready
immediately.

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
