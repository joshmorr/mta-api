# Identifiers: resolving, joining, and direction

The cross-cutting file. Observations dated **2026-08-16**. If a lookup returns empty and
the data "obviously" exists, the cause is almost always on this page.

## IDs are unique only within a feed

The MTA reuses raw GTFS IDs across subway, LIRR, and MNR. This is the most consequential
structural fact about the data:

- **104 `stop_id` values exist in more than one feed** — `101`, `111`, `114`, `118`,
  `120`, `124`, `127`… each in all three.
- **`route_id` `1`–`6` exist in all three feeds**, `7` in two:

  | `route_id` | Subway | LIRR | MNR |
  |---|---|---|---|
  | `1` | Broadway–7 Av Local | Babylon Branch | Hudson |
  | `2` | 7 Av Express | Hempstead Branch | Harlem |
  | `3` | 7 Av Express | Oyster Bay Branch | New Haven |
  | `4` | Lexington Av Express | Ronkonkoma Branch | New Canaan |
  | `5` | Lexington Av Express | Montauk Branch | Danbury |
  | `6` | Lexington Av Local | Long Beach Branch | Waterbury |
  | `7` | Flushing Local | Far Rockaway Branch | — |

- **`trip_id` does not currently collide** (0 observed) — a property of today's ID
  formats, not a guarantee.

So: any storage spanning feeds needs a feed discriminator in the key
(`PRIMARY KEY (feed_id, stop_id)`), and any interface taking an ID needs feed context
alongside it. `stop_id=1` alone is unanswerable — LIRR Albertson or MNR Grand Central?

## Subway stops are two-level; LIRR and MNR are flat

| | `location_type` | Example | `parent_station` |
|---|---|---|---|
| Parent station | `1` | `127` (Times Sq–42 St) | — |
| Platform | blank (means `0`) | `127N`, `127S` | `127` |

Observed: 496 parent stations, 992 platforms. Suffixes are `N` (northbound/uptown) and
`S` (southbound/downtown) — **railroad compass, not geographic**: the L runs "north"
toward Manhattan while travelling west.

**Realtime references platform IDs, never parent IDs.** A `stop_time_update` carries
`L28S`, not `L28`. Answering "next trains at Times Sq" means resolving `127` →
`{127N, 127S}` first and matching against the set; the inverse — a user supplying `127N`
— also has to work, so the resolver needs to detect whether an ID is already a platform.

Parent and platform rows **share the same `stop_name`**, so a name search without a
`location_type` filter returns each station three times.

LIRR and MNR have no hierarchy: every stop is a flat `location_type=0` with no
`parent_station` (127 LIRR stops, 114 MNR stops), and realtime `stop_id` values match
static ones directly with no resolution step. Both carry `stop_code`, a short alphabetic
code riders and timetables actually use (`ABT` = Albertson, `0NY` = Grand Central). It is
not the `stop_id` and never appears in realtime.

## Route IDs and route types

Subway route IDs are the line letter or number, plus some that never appear on a map:
`GS` (42 St Shuttle), `FS` (Franklin Av Shuttle), `H` (Rockaway Park Shuttle) — **all
three have `route_short_name = "S"`**, so short name is not a key. Express variants `6X`,
`7X`, and `FX` are separate route IDs.

**The Staten Island Railway (`SI`) lives in the subway feed but is `route_type=2` (Rail),
not `1` (Subway)** — its `route_short_name` is `SIR`, and it has its own realtime feed
path `nyct/gtfs-si`. Filtering the subway feed by `route_type=1` quietly drops it.

LIRR and MNR routes are branches (Babylon, Hudson, …), all `route_type=2`, and all map to
their feed's single realtime path regardless of route ID.

## Joining realtime to static: one clean case out of three

**LIRR — exact match.** RT `trip_id` appears verbatim in `trips.txt` (10/10 sampled).
The `GO201_26` prefix is the schedule version and also appears as `feed_version` in
`feed_info.txt`, so a realtime message can be checked against the static build it belongs
to. This is the only feed where that's possible.

