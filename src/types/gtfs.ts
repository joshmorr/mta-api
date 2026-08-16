export type FeedId = 'subway' | 'lirr' | 'mnr';

export type VehicleStopStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';

export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  location_type: string;
  parent_station?: string;
  stop_code?: string;
  stop_desc?: string;
  zone_id?: string;
  wheelchair_boarding?: string;
}

export interface GtfsRoute {
  agency_id?: string;
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: string;
  route_desc?: string;
  route_url?: string;
  route_text_color?: string;
  route_sort_order?: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  direction_id: string;
  shape_id: string;
  trip_headsign?: string;
  trip_short_name?: string;
  block_id?: string;
  wheelchair_accessible?: string;
  peak_offpeak?: string;
}

export interface GtfsStopTime {
  trip_id: string;
  stop_id: string;
  arrival_time: string;
  departure_time: string;
  stop_sequence: string;
  track?: string;
  note_id?: string;
  pickup_type?: string;
  drop_off_type?: string;
}

export interface GtfsTransfer {
  from_stop_id: string;
  to_stop_id: string;
  transfer_type?: string;
  min_transfer_time?: string;
  // MNR only.
  from_route_id?: string;
  to_route_id?: string;
  // LIRR and MNR only; subway ships no trip-level transfers.
  from_trip_id?: string;
  to_trip_id?: string;
}

export interface GtfsCalendar {
  service_id: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  start_date: string;
  end_date: string;
}

export interface GtfsCalendarDate {
  service_id: string;
  date: string;
  exception_type: string;
}

// GTFS-RT types (decoded from protobufjs)
export interface FeedMessage {
  header: FeedHeader;
  entity: FeedEntity[];
}

export interface FeedHeader {
  gtfsRealtimeVersion: string;
  timestamp: number | Long;
}

export interface FeedEntity {
  id: string;
  tripUpdate?: TripUpdate;
  vehicle?: VehiclePosition;
  alert?: Alert;
}

export interface TripUpdate {
  trip: TripDescriptor;
  stopTimeUpdate: StopTimeUpdate[];
}

export interface TripDescriptor {
  tripId: string;
  routeId: string;
  startDate?: string;
  directionId?: number;
}

export interface StopTimeUpdate {
  stopId: string;
  stopSequence?: number;
  arrival?: StopTimeEvent;
  departure?: StopTimeEvent;
  /** LIRR/MNR only. Read it via `railroadStopTime()` in utils/realtime. */
  '.transit_realtime.mtaRailroadStopTimeUpdate'?: MtaRailroadStopTimeUpdate;
}

/**
 * MTA Railroad extension (field 1005), LIRR and MNR only.
 *
 * Both fields are `optional string`, so the proto2 default is `''` rather than
 * absent - LIRR in particular publishes empty strings rather than omitting the
 * field. Use `nonEmpty()` rather than a presence check.
 */
export interface MtaRailroadStopTimeUpdate {
  track?: string;
  /**
   * MNR only in practice. Observed: On-Time, Late, Delayed, Departed,
   * Arriving, Arrived, Canceled, Bus. MNR does not set
   * `schedule_relationship=CANCELED`, so this is the only cancellation signal.
   */
  trainStatus?: string;
}

export interface StopTimeEvent {
  time: number | Long;
  delay?: number;
}

export interface VehiclePosition {
  trip: TripDescriptor;
  vehicle?: VehicleDescriptor;
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: VehicleStopStatus;
  timestamp?: number | Long;
}

export interface VehicleDescriptor {
  id?: string;
  label?: string;
  licensePlate?: string;
}

export interface Alert {
  activePeriod: TimeRange[];
  informedEntity: EntitySelector[];
  headerText?: TranslatedString;
  descriptionText?: TranslatedString;
  /** Read it via `mercuryAlert()` in utils/realtime. */
  '.transit_realtime.mercuryAlert'?: MercuryAlert;
}

/**
 * Mercury extension (field 1001) on the camsys alert feed. Only the fields
 * this API consumes are mirrored; the feed also carries station alternatives,
 * work-order numbers and screen text.
 *
 * This is where the alert's kind actually lives - the MTA never populates the
 * standard `cause`/`effect`.
 */
export interface MercuryAlert {
  createdAt?: number | Long;
  updatedAt?: number | Long;
  alertType?: string;
  /** Absent on a minority of alerts, and decodes as null rather than missing. */
  humanReadableActivePeriod?: TranslatedString | null;
}

/** Mercury extension (field 1001) on each informed entity. */
export interface MercuryEntitySelector {
  /** `GTFS-ID:Priority`, e.g. `MTASBWY:F:26`. The GTFS ID contains colons. */
  sortOrder?: string;
}

export interface TimeRange {
  start?: number | Long;
  end?: number | Long;
}

export interface EntitySelector {
  agencyId?: string;
  routeId?: string;
  stopId?: string;
  directionId?: number;
  /** Read it via `mercurySortOrder()` in utils/realtime. */
  '.transit_realtime.mercuryEntitySelector'?: MercuryEntitySelector;
}

export interface TranslatedString {
  translation: Translation[];
}

export interface Translation {
  text: string;
  language?: string;
}

// Opaque type for protobufjs Long values
export interface Long {
  low: number;
  high: number;
  toNumber(): number;
}
