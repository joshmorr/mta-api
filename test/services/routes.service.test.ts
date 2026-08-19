import { describe, expect, it, beforeEach } from 'bun:test';
import { listRoutes, getRoute } from '../../src/services/routes.service';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../helpers/seed';
import { db } from '../../src/db/client';

describe('listRoutes', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
    seedMnr();
  });

  it('returns every feed when none is given', () => {
    const feeds = new Set(listRoutes().map((r) => r.feed_id));
    expect(feeds).toEqual(new Set(['subway', 'lirr', 'mnr']));
  });

  it('narrows to a single feed', () => {
    expect(listRoutes('mnr').map((r) => r.route_id)).toEqual(['HUDSON']);
  });

  it('maps a row onto the response shape', () => {
    expect(listRoutes('subway')).toEqual([
      {
        feed_id: 'subway',
        route_id: '1',
        name: '1',
        long_name: 'Broadway - 7 Avenue Local',
        color: '#EE352E',
      },
    ]);
  });
});

describe('getRoute', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
    seedMnr();
  });

  it('returns null for an unknown route', () => {
    expect(getRoute('ZZ', 'subway')).toBeNull();
  });

  it('returns null when the route exists in a different feed', () => {
    expect(getRoute('PW', 'lirr')).not.toBeNull();
    expect(getRoute('PW', 'subway')).toBeNull();
  });

  it('falls back through the name fields so neither is ever empty', () => {
    db.run(
      `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
       VALUES
         ('subway', 'LONGONLY',  'MTA', NULL, 'Long Name Only', NULL, 1),
         ('subway', 'SHORTONLY', 'MTA', 'SO', NULL,             NULL, 1),
         ('subway', 'NEITHER',   'MTA', NULL, NULL,             NULL, 1)`,
    );

    expect(getRoute('LONGONLY', 'subway')).toMatchObject({
      name: 'Long Name Only',
      long_name: 'Long Name Only',
    });
    expect(getRoute('SHORTONLY', 'subway')).toMatchObject({
      name: 'SO',
      long_name: 'SO',
    });
    expect(getRoute('NEITHER', 'subway')).toMatchObject({
      name: 'NEITHER',
      long_name: 'NEITHER',
    });
  });

  // MNR ships an empty CSV field rather than omitting the value, so a blank
  // name reaches the DB as '' and not NULL. A `??` fallback passes it through
  // and names every MNR route ''.
  it('treats an empty name as blank, not as a value', () => {
    db.run(
      `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
       VALUES
         ('subway', 'EMPTYSHORT', 'MTA', '',   'Empty Short', NULL, 1),
         ('subway', 'EMPTYLONG',  'MTA', 'EL', '',            NULL, 1),
         ('subway', 'EMPTYBOTH',  'MTA', '',   '',            NULL, 1)`,
    );

    expect(getRoute('EMPTYSHORT', 'subway')).toMatchObject({
      name: 'Empty Short',
      long_name: 'Empty Short',
    });
    expect(getRoute('EMPTYLONG', 'subway')).toMatchObject({
      name: 'EL',
      long_name: 'EL',
    });
    expect(getRoute('EMPTYBOTH', 'subway')).toMatchObject({
      name: 'EMPTYBOTH',
      long_name: 'EMPTYBOTH',
    });
  });

  it('names MNR routes by their branch, which publish a blank short name', () => {
    expect(getRoute('HUDSON', 'mnr')).toMatchObject({
      name: 'Hudson Line',
      long_name: 'Hudson Line',
    });
  });

  it('renders a null colour as an empty string', () => {
    db.run(
      `INSERT INTO routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_color, route_type)
       VALUES ('subway', 'NOCOLOR', 'MTA', 'NC', 'No Colour', NULL, 1)`,
    );
    expect(getRoute('NOCOLOR', 'subway')?.color).toBe('');
  });
});
