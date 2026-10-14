import { CalendarError } from "../errors";
import { fetchCalendar as defaultFetchCalendar, type FetchedCalendar } from "../security/fetch-policy";
import { redactError } from "../security/redaction";
import { parseBusyIntervals as defaultParse, type ParseIcsInput } from "./adapters/ics";
import { mergeEpochIntervals, toBusyInterval, type EpochInterval } from "./availability";
import { loadRegistry, resolveCalendarUrl, toPublicCalendar, type CalendarRegistry } from "./registry";
import { findFreeSlots as computeFreeSlots, type WorkingHours } from "./slots";
import { formatInTimeZone, resolveRange } from "./time";
import type {
  AvailabilityResult,
  CalendarBindings,
  CalendarDefinition,
  Coverage,
  FreeSlotsResult,
  PublicCalendar,
} from "./types";

export interface FreeBusyInput {
  calendarIds?: string[];
  start: string;
  end: string;
  /** IANA zone for output and for local dates; defaults to the first selected calendar's zone. */
  timezone?: string;
}

export interface FindSlotsRequest extends FreeBusyInput {
  durationMinutes: number;
  bufferMinutes?: number;
  workingHours?: WorkingHours;
  includeWeekends?: boolean;
}

export interface CalendarServiceDependencies {
  registry: CalendarRegistry;
  fetchCalendar: (url: URL, allowedHostname: string) => Promise<FetchedCalendar>;
  parseBusyIntervals: (input: ParseIcsInput) => EpochInterval[];
}

export interface CalendarService {
  listCalendars(): PublicCalendar[];
  /** Default zone used when a request omits `timezone`. */
  defaultTimezone(): string;
  getFreeBusy(input: FreeBusyInput): Promise<AvailabilityResult>;
  findFreeSlots(input: FindSlotsRequest): Promise<FreeSlotsResult>;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { start: "09:00", end: "17:00" };

export function createCalendarService(env: CalendarBindings, deps: Partial<CalendarServiceDependencies> = {}): CalendarService {
  const registry = deps.registry ?? loadRegistry(env);
  const fetchFeed = deps.fetchCalendar ?? ((url: URL, host: string) => defaultFetchCalendar(url, host));
  const parse = deps.parseBusyIntervals ?? defaultParse;

  function selectCalendars(ids: string[] | undefined): CalendarDefinition[] {
    if (ids === undefined || ids.length === 0) {
      const enabled = registry.listEnabledCalendars();
      if (enabled.length === 0) throw new CalendarError("calendar_not_configured", "No calendars are enabled.");
      return enabled;
    }
    const seen = new Set<string>();
    const selected: CalendarDefinition[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const definition = registry.getCalendar(id);
      if (!definition || !definition.enabled) throw new CalendarError("unknown_calendar", `Unknown calendar ID: ${id.replace(/[^a-z0-9-]/gi, "").slice(0, 64)}`);
      selected.push(definition);
    }
    return selected;
  }

  async function loadIntervals(
    definition: CalendarDefinition,
    startMs: number,
    endMs: number,
  ): Promise<{ intervals: EpochInterval[]; fetchedAt: string }> {
    const url = resolveCalendarUrl(definition, env);
    const fetched = await fetchFeed(url, definition.allowedHostname);
    const intervals = parse({
      ics: fetched.body,
      calendarId: definition.id,
      defaultTimezone: definition.timezone,
      rangeStartMs: startMs,
      rangeEndMs: endMs,
    });
    return { intervals, fetchedAt: fetched.fetchedAt };
  }

  async function collect(input: FreeBusyInput) {
    const calendars = selectCalendars(input.calendarIds);
    const range = resolveRange(input.start, input.end, input.timezone ?? calendars[0]!.timezone);
    const settled = await Promise.allSettled(calendars.map((definition) => loadIntervals(definition, range.startMs, range.endMs)));
    const coverage: Coverage[] = [];
    const intervals: EpochInterval[] = [];
    settled.forEach((result, index) => {
      const calendarId = calendars[index]!.id;
      if (result.status === "fulfilled") {
        intervals.push(...result.value.intervals);
        coverage.push({ calendarId, status: "fresh", fetchedAt: result.value.fetchedAt });
      } else {
        coverage.push({ calendarId, status: "unavailable", error: redactError(result.reason) });
      }
    });
    const merged = mergeEpochIntervals(intervals);
    const complete = coverage.every((entry) => entry.status === "fresh");
    return { range, merged, coverage, complete };
  }

  return {
    listCalendars() {
      return registry.listEnabledCalendars().map(toPublicCalendar);
    },

    defaultTimezone() {
      return registry.listEnabledCalendars()[0]?.timezone ?? "UTC";
    },

    async getFreeBusy(input) {
      const { range, merged, coverage, complete } = await collect(input);
      const format = (epochMs: number) => formatInTimeZone(epochMs, range.timezone);
      return {
        start: format(range.startMs),
        end: format(range.endMs),
        timezone: range.timezone,
        busy: merged.map((interval) => toBusyInterval(interval, format)),
        coverage,
        complete,
      };
    },

    async findFreeSlots(input) {
      const { range, merged, coverage, complete } = await collect(input);
      const slots = computeFreeSlots(
        {
          startMs: range.startMs,
          endMs: range.endMs,
          timezone: range.timezone,
          durationMinutes: input.durationMinutes,
          bufferMinutes: input.bufferMinutes ?? 0,
          workingHours: input.workingHours ?? DEFAULT_WORKING_HOURS,
          includeWeekends: input.includeWeekends ?? false,
        },
        merged,
      );
      return {
        start: formatInTimeZone(range.startMs, range.timezone),
        end: formatInTimeZone(range.endMs, range.timezone),
        timezone: range.timezone,
        durationMinutes: input.durationMinutes,
        slots,
        coverage,
        complete,
      };
    },
  };
}
