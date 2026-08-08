import { describe, expect, it, beforeEach } from 'bun:test';
import { searchStops, getStopDetail } from '../../src/services/stops.service';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../helpers/seed';
import { db } from '../../src/db/client';

// Times Sq-42 St, the subway fixture's parent station.
const TIMES_SQ = { lat: 40.755477, lon: -73.987691 };

describe('searchStops', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
    seedMnr();
  });

  it('returns every feed when none is given', () => {
    const feeds = new Set(searchStops({ radius: 400, limit: 20 }).map((s) => s.feed_id));
    expect(feeds).toEqual(new Set(['subway', 'lirr', 'mnr']));
  });

  it('narrows to a single feed', () => {
    const stops = searchStops({ feed: 'lirr', radius: 400, limit: 20 });
    expect(stops.map((s) => s.stop_name).sort()).toEqual(['Jamaica', 'Penn Station']);
  });

  it('lists only parent stations for subway, never platforms', () => {
    const ids = searchStops({ feed: 'subway', radius: 400, limit: 20 }).map((s) => s.stop_id);
    expect(ids).toEqual(['127']);
  });

  it('attaches platform IDs to subway stops and leaves them empty elsewhere', () => {
    const subway = searchStops({ feed: 'subway', radius: 400, limit: 20 })[0];
    expect(subway.platforms.sort()).toEqual(['127N', '127S']);

    for (const stop of searchStops({ feed: 'lirr', radius: 400, limit: 20 })) {
      expect(stop.platforms).toEqual([]);
    }
  });

  it('matches names case-insensitively on a substring', () => {
    expect(searchStops({ q: 'times sq', radius: 400, limit: 20 })).toHaveLength(1);
    expect(searchStops({ q: 'SQ-42', radius: 400, limit: 20 })).toHaveLength(1);
    expect(searchStops({ q: 'nowhere', radius: 400, limit: 20 })).toEqual([]);
  });

  it('finds stops inside the radius and excludes ones outside it', () => {
    const near = searchStops({ ...TIMES_SQ, feed: 'subway', radius: 400, limit: 20 });
    expect(near.map((s) => s.stop_id)).toEqual(['127']);

    // Grand Central is ~1.6km east of Times Sq; a 200m box must not reach it.
    const tight = searchStops({ ...TIMES_SQ, feed: 'mnr', radius: 200, limit: 20 });
    expect(tight).toEqual([]);
  });

  it('widens the longitude delta with latitude so the box stays square in metres', () => {
    // A stop 0.004 deg east of Times Sq is ~337m away at this latitude, but
    // would fall outside a 400m box if the lon delta were not divided by
    // cos(lat) (0.004 deg > 400/111000 = 0.0036 deg).
    resetDb();
    seedSubway();
    seedLirr();
    const stops = searchStops({
      lat: TIMES_SQ.lat,
      lon: TIMES_SQ.lon - 0.004,
      feed: 'subway',
      radius: 400,
      limit: 20,
    });
    expect(stops.map((s) => s.stop_id)).toEqual(['127']);
  });

  it('prefers proximity over a name query when both are given', () => {
    const stops = searchStops({ q: 'Jamaica', ...TIMES_SQ, feed: 'subway', radius: 400, limit: 20 });
    expect(stops.map((s) => s.stop_id)).toEqual(['127']);
  });

  it('respects the limit', () => {
    expect(searchStops({ radius: 400, limit: 1 })).toHaveLength(1);
  });
});

describe('getStopDetail', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
  });

  it('returns null for an unknown stop', () => {
    expect(getStopDetail('nope', 'subway')).toBeNull();
  });

  it('returns null when the stop exists in a different feed', () => {
    // stop_id "1" is an LIRR stop; the same ID is not a subway stop.
    expect(getStopDetail('1', 'lirr')).not.toBeNull();
    expect(getStopDetail('1', 'subway')).toBeNull();
  });

  it('resolves a subway platform up to its parent station', () => {
    const detail = getStopDetail('127N', 'subway');
    expect(detail?.stop_id).toBe('127');
    expect(detail?.stop_name).toBe('Times Sq-42 St');
  });

  it('returns a parent station unchanged', () => {
    expect(getStopDetail('127', 'subway')?.stop_id).toBe('127');
  });

  it('labels platform directions from the ID suffix', () => {
    const platforms = getStopDetail('127', 'subway')?.platforms ?? [];
    expect([...platforms].sort((a, b) => a.stop_id.localeCompare(b.stop_id))).toEqual([
      { stop_id: '127N', direction: 'Uptown / Northbound' },
      { stop_id: '127S', direction: 'Downtown / Southbound' },
    ]);
  });

  it('returns a flat stop with no platforms for LIRR', () => {
    const detail = getStopDetail('1', 'lirr');
    expect(detail?.stop_name).toBe('Penn Station');
    expect(detail?.platforms).toEqual([]);
  });

  it('returns [] for transfers when the stop has none', () => {
    expect(getStopDetail('127', 'subway')?.transfers).toEqual([]);
  });

  it('resolves transfers on the parent station, not the queried platform', () => {
    db.run(
      `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES ('subway', '902', 'Times Sq-42 St (Shuttle)', 40.7556, -73.9866, 1, NULL)`,
    );
    db.run(
      `INSERT INTO transfers (feed_id, from_stop_id, to_stop_id, transfer_type, min_transfer_time)
       VALUES ('subway', '127', '902', 2, 180)`,
    );
    const detail = getStopDetail('127N', 'subway'); // query by platform
    expect(detail?.transfers).toEqual([
      {
        to_stop_id:        '902',
        to_stop_name:      'Times Sq-42 St (Shuttle)',
        transfer_type:     2,
        min_transfer_time: 180,
        from_route_id:     null,
        to_route_id:       null,
        from_trip_id:      null,
        to_trip_id:        null,
      },
    ]);
  });
});
