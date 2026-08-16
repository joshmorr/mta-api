# Base GTFS and GTFS-Realtime, as specified

What the *standards* say, so MTA behavior can be classified rather than guessed at. When
the MTA and the spec disagree, the MTA wins in practice — but knowing which is which
tells you whether a workaround is permanent (MTA convention) or something a validator
would flag (MTA bug), and whether an off-the-shelf GTFS library will cope.

Canonical sources — consult these when a field's exact semantics matter, since they are
revised:

- GTFS Schedule: <https://gtfs.org/documentation/schedule/reference/>
- GTFS Realtime: <https://gtfs.org/documentation/realtime/reference/>
- MTA's own implementation notes: <https://github.com/nymta/gtfs-documentation>
  (currently two specs: `feeds/subway/gtfs-rt/stations_affected.md` and
  `feeds/service_changes.md`). Fetchable via the GitHub API or raw URLs.
- `www.mta.info` returns 403 to all non-browser clients, spoofed user agents included, so
  the developer portal and terms pages must be read in a browser.

## GTFS Schedule

**File requirements.** Required: `agency.txt`, `routes.txt`, `trips.txt`,
`stop_times.txt`. Conditionally required: `stops.txt`, `calendar.txt`,
`calendar_dates.txt`, `feed_info.txt`, `levels.txt`. Everything else — `shapes.txt`,
`transfers.txt`, `frequencies.txt`, `pathways.txt`, the fares files, `translations.txt`,
`attributions.txt` — is optional.

`calendar.txt` is *required unless all service dates are defined in `calendar_dates.txt`*,
which is precisely the exemption LIRR and MNR use. Their omission is spec-conformant, not
a defect.

**`stops.location_type`**: `0` or empty = stop/platform, `1` = station, `2` =
entrance/exit, `3` = generic node, `4` = boarding area. `parent_station` is required for
types 2/3/4, optional for type 0, and forbidden for type 1. Empty meaning `0` is why the
MTA's blank subway platform rows are legal.

**`routes.route_type`**: `0` tram/light rail, `1` subway/metro, `2` rail, `3` bus,
`4` ferry, `5` cable tram, `6` aerial lift, `7` funicular, `11` trolleybus, `12` monorail.
SIR being `2` inside the subway feed is a defensible classification, not an error.

**`trips.direction_id`**: `0` = one direction, `1` = the opposite. The spec deliberately
assigns **no** compass or inbound/outbound meaning — it is a binary partition per route,
and its interpretation is per-producer. This is the root of the MTA's four different
`direction_id` conventions, and the reason a portable consumer cannot infer geography
from it.

**`stop_times` times**: `HH:MM:SS` (or `H:MM:SS`), and times after midnight on the same
service day *must* exceed 24:00:00 — `25:35:00` for 1:35 AM. Values over 24 are the spec
working correctly, not corruption. `pickup_type`/`drop_off_type`: `0` or empty regularly
scheduled, `1` none available, `2` phone the agency, `3` coordinate with the driver.
`timepoint`: `0` approximate, `1` exact.

**`calendar_dates.exception_type`**: `1` = service added on that date, `2` = removed.

**`transfers.transfer_type`**: `0` recommended point, `1` timed transfer (the departing
vehicle waits), `2` minimum time required (`min_transfer_time`), `3` transfer forbidden,
`4` in-seat transfer, `5` in-seat transfer not possible. `from_trip_id`/`to_trip_id`
scope a row to specific trips — which is exactly how LIRR and MNR use the file, and why
their rows describe guarantees rather than connectivity.

**Extension columns** are not part of the spec; a conforming consumer ignores unknown
columns. So `peak_offpeak`, `track`, `note_id`, and `notes.txt` are invisible to generic
tooling and must be handled explicitly.

## GTFS Realtime

Protobuf, proto2 syntax. `FeedMessage` = `header` (required) + repeated `entity`.

**`FeedHeader`**: `gtfs_realtime_version` (required; valid values `"1.0"` and `"2.0"` —
MNR's `"1"` is neither), `incrementality` (required: `FULL_DATASET` 0, `DIFFERENTIAL` 1,
the latter unsupported in practice), `timestamp` (required, POSIX seconds).

**`FeedEntity`**: `id` (required) plus at least one of `trip_update`, `vehicle`, `alert`
(and the newer experimental `shape`, `stop`, `trip_modifications`). Nothing forbids one
entity carrying several payloads, which is why MNR's packing is legal.

**`StopTimeUpdate.ScheduleRelationship`**: `SCHEDULED` 0, `SKIPPED` 1, `NO_DATA` 2,
`UNSCHEDULED` 3.

**`VehiclePosition.VehicleStopStatus`**: `INCOMING_AT` 0, `STOPPED_AT` 1,
`IN_TRANSIT_TO` 2 — and the spec says `IN_TRANSIT_TO` is *assumed* when `current_status`
is missing. Take that assumption knowingly: on MTA feeds the field is absent most of the
time, so applying the default means asserting "in transit" for trains whose status is
simply unpublished. Reporting `null` is usually the more honest surface.

**`Alert`**: `informed_entity` (required, at least one), `header_text` and
`description_text` (required). `cause` and `effect` are optional enums — MTA sets
neither. `EntitySelector` requires at least one specifier among `agency_id`, `route_id`,
`route_type`, `direction_id`, `trip`, `stop_id`. `TranslatedString` is a repeated
`translation` of `{text, language}`, where `language` is optional — so tolerating an
untagged translation is spec-correct even though MTA currently tags everything.

**Proto2 semantics are the thing to internalize.** Fields are optional with declared
defaults; an unset scalar decodes to that default, so on the decoded object `0`, `""`,
`false`, and the enum zero-value are indistinguishable from absence unless the library
exposes has-bits. `protobufjs` exposes them as own-property presence (defaults live on the
prototype). This is why every presence claim in this skill was made with
`Object.prototype.hasOwnProperty.call(...)` and why truthiness checks quietly invent data.

`protobufjs` also decodes 64-bit fields (`timestamp`, `time`) as `Long` objects rather
than numbers unless configured otherwise, so normalize before arithmetic or comparison.

**Extensions** are declared by field number in a producer's own proto. The spec's
messages reserve **`extensions 1000 to 1999`** for third-party extensions and
**`9000 to 9999`** for private organizational use, which is why scanning for field
numbers ≥ 1000 finds the MTA's, and why a stock proto silently drops them: unknown fields
are skipped on decode with no error and no warning.
