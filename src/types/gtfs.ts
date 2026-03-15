export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  location_type: string;
  parent_station?: string;
}

export interface GtfsRoute {
  agency_id?: string;
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string;
  route_type: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  direction_id: string;
  shape_id: string;
}

export interface GtfsStopTime {
  trip_id: string;
  stop_id: string;
  arrival_time: string;
  departure_time: string;
  stop_sequence: string;
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

export type FeedId = 'subway' | 'lirr' | 'mnr';

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
}

export interface StopTimeEvent {
  time: number | Long;
  delay?: number;
}

export interface VehiclePosition {
  trip: TripDescriptor;
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';
  timestamp?: number | Long;
}

export interface Alert {
  activePeriod: TimeRange[];
  informedEntity: EntitySelector[];
  headerText?: TranslatedString;
  descriptionText?: TranslatedString;
}

export interface TimeRange {
  start?: number | Long;
  end?: number | Long;
}

export interface EntitySelector {
  agencyId?: string;
  routeId?: string;
  stopId?: string;
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
