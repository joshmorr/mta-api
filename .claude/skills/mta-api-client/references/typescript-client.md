# A typed TypeScript client

A small, dependency-free fetch client for this API. It bakes in the conventions from SKILL.md: the `{error, code}` envelope becomes a typed error, realtime staleness is surfaced rather than swallowed, and `feed` is required where the API requires it. Adapt freely — this is a starting point, not a library to copy verbatim.

Works in any `fetch`-capable runtime (browser, Node 18+, Bun, Deno).

## Optional: generate types from the live spec

The hand-written interfaces below are enough for most clients. If you want the response types to track the server automatically, generate them from the OpenAPI spec instead:

```sh
npx openapi-typescript {BASE_URL}/doc -o src/mta-api.d.ts
```

Then replace the inline interfaces with imports from that file. Either approach is fine; generation just removes the risk of drift.

## Client

```ts
export type Feed = "subway" | "lirr" | "mnr";
export type RtStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";

export interface StopSummary {
  feed_id: Feed;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
  platforms: string[]; // directional platform ids (subway); [] for lirr/mnr
}

export interface PlatformDetail { stop_id: string; direction: string }
export interface StopDetail extends Omit<StopSummary, "platforms"> {
  platforms: PlatformDetail[];
}

export interface Route {
  feed_id: Feed;
  route_id: string;
  name: string;
  long_name: string;
  color: string; // hex without '#', may be ""
}

export interface Arrival {
  feed_id: Feed;
  route_id: string;
  trip_id: string;
  arrival_time: number;        // unix seconds
  arrival_in_seconds: number;  // countdown, prefer for UI
  status: RtStatus;
}

export interface ArrivalResponse {
  feed_id: Feed;
  stop_id: string;
  stop_name: string;
  direction?: string;
  generated_at: number;
  stale: boolean;       // true => upstream failed, data is last-known-good
  feed_error?: string;
  arrivals: Arrival[];
}

export interface Vehicle {
  feed_id: Feed;
  trip_id: string;
  current_stop_id: string;
  status: RtStatus;
  timestamp: number;
}

export interface VehicleListResponse {
  feed_id: Feed;
  route_id: string;
  generated_at: number;
  vehicles: Vehicle[];
}

export interface InformedEntity {
  agency_id?: string;
  route_id?: string;
  stop_id?: string;
  direction_id?: 0 | 1; // 0 = northbound, 1 = southbound; omitted = both
}

export interface Alert {
  id: string;
  informed_entities: InformedEntity[];
  header: string;
  description: string;
  active_periods: { start: number; end: number }[];
}

export interface AlertListResponse {
  generated_at: number;
  stale: boolean;
  feed_error?: string;
  alerts: Alert[];
}

/** Mirrors the API's { error, code } envelope. */
export class MtaApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly rateLimitReset?: number, // unix seconds, set on 429
  ) {
    super(message);
    this.name = "MtaApiError";
  }
}

export interface MtaClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class MtaClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: MtaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.doFetch = opts.fetch ?? fetch;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const res = await this.doFetch(url.toString());
    const body = await res.json().catch(() => ({ error: res.statusText, code: "PARSE_ERROR" }));

    if (!res.ok) {
      const reset = res.headers.get("X-RateLimit-Reset");
      throw new MtaApiError(
        body.code ?? "UNKNOWN",
        body.error ?? "Request failed",
        res.status,
        reset ? Number(reset) : undefined,
      );
    }
    return body as T;
  }

  // --- Static ---
  stops(params: { q?: string; lat?: number; lon?: number; feed?: Feed; radius?: number; limit?: number } = {}) {
    return this.get<{ stops: StopSummary[] }>("/stops", params).then((r) => r.stops);
  }
  stop(stopId: string, feed: Feed) {
    return this.get<StopDetail>(`/stops/${encodeURIComponent(stopId)}`, { feed });
  }
  routes(feed?: Feed) {
    return this.get<{ routes: Route[] }>("/routes", { feed }).then((r) => r.routes);
  }
  route(routeId: string, feed: Feed) {
    return this.get<Route>(`/routes/${encodeURIComponent(routeId)}`, { feed });
  }

  // --- Realtime (responses may be stale: true; that's still a 200) ---
  arrivals(stop: string, feed: Feed, opts: { limit?: number; routes?: string[] } = {}) {
    return this.get<ArrivalResponse>("/arrivals", {
      stop, feed, limit: opts.limit, routes: opts.routes?.join(","),
    });
  }
  vehicles(route: string, feed: Feed) {
    return this.get<VehicleListResponse>("/vehicles", { route, feed });
  }
  alerts(opts: { routes?: string[]; stopId?: string; direction?: "N" | "S" | 0 | 1 } = {}) {
    return this.get<AlertListResponse>("/alerts", {
      routes: opts.routes?.join(","),
      stop_id: opts.stopId,
      direction: opts.direction === undefined ? undefined : String(opts.direction),
    });
  }
}
```

## Usage

```ts
const mta = new MtaClient({ baseUrl: process.env.MTA_API_URL });

// "What's the next downtown train at Times Sq?"
const [stop] = await mta.stops({ q: "Times Sq", feed: "subway" });
const downtown = stop.platforms.find((p) => p.endsWith("S")); // "127S"
const board = await mta.arrivals(downtown!, "subway", { limit: 5 });

if (board.stale) showDelayBadge(board.feed_error);
for (const a of board.arrivals) {
  console.log(`${a.route_id} in ${Math.round(a.arrival_in_seconds / 60)} min`);
}

// Handle the envelope
try {
  await mta.route("ZZ", "subway");
} catch (e) {
  if (e instanceof MtaApiError && e.code === "NOT_FOUND") {
    // unknown route, or wrong feed for the id
  }
}
```

## Polling note

Realtime data only refreshes every ~20s server-side, and you get 100 requests/60s per IP. For a live departures board, poll every 20–30s — faster wastes your rate budget without fresher data. Read `X-RateLimit-Remaining` / `X-RateLimit-Reset` (exposed on `MtaApiError` for 429s) if you fan out many calls.
