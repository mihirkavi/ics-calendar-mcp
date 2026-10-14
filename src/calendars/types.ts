export type BusyStatus = "busy" | "tentative";

/** A detail-free span of time. Never carries event content. */
export interface BusyInterval {
  start: string;
  end: string;
  status: BusyStatus;
  calendarIds: string[];
}

export interface CalendarDefinition {
  id: string;
  name: string;
  enabled: boolean;
  timezone: string;
  /** Name of the Worker secret holding the feed URL. Never exposed publicly. */
  secretBinding: string;
  /** Exact hostname the feed URL must use. Never exposed publicly. */
  allowedHostname: string;
}

export interface PublicCalendar {
  id: string;
  name: string;
  timezone: string;
  capabilities: ["read_free_busy"];
}

export type CalendarBindings = Record<string, unknown>;

export type CoverageStatus = "fresh" | "unavailable";

export interface Coverage {
  calendarId: string;
  status: CoverageStatus;
  fetchedAt?: string;
  error?: { code: string; message: string };
}

export interface AvailabilityResult {
  start: string;
  end: string;
  timezone: string;
  busy: BusyInterval[];
  coverage: Coverage[];
  complete: boolean;
}

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface FreeSlotsResult {
  start: string;
  end: string;
  timezone: string;
  durationMinutes: number;
  slots: FreeSlot[];
  coverage: Coverage[];
  complete: boolean;
}
