import { describe, it, expect, beforeEach } from 'bun:test';
import {
  findTransferJourneys,
  EXCLUDED_TRANSFER_STOP_IDS,
  MAX_TRANSFERS_BY_FEED,
  MAX_SUPPORTED_TRANSFERS,
} from '../../src/services/transferSearch';
import { resetDb, seedLirrTransferSchedule, seedTransfersXfer } from '../helpers/seed';
import { db } from '../../src/db/client';

const MONDAY = { date: '20240115', weekdayColumn: 'monday' as const };

function search(overrides: Partial<Parameters<typeof findTransferJourneys>[0]> = {}) {
  return findTransferJourneys({
    feedId: 'lirr',
    fromStopId: '171',
    toStopIds: ['27'],
    serviceDate: MONDAY,
    afterSeconds: 0,
    untilSeconds: 30 * 3600,
    ...overrides,
  });
}

describe('findTransferJourneys', () => {
  beforeEach(() => {
    resetDb();
    seedLirrTransferSchedule();
  });

  it('connects two branches through the shared junction', () => {
    const journeys = search();

    expect(journeys).toHaveLength(1);
    const [journey] = journeys;
    expect(journey.legs.map((l) => l.trip_id)).toEqual(['XFER-A', 'XFER-D']);
    expect(journey.connections).toHaveLength(1);
    expect(journey.connections[0].stopId).toBe('214');
  });

  it('never changes trains at a city terminal, however well the times line up', () => {
    // XFER-A reaches Penn at 10:45 and XFER-C leaves it at 11:00 for Babylon -
    // a clean 15-minute connection that would mean riding into Manhattan and
    // straight back out.
    const journeys = search();

    expect(journeys.every((j) => j.connections.every((c) => c.stopId !== '237'))).toBe(true);
    expect(journeys.every((j) => !j.legs.some((l) => l.trip_id === 'XFER-C'))).toBe(true);
  });

  it('applies the feed\'s own minimum connection time in preference to the default', () => {
    // XFER-D leaves Woodside exactly 180s after XFER-A arrives and gets to
    // Babylon first, so it wins by default. Woodside's published 600s rule
    // rules it out, promoting the slower XFER-B.
    expect(search()[0].legs[1].trip_id).toBe('XFER-D');

    seedTransfersXfer();

    const [journey] = search();
    expect(journey.legs[1].trip_id).toBe('XFER-B');
    expect(journey.connections[0].minTransferTime).toBe(600);
    expect(journey.connections[0].connectionSeconds).toBe(15 * 60);
  });

  it('reports no published minimum as null rather than inventing the default', () => {
    expect(search()[0].connections[0].minTransferTime).toBeNull();
  });

  it('flags a connection transfers.txt guarantees for that exact trip pair', () => {
    seedTransfersXfer();

    const [journey] = search();
    expect(journey.legs.map((l) => l.trip_id)).toEqual(['XFER-A', 'XFER-B']);
    expect(journey.connections[0].guaranteed).toBe(true);
  });

  it('leaves an unenumerated connection unflagged rather than absent', () => {
    // No transfers.txt rows at all: the connection is still found, just not
    // labelled. Absence of a row means unenumerated, not impossible.
    const [journey] = search();
    expect(journey.connections[0].guaranteed).toBe(false);
  });

  it('rejects a connection that leaves before the minimum has elapsed', () => {
    // Pull XFER-D forward to 30s after XFER-A arrives.
    db.run(
      `UPDATE stop_times SET departure_time = '10:30:30', departure_seconds = ${10 * 3600 + 30 * 60 + 30}
       WHERE feed_id = 'lirr' AND trip_id = 'XFER-D' AND stop_id = '214'`,
    );

    expect(search()[0].legs[1].trip_id).toBe('XFER-B');
  });

  it('rejects a connection that waits longer than an hour', () => {
    db.run(
      `UPDATE stop_times SET departure_time = '11:31:00', departure_seconds = ${11 * 3600 + 31 * 60}
       WHERE feed_id = 'lirr' AND trip_id = 'XFER-B' AND stop_id = '214'`,
    );
    db.run(
      `UPDATE stop_times SET departure_time = '12:00:00', departure_seconds = ${12 * 3600}
       WHERE feed_id = 'lirr' AND trip_id = 'XFER-D' AND stop_id = '214'`,
    );

    // XFER-B now waits 61 minutes at Woodside and XFER-D 90; neither is a
    // connection any longer, and there is nothing else to change onto.
    expect(search()).toEqual([]);
  });

  it('does not treat staying on the same train as a transfer', () => {
    // 171 -> 237 is a single ride on XFER-A. Its own later stops must not pair
    // back onto itself and masquerade as a connection.
    const journeys = search({ toStopIds: ['237'] });

    expect(journeys.every((j) => j.legs[0].trip_id !== j.legs[1].trip_id)).toBe(true);
  });

  it('offers one journey per first-leg train, the one arriving earliest', () => {
    // Both XFER-B and XFER-D are reachable from XFER-A at Woodside; XFER-D
    // arrives 20 minutes earlier, so the later option is not also offered.
    const journeys = search();

    expect(journeys).toHaveLength(1);
    expect(journeys[0].legs[1].trip_id).toBe('XFER-D');
  });

  it('ignores trips whose service is not active on the date', () => {
    expect(search({ serviceDate: { date: '20240116', weekdayColumn: 'tuesday' } })).toEqual([]);
  });

  it('honours the first-leg departure window', () => {
    expect(search({ afterSeconds: 10 * 3600 + 1 })).toEqual([]);
    expect(search({ untilSeconds: 10 * 3600 - 1 })).toEqual([]);
  });

  it('returns nothing when the destination set is empty', () => {
    expect(search({ toStopIds: [] })).toEqual([]);
  });
});

describe('feed transfer capabilities', () => {
  it('excludes the LIRR city terminals and nothing on the other feeds', () => {
    expect(EXCLUDED_TRANSFER_STOP_IDS.lirr).toEqual(['237', '349', '241', '90', '118']);
    expect(EXCLUDED_TRANSFER_STOP_IDS.subway).toBeUndefined();
    expect(EXCLUDED_TRANSFER_STOP_IDS.mnr).toBeUndefined();
  });

  it('allows one transfer on LIRR and none elsewhere yet', () => {
    expect(MAX_TRANSFERS_BY_FEED).toEqual({ subway: 0, lirr: 1, mnr: 0 });
    expect(MAX_SUPPORTED_TRANSFERS).toBe(1);
  });
});
