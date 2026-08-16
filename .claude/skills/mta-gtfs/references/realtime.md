# MTA GTFS-Realtime

Everything below marked *observed* was measured with `scripts/rt-probe.ts` against the
live feeds on **2026-08-16**. Counts drift; structure and failure modes are stable.
Re-probe before designing against a coverage number.

Contents: [gateway](#the-gateway) · [feed catalog](#feed-catalog) ·
[what each feed populates](#what-each-feed-actually-populates) ·
[per-feed notes](#per-feed-notes) · [alerts](#service-alerts) ·
[vendor extensions](#vendor-proto-extensions) · [caching](#caching-and-cadence)

## The gateway

```
https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/{percent-encoded feed path}
```

No API key, no headers, no auth of any kind. Three behaviors to code around:

| Request | Result |
|---|---|
| `.../mtagtfsfeeds/nyct/gtfs-l` (literal slash) | **403** `{"message":"Missing Authentication Token"}` |
| `.../mtagtfsfeeds/nyct%2Fgtfs-l` | 200, protobuf, `Content-Type: text/plain` |
| `.../mtagtfsfeeds/nyct%2Fgtfs-bogus` | **200**, `application/xml`, S3 `<Error><Code>NoSuchKey</Code>` |

The 403 is API Gateway's generic "no route matched" — it is not an auth problem, and
chasing it as one is the single most common integration dead end. The 200-with-XML case
means `response.ok` never establishes that you are holding protobuf; a cheap guard is
rejecting a body whose first byte is `<` (`0x3c`) before handing it to the decoder.

Response headers carry **no `Cache-Control`, `ETag`, `Last-Modified`, `Age`, or
`Expires`** — only `content-type`, `date`, and CORS. Conditional requests are therefore
impossible and there is nothing to revalidate against, so TTL caching is the only
option and the TTL has to come from measured publish cadence rather than from anything
upstream advertises.

## Feed catalog

**Subway** — one feed per line group; a transfer hub spans several. Times Sq–42 St
alone needs `nyct/gtfs`, `nyct/gtfs-ace`, `nyct/gtfs-bdfm`, and `nyct/gtfs-nqrw`.

| Path | Lines |
|---|---|
| `nyct/gtfs` | 1 2 3 4 5 6 6X 7 7X GS |
| `nyct/gtfs-ace` | A C E, H (Rockaway Park Shuttle), FS (Franklin Av Shuttle) |
| `nyct/gtfs-bdfm` | B D F FX M |
| `nyct/gtfs-g` | G |
| `nyct/gtfs-jz` | J Z |
| `nyct/gtfs-l` | L |
| `nyct/gtfs-nqrw` | N Q R W |
| `nyct/gtfs-si` | SI (Staten Island Railway) |

**Commuter rail** — one feed each, all branches: `lirr/gtfs-lirr`, `mnr/gtfs-mnr`.

**Alerts** — a separate vendor pipeline (hence `camsys/`), and the only place alerts
appear; the trip feeds never carry `Alert` entities. Observed sizes:

| Path | Observed bytes |
|---|---:|
| `camsys/all-alerts` | 738,539 |
| `camsys/subway-alerts` | 502,586 |
| `camsys/bus-alerts` | 202,036 |
| `camsys/lirr-alerts` | 22,795 |
| `camsys/mnr-alerts` | 12,208 |

`all-alerts` is by far the largest response the MTA serves here and the slowest to
change, so it is where scoping to a mode-specific path pays off most — 60× smaller for
MNR-only work.

## What each feed actually populates

Own-property presence per feed, one fetch each, 2026-08-16 (`rt-probe.ts <path>`).
Percentages are of the relevant parent objects: trip fields over `TripUpdate`s,
`stop_time_update` fields over all stop time updates, `vehicle.*` over `VehiclePosition`s.

| Feed | ver | ents | TU | VP | start_time | direction_id | sched_rel | stop_seq | delay | uncert | position | cur_status | stop_id | label | TU+VP packed |
|---|---|---:|---:|---:|---|---|---|---|---|---|---|---|---|---|---:|
| `nyct/gtfs` | 1.0 | 270 | 167 | 102 | – | – | – | – | – | – | – | 65% | 100% | – | 0 |
| `nyct/gtfs-ace` | 1.0 | 146 | 73 | 73 | 100% | – | – | – | – | – | – | 51% | 100% | – | 0 |
| `nyct/gtfs-bdfm` | 1.0 | 176 | 88 | 88 | 100% | – | – | – | – | – | – | 50% | 100% | – | 0 |
| `nyct/gtfs-g` | 1.0 | 62 | 31 | 31 | 100% | – | – | – | – | – | – | 32% | 100% | – | 0 |
| `nyct/gtfs-jz` | 1.0 | 26 | 13 | 13 | 100% | – | – | – | – | – | – | 23% | 100% | – | 0 |
| **`nyct/gtfs-l`** | 1.0 | 56 | 34 | 22 | – | **100%** | **100%** | **100%** | **97%** | **97%** | – | 100% | 100% | – | 0 |
| `nyct/gtfs-nqrw` | 1.0 | 152 | 76 | 76 | 100% | – | – | – | – | – | – | 50% | 100% | – | 0 |
| `nyct/gtfs-si` | 1.0 | 16 | 8 | 8 | 100% | – | – | – | – | – | – | 50% | 100% | – | 0 |
| `lirr/gtfs-lirr` | 2.0 | 192 | 127 | 65 | – | 100% | 100% | 100% | 87% | – | **100%** | 100% | 100% | 100% | 0 |
| `mnr/gtfs-mnr` | 1 | 201 | 201 | 201 | 100% | – | – | – | 7% | – | 21% | 21% | 19% | 100% | **201** |

Read across it and four things fall out:

**The L is a different producer from the rest of the subway.** It is the only NYCT feed
with `stop_sequence`, `arrival.delay`, `uncertainty`, `schedule_relationship`, or
`direction_id` — and the only one *without* `start_time`. Any statement of the form "the
subway feed has X" that was checked on the L is probably false for the other seven.
(`nyct/gtfs`, the numbered lines, is a third profile again: no `start_time` either.)

**Three `gtfs_realtime_version` strings from one agency** — `1.0`, `2.0`, and `1`. None
is worth branching on; treat it as informational.

**Entity packing differs.** Subway and LIRR emit `TripUpdate` and `VehiclePosition` as
separate entities; MNR packs both into one (201 entities, 201 of each). Code that counts
trains by counting entities gets a different answer per feed, and code that resolves a
trip's vehicle through a cross-entity index finds nothing on MNR.

**Coordinates are not uniform.** LIRR publishes real lat/lon on every vehicle; MNR on
~21%; no subway feed publishes any. Subway position is only expressible as
`current_status` relative to `stop_id` (`INCOMING_AT`/`STOPPED_AT`/`IN_TRANSIT_TO`) —
enough for "arriving", not enough for a map dot.

## Per-feed notes

### Subway (`nyct/*`)

- Stop IDs in RT are **platform** IDs with an `N`/`S` suffix (`L05N`, `L28S`), never
  parent stations. See `identifiers.md`.
- `direction_id` is absent on seven of eight feeds. On the L it is *explicitly written*
  on the wire and **always `0`** — observed `0` for all 34 trips including 18 whose trip
  IDs end `..S`. It is wrong data rather than missing data, so a presence check does not
  save you: never derive subway direction from it.
- `vehicle.vehicle.{id,label}` is never populated, so there is no train identifier in the
  standard fields; the NYCT extension's `train_id` is the only one.
- `current_status` is present on a minority of entities on every subway feed except the L
  (23–65% observed). Report the absence rather than defaulting it — the proto2 zero value
  is `INCOMING_AT`, so defaulting invents a specific, wrong claim.

### LIRR (`lirr/gtfs-lirr`)

- The most complete feed of the three: coordinates, train numbers, `stop_sequence`,
  `delay`, and a meaningful `direction_id` (observed 63× `0` / 64× `1`).
- `direction_id` appears on `TripUpdate.trip` but **not** on `VehiclePosition.trip`
  (0/65) — same feed, same trip, different descriptor.
- Vehicle entities are keyed `"<trip_id>_V"` (`GO201_26_7713_V`), and
  `vehicle.vehicle.id` is `"<label>_<trip suffix>"` (`7765_7713`) while
  `vehicle.vehicle.label` is the train number (`7765`).
- No `uncertainty` on any stop time update.

### Metro-North (`mnr/gtfs-mnr`)

- Sparsest feed. No `stop_sequence` at all, no `schedule_relationship`, no
  `direction_id`; `arrival.delay` on 7% of stop time updates.
- `VehiclePosition` is mostly a heartbeat: `trip`, `timestamp`, and `vehicle.label`
  always; `position` 21%, `current_status` 21%, `stop_id` 19%. Any "where is this train"
  feature degrades to "this train exists and reported at time T" ~80% of the time.
- Observed `current_status` values include `0` (`INCOMING_AT`) on 11 entities — a live
  example of why presence, not truthiness, is the only correct test.
- The trip descriptors inside a single entity disagree; see `identifiers.md`.

## Service alerts

Ordinary GTFS-RT `Alert` entities with MTA conventions layered on. Observed on
`camsys/all-alerts`: 367 alerts, 2,282 informed entities (~6.2 each).

**`cause` and `effect` are never set** — 0 of 367. This is the most consequential alert
quirk, because `effect` is the field most consumers reach for first. What kind of alert
it is lives in two other places:

1. **The entity ID.** MTA appends a *status rank* to unplanned alert IDs:
   `lmm:alert:<id>:<rank>`, where rank runs 1 (lowest priority) to 35 (highest) over a
   35-status list shared across all four agencies — e.g. 26 = Delays, 27 = Cancellations,
   31 = Detour, 35 = Suspended. Observed: `lmm:alert:263406:31`. Planned work uses
   `lmm:planned_work:<id>` with **no** rank suffix (361 of 367 entities observed were
   planned work, and only 6 carried a rank). The full rank table is MTA's, at
   <https://github.com/nymta/gtfs-documentation/blob/main/feeds/service_changes.md>.
2. **The Mercury extension** (field 1001), which carries `alert_type` as text plus
   created/updated timestamps — 141 KB of the 738 KB response, all discarded by the stock
   proto.

Other conventions, all observed:

- **`informed_entity` is one entry per affected thing**, not an aggregate: `agency_id`
  and `route_id` on every entry (2,282/2,282), `stop_id` on 90%, `direction_id` on 45%,
  `trip` and `route_type` never. Evaluate each entry independently rather than inferring
  route-wide impact from a route-scoped entry sitting next to stop-scoped ones.
- **`agency_id` is the mode discriminator**: `MTASBWY` (2,024), `MTA NYCT` (149, bus),
  `MTABC` (49), `LI` (31), `MNR` (29).
- **`direction_id` in an alert means `0` = Northbound, `1` = Southbound**, and its
  absence on an entry that has a `stop_id` means both directions — per MTA's spec at
  <https://github.com/nymta/gtfs-documentation/blob/main/feeds/subway/gtfs-rt/stations_affected.md>.
  This is *not* the same signal as a trip's `direction_id`.
- **Station-level detail is optional**; MTA documents it as provided "where station-level
  impact detail is available". A missing `stop_id` does not mean no station is affected.
- **Text comes in two translations, `en` and `en-html`** — both present on every alert
  observed, the second being the same text wrapped in markup. Selecting `language === 'en'`
  is correct; taking `translation[0]`, or matching `startsWith('en')`, can hand HTML to a
  plain-text consumer. Untagged translations are permitted by the spec and worth tolerating
  as a fallback even though none appear today.
- **`active_period` is near-universal** (366/367, with `start` on 366 and `end` on 362),
  and alerts are published days before they take effect. Filtering by now against
  `active_period` is what separates "in effect" from "on the books"; an absent `end`
  means indefinite, an absent `start` means already active.

## Vendor proto extensions

The MTA hangs agency data on extension field numbers, all invisible to the stock
`gtfs-realtime.proto`. Verify with `rt-probe.ts <path> --extensions`, which walks the raw
wire bytes and reports field numbers ≥ 1000 by their position in the message tree:

| Feed | Field | Where it appears (observed) | Proto |
|---|---|---|---|
| `nyct/*` | 1001 | `trip_update.trip`, `trip_update.stop_time_update`, `vehicle.trip` | `gtfs-realtime-NYCT.proto` |
| `lirr/*`, `mnr/*` | 1005 | `trip_update.stop_time_update`, occasionally `vehicle` | `gtfs-realtime-MTARR.proto` |
| `camsys/*` | 1001 | `alert` | `gtfs-realtime-service-status.proto` (Mercury) |

Definitions live in
[OneBusAway's `onebusaway-gtfs-realtime-api`](https://github.com/OneBusAway/onebusaway-gtfs-realtime-api/tree/master/src/main/proto/com/google/transit/realtime).
What they add:

- **NYCT** (`NyctTripDescriptor`, `NyctStopTimeUpdate`) — `train_id` (e.g.
  `06 0123+ PEL/BBR`), `is_assigned` (whether a physical train is assigned to the trip,
  i.e. whether the prediction is real or purely scheduled), a `direction` enum
  (`NORTH`/`SOUTH`/`EAST`/`WEST`), and `scheduled_track`/`actual_track`.
- **MTARR** — track assignment and train status text for LIRR/MNR.
- **Mercury** — `alert_type`, human-readable created/updated timestamps, and
  screen-formatted alert text variants.

Ignoring them is a legitimate choice. The two things it costs are `is_assigned`, the only
clean way to tell a real prediction from a schedule-derived one, and the NYCT `direction`
enum, the only *documented* direction signal in the subway RT feed.

## Caching and cadence

Publish cadence is per-feed and varies by orders of magnitude — roughly 3 s for the
numbered lines up to minutes for `camsys/all-alerts`. Consequences:

- A single global TTL is simultaneously stale for the fast feeds and wasteful for alerts.
  Scope the alerts TTL separately from the vehicle feeds.
- **Measuring cadence yourself aliases badly.** Polling on a fixed interval that shares a
  factor with a feed's period reports a falsely uniform cadence — a 5 s poll against ACE
  yields a flawless and entirely wrong `15,15,15,…`. Feed timestamps are whole seconds,
  so 1 s is the ground-truth sampling rate, and the NYCT feeds sit on a shared 15 s
  epoch-aligned cycle emitting differing numbers of updates per cycle, which means a mean
  interval can be a value the feed never actually exhibits.
- Deduplicate concurrent fetches for the same path, and prefer serving a stale decode with
  an explicit staleness marker over a 5xx when upstream fails — subject to the one-minute
  lag disclosure in MTA's terms.
- Always set a request timeout. Both MTA hosts can hang rather than fail.
