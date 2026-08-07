import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { makeMcpClient, textOf } from '../helpers/mcp';
import { resetDb, seedSubway, seedLirr, seedMnr } from '../helpers/seed';

const mcp = makeMcpClient();

afterAll(async () => {
  await mcp.close();
});

const EXPECTED_TOOLS = [
  'mta_search_stops',
  'mta_get_stop',
  'mta_list_routes',
  'mta_get_route',
  'mta_get_arrivals',
  'mta_get_vehicles',
  'mta_get_alerts',
];

describe('tools/list', () => {
  it('advertises exactly the seven MTA tools', async () => {
    const names = (await mcp.listTools()).map((t) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('does not expose a health tool', async () => {
    const names = (await mcp.listTools()).map((t) => t.name);
    expect(names.some((n) => n.includes('health'))).toBe(false);
  });

  it('marks every tool read-only and non-destructive', async () => {
    for (const tool of await mcp.listTools()) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }
  });

  it('flags only the realtime tools as open-world', async () => {
    const openWorld = (await mcp.listTools())
      .filter((t) => t.annotations?.openWorldHint)
      .map((t) => t.name);
    expect(openWorld.sort()).toEqual(['mta_get_alerts', 'mta_get_arrivals', 'mta_get_vehicles']);
  });

  it('gives every tool a title, description, and output schema', async () => {
    for (const tool of await mcp.listTools()) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
  });

  it('explains the feed-scoping rule on every feed-scoped tool', async () => {
    const feedScoped = (await mcp.listTools()).filter(
      (t) => (t.inputSchema.required as string[] | undefined)?.includes('feed'),
    );
    expect(feedScoped.map((t) => t.name).sort()).toEqual(
      ['mta_get_arrivals', 'mta_get_route', 'mta_get_stop', 'mta_get_vehicles'],
    );
    for (const tool of feedScoped) {
      expect(tool.description).toMatch(/reuses IDs across systems/);
    }
  });
});

describe('mta_search_stops', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
    seedMnr();
  });

  it('searches by name and returns structured content', async () => {
    const result = await mcp.callTool('mta_search_stops', { q: 'Times' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      stops: [
        {
          feed_id: 'subway',
          stop_id: '127',
          stop_name: 'Times Sq-42 St',
          lat: 40.755477,
          lon: -73.987691,
          platforms: ['127N', '127S'],
        },
      ],
    });
  });

  it('mirrors the structured content in the text block', async () => {
    const result = await mcp.callTool('mta_search_stops', { q: 'Times' });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('searches by proximity', async () => {
    const result = await mcp.callTool('mta_search_stops', {
      lat: 40.755477,
      lon: -73.987691,
      feed: 'subway',
      radius: 400,
    });
    expect((result.structuredContent as { stops: { stop_id: string }[] }).stops[0].stop_id).toBe('127');
  });

  it('defaults the radius and limit when they are omitted', async () => {
    const result = await mcp.callTool('mta_search_stops', { feed: 'lirr' });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { stops: unknown[] }).stops).toHaveLength(2);
  });

  it('rejects a latitude with no longitude', async () => {
    const result = await mcp.callTool('mta_search_stops', { lat: 40.75 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/needs both lat and lon/);
  });

  it('suggests a shorter substring when a name matches nothing', async () => {
    const result = await mcp.callTool('mta_search_stops', { q: 'Nonexistent Station' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/shorter substring/);
  });

  it('rejects a radius above the 1600m ceiling', async () => {
    const result = await mcp.callTool('mta_search_stops', { lat: 40.75, lon: -73.98, radius: 5000 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/validation/i);
  });

  it('rejects an unknown argument', async () => {
    const result = await mcp.callTool('mta_search_stops', { q: 'Times', nearby: true });
    expect(result.isError).toBe(true);
  });
});

describe('mta_get_stop', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
  });

  it('resolves a platform up to its parent station with directions', async () => {
    const result = await mcp.callTool('mta_get_stop', { stop_id: '127N', feed: 'subway' });
    const stop = result.structuredContent as { stop_id: string; platforms: unknown[] };
    expect(stop.stop_id).toBe('127');
    expect(stop.platforms).toContainEqual({ stop_id: '127N', direction: 'Uptown / Northbound' });
    expect(stop.platforms).toContainEqual({ stop_id: '127S', direction: 'Downtown / Southbound' });
  });

  it('returns a flat LIRR stop with no platforms', async () => {
    const result = await mcp.callTool('mta_get_stop', { stop_id: '1', feed: 'lirr' });
    expect(result.structuredContent).toMatchObject({ stop_name: 'Penn Station', platforms: [] });
  });

  it('points at the other feeds when the ID exists elsewhere', async () => {
    const result = await mcp.callTool('mta_get_stop', { stop_id: '1', feed: 'subway' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/may exist in another feed/);
  });

  it('rejects a call with no feed rather than guessing one', async () => {
    const result = await mcp.callTool('mta_get_stop', { stop_id: '127' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/feed/);
  });

  it('rejects an unknown feed', async () => {
    const result = await mcp.callTool('mta_get_stop', { stop_id: '127', feed: 'bus' });
    expect(result.isError).toBe(true);
  });
});

describe('mta_list_routes', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
    seedMnr();
  });

  it('lists across every feed by default', async () => {
    const result = await mcp.callTool('mta_list_routes');
    const { routes } = result.structuredContent as { routes: { feed_id: string }[] };
    expect(new Set(routes.map((r) => r.feed_id))).toEqual(new Set(['subway', 'lirr', 'mnr']));
  });

  it('narrows to one feed', async () => {
    const result = await mcp.callTool('mta_list_routes', { feed: 'subway' });
    expect(result.structuredContent).toEqual({
      routes: [
        {
          feed_id: 'subway',
          route_id: '1',
          name: '1',
          long_name: 'Broadway - 7 Avenue Local',
          color: '#EE352E',
        },
      ],
    });
  });

  it('returns an empty list rather than an error when a feed has no routes', async () => {
    resetDb();
    const result = await mcp.callTool('mta_list_routes', { feed: 'mnr' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ routes: [] });
  });
});

describe('mta_get_route', () => {
  beforeEach(() => {
    resetDb();
    seedSubway();
    seedLirr();
  });

  it('returns route detail', async () => {
    const result = await mcp.callTool('mta_get_route', { route_id: 'PW', feed: 'lirr' });
    expect(result.structuredContent).toMatchObject({
      route_id: 'PW',
      long_name: 'Port Washington Branch',
      color: '#00985F',
    });
  });

  it('points at mta_list_routes when the route is unknown', async () => {
    const result = await mcp.callTool('mta_get_route', { route_id: 'ZZ', feed: 'subway' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/mta_list_routes/);
  });

  it('does not find an LIRR route under the subway feed', async () => {
    const result = await mcp.callTool('mta_get_route', { route_id: 'PW', feed: 'subway' });
    expect(result.isError).toBe(true);
  });
});

describe('unknown tools', () => {
  it('reports a call to a tool that does not exist', async () => {
    const result = await mcp.callTool('mta_get_health').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toMatch(/mta_get_health/);
    } else {
      expect(result.isError).toBe(true);
    }
  });
});