**Subway — the RT ID is a *substring* of the static ID, not a suffix.** Observed:

```
RT:      097600_L..S
Static:  BSP26GEN-L027-Sunday-00_097600_L..S01R
         └─ schedule version + service ─┘       └ path ┘
```

The RT ID encodes the trip's origin departure time in **hundredths of a minute past
midnight**, plus route and direction (`L..S`). Verified against static `stop_times`:
`097600` → 976.00 minutes → **16:16:00**, which is exactly the matched trip's first
departure; `098000` → 16:20:00, likewise. The static ID both prefixes *and* suffixes the
RT ID, so an `endsWith` match fails just as an exact match does — use `contains`, and
expect it to be non-unique (2 static trips per RT ID observed, one per service variant),
so the service calendar still has to disambiguate.

Some RT trips match nothing at all, and the origin time says which: IDs landing on a
whole minute (`097600`) are scheduled trips, while off-grid ones (`097407` → 16:14.07,
`097902`) are added or re-originated trips with no static counterpart. Expect a
permanent unmatchable minority rather than treating it as breakage. **A stale static
build, on the other hand, breaks this join completely**, since the supplemented feed's
version prefix rotates — which is why "no subway arrivals" is usually a stale-DB symptom
rather than a feed outage.

**MNR — the RT trip ID joins to nothing, and the two descriptors inside one entity
disagree.** Observed:

```
entity.id                = "6341"      ← train number
trip_update.trip.trip_id = "3174374"   ← opaque realtime ID, absent from trips.txt
vehicle.trip.trip_id     = "6341"      ← train number again
vehicle.vehicle.label    = "6341"
```

200 of 201 entities showed this mismatch. So MNR's `VehiclePosition` is keyed by train
number while its `TripUpdate` is keyed by an unrelated ID, and indexing vehicles by trip
ID then looking up a `TripUpdate`'s trip ID against that index silently finds nothing —
a real trap, made worse by the fact that MNR is the one feed that packs both payloads
into the *same* entity. Resolve a trip's vehicle from **the same entity first**
(`entity.vehicle ?? vehicleByTripId.get(tripId)`); the cross-entity map is what LIRR and
subway need, and the same-entity check is what MNR needs.

The bridge to static, if you need one, is `trips.trip_short_name`, which carries the
train number — RT train numbers resolve to 5–6 static trips each (one per calendar
variant), so it identifies the *train*, not the trip, and the service calendar still
disambiguates.

## `direction_id` is four different signals

| Where | Meaning |
|---|---|
| Subway static `trips.txt` | `0` ≈ North, `1` ≈ South — agrees with the trip ID's `..N`/`..S` suffix on ~99% of rows |
| Subway realtime | Absent on 7 of 8 feeds; on `nyct/gtfs-l` explicitly written and **always `0`**, including for trips whose IDs end `..S` |
| LIRR realtime | Meaningful — `0` and `1` both present and varying, branch-relative |
| MNR realtime | Never set |
| Alerts `informed_entity` | `0` = Northbound, `1` = Southbound (MTA's Stations Affected spec) |

The subway case is worth being precise about: on the L it is not missing data that a
presence check will catch, it is *wrong* data written deliberately. Subway direction has
to come from the platform `stop_id` suffix (`L28N`/`L28S`), the trip ID suffix
(`..N`/`..S`), or the NYCT extension's `direction` enum — never from `direction_id`.

**Why this argues against one unified direction field.** A destination (the terminus,
from the last stop time update) is a single unambiguous concept with full coverage on all
three feeds, so unifying it is free. Direction genuinely isn't one concept, so a unified
field would either fabricate values for feeds that lack the signal or overload one name
with per-feed meanings — compass on subway, branch-relative inbound/outbound on LIRR,
nothing on MNR. LIRR's `direction_id=1` into Penn Station means *inbound*, not south, and
synthesizing a compass value from it would misrepresent branches like Port Washington
where inbound isn't southward at all. Surfacing the value plus a small
`direction_source` discriminator (which signal produced it, or `null`) keeps both "what
does this mean" and "why is this empty" answerable from the response alone.
