# MTA static GTFS

Observations dated **2026-08-16**, made with `scripts/static-probe.ts` against the
published ZIPs. Row counts and timestamps drift — re-probe rather than trusting them for
anything load-bearing.

Contents: [catalog](#feed-catalog) · [regular vs supplemented](#regular-vs-supplemented-subway) ·
[what's in each ZIP](#whats-in-each-zip) · [CSV conventions](#per-feed-csv-conventions) ·
[MTA extension columns](#mta-extension-columns) · [transfers](#transferstxt) ·
[calendars and service days](#service-days-calendars-and-time)

## Feed catalog

Plain S3, unauthenticated `GET`, no headers required:

```
https://rrgtfsfeeds.s3.amazonaws.com/{file}
```

| Feed | File | Observed size | Observed `Last-Modified` |
|---|---|---:|---|
| Subway — supplemented | `gtfs_supplemented.zip` | 19.2 MB | 2026-08-16 20:24 (12 min before fetch) |
| Subway — regular | `gtfs_subway.zip` | 5.6 MB | 2026-08-07 |
| LIRR | `gtfslirr.zip` | 1.9 MB | 2026-08-14 |
| Metro-North | `gtfsmnr.zip` | 3.7 MB | 2026-08-14 |
| Bus | `gtfs_bx.zip`, `gtfs_b.zip`, `gtfs_m.zip`, `gtfs_q.zip`, `gtfs_si.zip`, `gtfs_busco.zip` | — | — |

`Last-Modified` is reliable and cheap to poll with `HEAD` (`static-probe.ts --list`) —
the practical way to decide whether a multi-minute re-import would change anything.

## Regular vs supplemented subway

Two subway schedule feeds, not interchangeable:

- **Regular** (`gtfs_subway.zip`) — the base timetable, republished a few times a year. A
  `Last-Modified` weeks or months old is normal, not a fault.
- **Supplemented** (`gtfs_supplemented.zip`) — the base timetable *plus* planned service
  changes for roughly the next week, rebuilt on the order of once an hour. Its
  `stop_times.txt` is ~4× the regular feed's because diversions and weekend GO (General
  Order) work multiply the trip variants.

Anything comparing scheduled service against realtime needs the supplemented feed;
weekend work means the regular feed routinely describes trains that will not run. The
price is that a build goes out of date within hours, and — because the supplemented
feed's schedule-version prefix rotates — a stale build breaks the subway realtime→static
trip join outright rather than degrading (see `identifiers.md`).

There is no supplemented equivalent for LIRR or MNR; their single feeds are republished
frequently and already carry near-term changes.

## What's in each ZIP

The three feeds do not agree on which optional files exist (`static-probe.ts <feed> --files`):

| File | Subway | LIRR | MNR |
|---|:--:|:--:|:--:|
| `agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt` | ✅ | ✅ | ✅ |
| `calendar.txt` | ✅ | ❌ | ❌ |
| `calendar_dates.txt` | ✅ | ✅ | ✅ |
| `shapes.txt`, `transfers.txt` | ✅ | ✅ | ✅ |
| `feed_info.txt` | ✅ | ✅ | ❌ |
| `notes.txt` (non-standard) | ❌ | ❌ | ✅ |

Two consequences worth designing for:

- **No `calendar.txt` for LIRR or MNR.** Both express *all* service through
  `calendar_dates.txt` with `exception_type=1` rows — one row per service ID per operating
  date. A parser that requires `calendar.txt` fails on two feeds out of three.
- **No `feed_info.txt` for MNR**, so there is no publisher-declared `feed_version` for
  that feed; the ZIP's `Last-Modified` is the only version signal.

Uncompressed sizes, observed:

| | subway (supplemented) | LIRR | MNR |
|---|---:|---:|---:|
| `stop_times.txt` | 133.6 MB | 1.5 MB | 22.0 MB |
| `trips.txt` | 5.4 MB | 0.18 MB | 2.1 MB |
| `shapes.txt` | 5.0 MB | 6.6 MB | 1.9 MB |
| rows in `trips.txt` | 78,130 | 2,420 | 28,511 |
| rows in `stop_times.txt` | ~2.4 M | 26,222 | 379,604 |

`shapes.txt` is the largest optional file and is not needed for arrival-time work — on
LIRR it is *four times* `stop_times.txt`. Filtering it out at unzip time is a real memory
win when the unzip is in-process. Subway `stop_times` is the only part of the pipeline
where technique matters: ~2.4M rows means streaming the CSV row by row into batched
transactions, not materializing a parsed array, and not row-at-a-time inserts outside a
transaction.

## Per-feed CSV conventions

**LIRR quotes everything** — every header and every value, always:

```csv
"stop_id","stop_code","stop_name","stop_lat","stop_lon","stop_url","wheelchair_boarding"
"1","ABT","Albertson","40.77206317","-73.64169095","https://new.mta.info/mta-stations/albertson","1"
```

Subway and MNR are unquoted except where a value contains a comma (subway `route_desc`
frequently does). A real CSV parser handles both; `split(',')` handles neither, and
fails *silently* — you get IDs containing literal `"` characters that then miss every
lookup.

**LIRR's `feed_info.txt` declares `"America/New York"`** — a space, not the valid IANA
`America/New_York`. Feeding that to a timezone library throws. MNR's `agency.txt`
declares the correct `America/New_York`. All three feeds are Eastern regardless, so
treating the declared value as decorative is safer than trusting it.

**Column sets differ substantially.** Verify with `static-probe.ts <feed> --columns <file>`,
which reports fill rate per column so you can see which columns exist but are empty:

| | subway | LIRR | MNR |
|---|---|---|---|
| `routes.txt` | 10 columns, all populated | 5 columns — **no `agency_id`, no `route_short_name`** | 9 columns, but `route_short_name`, `route_desc`, `route_url` **empty on every row** |
| `stops.txt` | 6 columns only — no `stop_code`, no `wheelchair_boarding` | has `stop_code`, `wheelchair_boarding`; no `location_type` column | has `stop_code`, `location_type`, `parent_station` (always empty), `zone_id` (empty) |
| `trips.txt` | 6 columns; `shape_id` 82% filled | 8 columns incl. `trip_short_name`, `peak_offpeak` | 10 columns; `block_id` empty on every row |
| `stop_times.txt` | 5 columns | 7 columns | 9 columns incl. `track`, `note_id` |

Any schema spanning all three needs those columns nullable, and any "this column is
missing → the feed is broken" check needs to be per-feed.

**"Blank" arrives as two different values, and `??` only catches one.** A column the feed
omits entirely imports as `NULL`; a column it ships empty imports as `''`. `routes.txt`
does both for the same field — LIRR has no `route_short_name` column at all (13/13 rows
`NULL`) while MNR has one that is empty on every row (6/6 rows `''`):

```csv
route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,...
3,1,,New Haven,,2,,EE0034,FFFFFF
```

So `short_name ?? long_name` names LIRR's routes correctly and names every MNR route
`""`, because `??` falls through `null` but not `''`. Use `||`, or normalize empty
strings to `NULL` at import. The same trap applies to any MNR column the table above
marks "empty on every row", and to `parent_station` and `zone_id` in its `stops.txt`.
Verified against `gtfsmnr.zip` 2026-08-18.

**Subway platform rows leave `location_type` blank** rather than writing the explicit `0`
the spec permits:

```csv
stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
101,Van Cortlandt Park-242 St,40.889248,-73.898583,1,
101N,Van Cortlandt Park-242 St,40.889248,-73.898583,,101
101S,Van Cortlandt Park-242 St,40.889248,-73.898583,,101
```

Legal — empty means `0` — but easy to mishandle, since `parseInt('')` is `NaN`, not `0`.
MNR by contrast writes `0` explicitly.

## MTA extension columns

Columns that are **not** in the GTFS spec and will not be in a generic parser's model:

| Column | Where | Meaning |
|---|---|---|
| `peak_offpeak` | LIRR + MNR `trips.txt` | `1` = peak, `0` = off-peak |
| `track` | MNR `stop_times.txt` | scheduled track at that stop |
| `note_id` | MNR `stop_times.txt` (9% filled) | joins `notes.txt` |
| `notes.txt` | MNR only | `note_id,note_mark,note_title,note_desc` — footnotes like "Train may depart 5 minutes earlier than the time shown" |

`peak_offpeak` deserves care because it **drives fare** — peak costs materially more on
both railroads, so reversing it misinforms riders about price rather than mislabeling a
display field. Polarity `1` = peak is settled empirically: the `=1` trips cluster in AM
(06–10) and PM (16–20) rush windows far more heavily than the `=0` trips, on both
railroads. Two residual patterns are expected rather than dirty data:

- Weekend and holiday variants run at rush-hour clock times without peak fare, so an
  08:00 departure with `peak_offpeak=0` is not an error.
- Peak is *directional* — a reverse-peak 08:00 train is legitimately off-peak.

LIRR and MNR also flag very different proportions of trips as peak, which reflects
different railroad policy, not a bug. **Pass the railroad's designation through as-is and
never derive or reconcile it from departure time** — the two patterns above are exactly
what would tempt you into that.

## `transfers.txt`

All three feeds ship it, and it is a different document in each.

**Subway — a station-adjacency graph keyed on parent stations.** 613 rows, 4 columns
(`from_stop_id,to_stop_id,transfer_type,min_transfer_time`), every row `transfer_type=2`,
`min_transfer_time` always populated. Every stop ID is a `location_type=1` parent, never
a platform. The rows split into self-loops (`101→101`, the in-station walk between
platforms at one complex) and cross-complex pairs — physically adjacent but
administratively separate stations, e.g. `R20` (14 St-Union Sq N/Q/R/W) → `L03`
(14 St-Union Sq L) at 180s. Those pairs matter and are easy to miss: **a query that only
checks "same parent station" finds none of them**, because nothing in the ID space
suggests the relationship. `transfers.txt` is the only source for it.

**LIRR and MNR — a curated list of guaranteed connections, not a connectivity graph.**
Rows are `from_trip_id`/`to_trip_id` pairs at the same `stop_id` with `transfer_type=1`
("timed transfer: the departing vehicle waits") — a specific train guaranteeing a
specific train. Observed: LIRR 537 rows over ~7 stations, MNR ~13,700 rows over ~13
stations. `min_transfer_time` is empty on effectively every row (LIRR: 1 of 537), because
the guarantee itself is the mechanism rather than a buffer duration. MNR carries
`from_route_id`/`to_route_id` columns that are empty on every row; subway has no such
columns at all, so don't branch on them.

**The trap: absence of a row means "unenumerated", not "impossible".** Changing trains at
LIRR Penn Station or Woodside produces zero rows despite being two of the busiest
interchanges on the railroad. Treat the table as authoritative for the rows it *does*
have (a trip-pair guarantee, not a same-platform inference) and never as exhaustive.
Building general connectivity for LIRR/MNR means searching `stop_times` for feasible
same-stop connections and using `transfers.txt` only to flag the subset that is
contractually protected — it can label a result but cannot enumerate the search space.

## Service days, calendars, and time

**Times exceed 24:00:00.** A 1:30 AM train on Monday's service day is `25:30:00` on
Monday, not `01:30:00` on Tuesday. Observed maxima: subway `28:02:00`, MNR `26:01:00`,
LIRR `25:21:00`. `Date` parsing rejects these outright and string comparison against a
wall clock silently misorders them.

**Before roughly 5 AM local, what is running belongs to yesterday's service date.**
Querying only today's date returns nothing for the early-morning hours. Note that "what
is running right now" and "what runs between these two stations" need *different* date
windows: the first wants today plus yesterday when it's early; the second wants a rolling
yesterday/today/tomorrow window, because a query made at 11 PM still has to see
tomorrow's early trips.

**Converting `service_id` + `HH:MM:SS` to an absolute instant** by adding seconds to local
midnight is wrong on the two DST transition dates each year, off by an hour in a direction
that depends on the transition. Anchor on **local noon minus 12 hours** instead: noon is
never ambiguous (US transitions happen ~2 AM), so resolving noon and subtracting a fixed
43,200 s is correct everywhere — including a `25:30:00` departure on the spring-forward
date, which must resolve to `01:30` the next day rather than `02:30`, precisely because
that date has only 23 real hours.

**All times are `America/New_York`.** Computing the service date from a UTC clock puts the
rollover in the wrong place for five hours a day.

**Resolving whether a `service_id` runs on a date** requires both tables:

- a `calendar_dates` row with `exception_type=1` for that date → active, regardless of
  `calendar`;
- otherwise the weekday column in `calendar` is `1`, the date is within
  `start_date`..`end_date`, **and** no `calendar_dates` row with `exception_type=2`
  removes it.

Only the first clause ever applies to LIRR and MNR. The subway supplemented feed uses the
second heavily — `exception_type=2` rows strip base service on specific dates as GO work
is layered in. Service ID formats differ per feed and change between builds (subway:
`Saturday`, `Saturday_C1`; LIRR: `7C7FAC27`; MNR: `246125424612546`), so parse them as
opaque strings — never pattern-match a weekday out of them.
