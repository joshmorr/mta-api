---
name: mta-gtfs
description: >-
  Authoritative knowledge of the MTA's static GTFS and GTFS-Realtime feeds (subway, LIRR,
  Metro-North) — the feed catalog and URLs, where MTA deviates from the base GTFS specs, and
  the per-feed quirks that silently produce wrong answers. Includes rt-probe.ts and
  static-probe.ts for checking claims against the live upstream feeds. Use this skill whenever
  work touches arrivals, schedules, trips, stops, routes, service alerts, vehicle positions,
  protobuf/GTFS-RT decoding, the seed/static import, stop or trip ID resolution, service dates
  and calendars, or the realtime cache — including when the user just says "the feed", names a
  route or station, or reports that some field is empty, wrong, or missing, since most such
  bugs come from a feed quirk rather than from this codebase.
---

# MTA GTFS feeds

The MTA publishes two unrelated things that share only identifiers: **static GTFS**
(ZIPs of CSV, "what is supposed to happen") and **GTFS-Realtime** (protobuf, "what is
happening now"). Both mostly follow the specs. The parts that don't are where nearly
every bug lives, and they differ *per feed* — subway, LIRR, and MNR were built by
different teams and do not agree with each other.

## Work from measurement, not memory

The single most useful habit here: the MTA changes what it populates without
announcement, and the fields that matter most are exactly the ones that are silently
absent on some feeds. Two scripts fetch the real upstream feeds so a claim can be
checked in seconds:

```sh
bun .claude/skills/mta-gtfs/scripts/rt-probe.ts nyct/gtfs-ace          # entity + field-presence report
bun .claude/skills/mta-gtfs/scripts/rt-probe.ts mnr/gtfs-mnr --field vehicle.currentStatus
bun .claude/skills/mta-gtfs/scripts/rt-probe.ts camsys/all-alerts --extensions
bun .claude/skills/mta-gtfs/scripts/static-probe.ts --list             # HEAD every static ZIP
bun .claude/skills/mta-gtfs/scripts/static-probe.ts lirr --columns trips.txt
bun .claude/skills/mta-gtfs/scripts/static-probe.ts subway --head stops.txt -n 4
```

Run `--help` on either for the full option list. Every number in this skill's reference
files came from these scripts and is dated; counts and timestamps drift, structural
claims don't. **Before telling the user a feed does or doesn't carry something, probe
it** — a stale assertion about feed contents is worse than no assertion, because it
gets designed against.

## The things that bite first

These cause most of the wasted debugging time. Details and evidence in the references.

**Realtime path encoding.** Feed paths contain a slash and the gateway treats the whole
path as one URL segment, so it must be percent-encoded: `nyct%2Fgtfs-l`. A literal slash
returns **HTTP 403 `{"message":"Missing Authentication Token"}`**, which reads like an
auth failure and is not one — no MTA feed here needs a key.

**HTTP 200 does not mean protobuf.** A well-formed but unknown feed path returns
**200 with S3's XML error document**, and successful protobuf responses are served as
`Content-Type: text/plain`. Check the body, not the status or the content type.

**IDs are unique only within a feed.** 104 `stop_id`s and 7 `route_id`s exist in all
three feeds — `route_id=1` is the Broadway–7 Av Local, the Babylon Branch, *and* the
Hudson Line. Anything resolving a specific entity needs a feed discriminator; a lookup
by bare ID is unanswerable.

**Subway realtime references platform IDs, never parent stations.** RT carries `L28S`,
not `L28`. Querying arrivals by a parent station ID returns nothing at all, which looks
like "no trains" rather than like a bug.

**The subway is not one producer.** `nyct/gtfs-l` carries `stop_sequence`, `delay`,
`uncertainty`, and `schedule_relationship`; the other seven subway feeds carry none of
them. Generalizing from the L feed to "the subway" is the most common way to get a
field-coverage claim wrong. See `references/realtime.md` for the full matrix.

**GTFS-RT is proto2, so absent and zero are the same value on decode.** `direction_id`,
and the enum zero-values `INCOMING_AT` and `SCHEDULED`, are all meaningfully `0`. Test
own-property presence, never truthiness:

```ts
Object.prototype.hasOwnProperty.call(entity.vehicle, 'currentStatus')
```

`protobufjs` sets defaults on the prototype and only assigns fields seen on the wire, so
this is reliable (verified by round-trip: encoding `directionId: 0` explicitly produces
5 bytes and an own property; omitting it produces 3 bytes and none). It also decodes
64-bit fields as `Long`, so every `timestamp`/`time` needs normalizing before arithmetic.

**Service days run past midnight and are not calendar days.** `25:30:00` is a legal
`stop_times` value (observed up to `28:02:00` on subway); `Date` parsing rejects it, and
string comparison against a wall clock is wrong. Before ~5 AM local, what is running is
*yesterday's* service date — querying only today returns nothing overnight.

**`calendar.txt` does not exist for LIRR or MNR.** Both express all service as
`calendar_dates.txt` rows. A resolver that requires `calendar.txt` fails on two feeds
out of three.

**Alerts never set `cause` or `effect`** (0 of 367 observed). The severity signal is
elsewhere — see `references/realtime.md` §alerts.

## Reference files

Read the one that matches what you're touching; each is self-contained.

| File | Read it when |
|---|---|
| `references/realtime.md` | Decoding GTFS-RT, arrivals, vehicles, alerts, cache TTLs, vendor proto extensions |
| `references/static.md` | The ZIPs, CSV parsing, the import/seed path, calendars, service dates, transfers |
| `references/identifiers.md` | Resolving stops/routes/trips, joining realtime to static, anything about direction |
| `references/gtfs-spec.md` | Telling standard GTFS apart from an MTA extension, or checking a field's spec meaning |

## Working in this repo

Business logic belongs in `src/services/` — it is the shared layer behind both the HTTP
routers and the MCP tools, so a quirk handled in a handler is a quirk still unhandled for
MCP clients. `src/proto/gtfs-realtime.proto` is the unmodified upstream definition, which
means MTA's vendor extension fields are decoded away silently; that is a deliberate
choice, not an oversight, and `rt-probe.ts --extensions` shows what is being dropped.

Two habits that keep this from rotting: when you discover feed behavior that contradicts
a reference file here, fix the reference file and date it; and when a quirk gets handled
in code, prefer surfacing *why* in the response (a `..._source` field naming which signal
produced a value) over silently normalizing feeds into a uniformity they don't have.

## Terms

MTA's data feed terms govern use. The parts that shape architecture rather than
documentation: redistribution must be served from a non-MTA server, derived values must
not be presented as if they came from the feed, and **lag over one minute between MTA
realtime and what the end user sees must be disclosed** — which is a real constraint on
cache TTL and on serving stale data during an upstream outage. `www.mta.info` returns 403
to every non-browser client including a spoofed user agent, so the terms cannot be
fetched programmatically; read them in a browser at
<https://www.mta.info/developers/terms-and-conditions> before relying on a detail.
