import { describe, expect, it, beforeEach, afterAll, mock } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { syncSubwayFeed, syncLirrFeed } from '../../src/services/static.service';
import { db } from '../../src/db/client';
import { resetDb } from '../helpers/seed';

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

function makeZip(files: Record<string, string>): Uint8Array {
  const u8Files: Record<string, Uint8Array> = {};
  for (const [name, contents] of Object.entries(files)) {
    u8Files[name] = strToU8(contents);
  }
  return zipSync(u8Files);
}

function stubFetchOk(body: Uint8Array): void {
  // Service code does fetch().then(r => r.arrayBuffer()).
  // Wrap in a fresh ArrayBuffer to ensure no SharedArrayBuffer.
  const buf = new ArrayBuffer(body.byteLength);
  new Uint8Array(buf).set(body);
  globalThis.fetch = mock(async () => new Response(buf, { status: 200 })) as unknown as typeof fetch;
}

describe('syncFeed pipeline', () => {
  beforeEach(() => {
    resetDb();
  });

  it('downloads, unzips, parses, and inserts all expected tables for subway', async () => {
    const stopsCsv =
      'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
      '127,Times Sq-42 St,40.755,-73.987,1,\n' +
      '127N,Times Sq-42 St,40.755,-73.987,0,127\n' +
      '127S,Times Sq-42 St,40.755,-73.987,0,127\n';

    const routesCsv =
      'route_id,agency_id,route_short_name,route_long_name,route_color,route_type\n' +
      '1,MTA NYCT,1,Broadway,EE352E,1\n';

    const tripsCsv =
      'trip_id,route_id,service_id,direction_id,shape_id\n' +
      'T1,1,WKDY,0,\n';

    const stopTimesCsv =
      'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n' +
      'T1,127N,10:00:00,10:00:00,1\n' +
      'T1,127S,10:05:00,10:05:00,2\n';

    const calendarCsv =
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      'WKDY,1,1,1,1,1,0,0,20200101,20991231\n';

    const calendarDatesCsv =
      'service_id,date,exception_type\n' +
      'WKDY,20240704,2\n';

    const zip = makeZip({
      'stops.txt': stopsCsv,
      'routes.txt': routesCsv,
      'trips.txt': tripsCsv,
      'stop_times.txt': stopTimesCsv,
      'calendar.txt': calendarCsv,
      'calendar_dates.txt': calendarDatesCsv,
      // Files outside NEEDED_FILES should be ignored without error
      'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,40,-73,1\n',
    });
    stubFetchOk(zip);

    await syncSubwayFeed();

    const stops = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stops WHERE feed_id='subway'`).all();
    expect(stops.map((s) => s.stop_id).sort()).toEqual(['127', '127N', '127S']);

    const routes = db.query<{ route_color: string }, []>(`SELECT route_color FROM routes WHERE feed_id='subway'`).all();
    expect(routes[0].route_color).toBe('#EE352E'); // service prefixes #

    const trips = db.query<{ trip_id: string }, []>(`SELECT trip_id FROM trips WHERE feed_id='subway'`).all();
    expect(trips).toHaveLength(1);

    const stopTimes = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stop_times WHERE feed_id='subway'`).all();
    expect(stopTimes.map((s) => s.stop_id).sort()).toEqual(['127N', '127S']);

    const cal = db.query<{ service_id: string; monday: number }, []>(`SELECT service_id, monday FROM calendar WHERE feed_id='subway'`).all();
    expect(cal).toEqual([{ service_id: 'WKDY', monday: 1 }]);

    const cdRows = db.query<{ date: string; exception_type: number }, []>(`SELECT date, exception_type FROM calendar_dates WHERE feed_id='subway'`).all();
    expect(cdRows).toEqual([{ date: '20240704', exception_type: 2 }]);

    // feed_meta was set
    const meta = db.query<{ last_synced: number }, []>(`SELECT last_synced FROM feed_meta WHERE feed_id='subway'`).get();
    expect(meta?.last_synced).toBeGreaterThan(0);
  });

  it('clears prior data for the feed before inserting (clearFeedData)', async () => {
    // Seed an old stop that should be wiped
    db.run(
      `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES ('subway', 'OLD', 'Old stop', 0, 0, 1, NULL)`,
    );

    const zip = makeZip({
      'stops.txt':
        'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
        'NEW,New stop,0,0,1,\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_color,route_type\n',
      'trips.txt': 'trip_id,route_id,service_id,direction_id,shape_id\n',
      'stop_times.txt': 'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n',
      'calendar_dates.txt': 'service_id,date,exception_type\n',
    });
    stubFetchOk(zip);

    await syncSubwayFeed();

    const stops = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stops WHERE feed_id='subway'`).all();
    expect(stops.map((s) => s.stop_id)).toEqual(['NEW']);
  });

  it('only touches the requested feed (LIRR sync leaves subway data alone)', async () => {
    db.run(
      `INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES ('subway', 'KEEP', 'Keep', 0, 0, 1, NULL)`,
    );

    const zip = makeZip({
      'stops.txt':
        'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
        '1,Penn,40,-73,0,\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_color,route_type\n',
      'trips.txt': 'trip_id,route_id,service_id,direction_id,shape_id\n',
      'stop_times.txt': 'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n',
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n',
      'calendar_dates.txt': 'service_id,date,exception_type\n',
    });
    stubFetchOk(zip);

    await syncLirrFeed();

    const subway = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stops WHERE feed_id='subway'`).all();
    expect(subway.map((s) => s.stop_id)).toEqual(['KEEP']);
    const lirr = db.query<{ stop_id: string }, []>(`SELECT stop_id FROM stops WHERE feed_id='lirr'`).all();
    expect(lirr.map((s) => s.stop_id)).toEqual(['1']);
  });

  it('throws if the upstream returns non-OK', async () => {
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(syncSubwayFeed()).rejects.toThrow(/HTTP 500/);
  });

  it('handles a missing calendar.txt without erroring (skips upsertCalendar)', async () => {
    const zip = makeZip({
      'stops.txt':
        'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
        'X,X,0,0,1,\n',
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_color,route_type\n',
      'trips.txt': 'trip_id,route_id,service_id,direction_id,shape_id\n',
      'stop_times.txt': 'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n',
      // No calendar.txt
      'calendar_dates.txt': 'service_id,date,exception_type\n',
    });
    stubFetchOk(zip);

    await syncSubwayFeed();

    const cal = db.query<{ cnt: number }, []>(`SELECT COUNT(*) cnt FROM calendar WHERE feed_id='subway'`).get();
    expect(cal?.cnt).toBe(0);
  });
});
