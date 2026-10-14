import ICAL from "ical.js";
import { CalendarError } from "../../errors";
import type { EpochInterval } from "../availability";
import { clipEpochInterval } from "../availability";
import { isValidTimeZone, zonedTimeToEpoch } from "../time";
import type { BusyStatus } from "../types";

export const DEFAULT_OCCURRENCE_LIMIT = 10_000;

export interface ParseIcsInput {
  ics: string;
  calendarId: string;
  defaultTimezone: string;
  rangeStartMs: number;
  rangeEndMs: number;
  occurrenceLimit?: number;
}

type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalTimezone = InstanceType<typeof ICAL.Timezone>;

interface ParseContext {
  calendarId: string;
  defaultTimezone: string;
  rangeStartMs: number;
  rangeEndMs: number;
  embeddedZones: Map<string, IcalTimezone>;
}

/**
 * Parses an ICS document and returns detail-free busy intervals overlapping
 * `[rangeStartMs, rangeEndMs)`. Only DTSTART/DTEND/DURATION, recurrence data,
 * STATUS, and TRANSP are inspected; no event content leaves this function.
 */
export function parseBusyIntervals(input: ParseIcsInput): EpochInterval[] {
  const root = parseRoot(input.ics);
  const context: ParseContext = {
    calendarId: input.calendarId,
    defaultTimezone: input.defaultTimezone,
    rangeStartMs: input.rangeStartMs,
    rangeEndMs: input.rangeEndMs,
    embeddedZones: embeddedTimezones(root),
  };
  const limit = input.occurrenceLimit ?? DEFAULT_OCCURRENCE_LIMIT;
  const budget = { remaining: limit };

  const groups = new Map<string, { masters: IcalComponent[]; exceptions: IcalComponent[] }>();
  for (const component of root.getAllSubcomponents("vevent")) {
    const uid = String(component.getFirstPropertyValue("uid") ?? "");
    const group = groups.get(uid) ?? { masters: [], exceptions: [] };
    if (component.hasProperty("recurrence-id")) group.exceptions.push(component);
    else group.masters.push(component);
    groups.set(uid, group);
  }

  const intervals: EpochInterval[] = [];
  for (const group of groups.values()) {
    const master = group.masters[0];
    if (!master) {
      // An instance without its series (common for single-occurrence invites):
      // treat each as a standalone event.
      for (const exception of group.exceptions) addSingle(exception, context, intervals, budget, limit);
      continue;
    }
    const event = safeEvent(master);
    if (event.isRecurring()) {
      for (const exception of group.exceptions) event.relateException(exception);
      expandRecurring(event, group.exceptions, context, intervals, budget, limit);
    } else {
      addSingle(master, context, intervals, budget, limit);
    }
    // Additional masters with the same UID are malformed; include them as
    // standalone events rather than silently dropping busy time.
    for (const extra of group.masters.slice(1)) addSingle(extra, context, intervals, budget, limit);
  }
  return intervals;
}

function parseRoot(ics: string): IcalComponent {
  let root: IcalComponent;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new CalendarError("feed_invalid");
  }
  if (root.name !== "vcalendar") throw new CalendarError("feed_invalid");
  return root;
}

function embeddedTimezones(root: IcalComponent): Map<string, IcalTimezone> {
  const zones = new Map<string, IcalTimezone>();
  for (const component of root.getAllSubcomponents("vtimezone")) {
    try {
      const zone = new ICAL.Timezone(component);
      if (zone.tzid) zones.set(zone.tzid, zone);
    } catch {
      // An unusable VTIMEZONE only matters if an event references it, which
      // then fails conversion explicitly.
    }
  }
  return zones;
}

function safeEvent(component: IcalComponent): IcalEvent {
  try {
    return new ICAL.Event(component);
  } catch {
    throw new CalendarError("feed_invalid");
  }
}

function spend(budget: { remaining: number }, limit: number): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new CalendarError("too_many_occurrences", `A calendar produced more than ${limit} occurrences for the requested range.`);
  }
}

function classify(component: IcalComponent): BusyStatus | undefined {
  const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (status === "CANCELLED") return undefined;
  const transparency = String(component.getFirstPropertyValue("transp") ?? "").toUpperCase();
  if (transparency === "TRANSPARENT") return undefined;
  return status === "TENTATIVE" ? "tentative" : "busy";
}

function tzidOf(time: IcalTime | null | undefined): string | undefined {
  if (!time) return undefined;
  const tzid = (time as { timezone?: string }).timezone;
  if (tzid) return tzid;
  const zoneId = time.zone?.tzid;
  return zoneId && zoneId !== "floating" ? zoneId : undefined;
}

function toEpoch(time: IcalTime, tzid: string | undefined, context: ParseContext): number {
  if (time.isDate) {
    return zonedTimeToEpoch(time.year, time.month, time.day, 0, 0, 0, context.defaultTimezone);
  }
  if (tzid === "UTC" || tzid === "Z" || time.zone?.tzid === "UTC") {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  }
  if (tzid === undefined) {
    return zonedTimeToEpoch(time.year, time.month, time.day, time.hour, time.minute, time.second, context.defaultTimezone);
  }
  if (isValidTimeZone(tzid)) {
    return zonedTimeToEpoch(time.year, time.month, time.day, time.hour, time.minute, time.second, tzid);
  }
  const embedded = context.embeddedZones.get(tzid);
  if (embedded) {
    const local = time.clone();
    local.zone = embedded;
    return local.toUnixTime() * 1000;
  }
  throw new CalendarError("feed_invalid", "A calendar event uses an unknown timezone.");
}

function push(
  startMs: number,
  endMs: number,
  status: BusyStatus,
  context: ParseContext,
  intervals: EpochInterval[],
): void {
  const clipped = clipEpochInterval(
    { startMs, endMs, status, calendarIds: [context.calendarId] },
    context.rangeStartMs,
    context.rangeEndMs,
  );
  if (clipped) intervals.push(clipped);
}

function addSingle(
  component: IcalComponent,
  context: ParseContext,
  intervals: EpochInterval[],
  budget: { remaining: number },
  limit: number,
): void {
  spend(budget, limit);
  const status = classify(component);
  if (!status) return;
  const event = safeEvent(component);
  const start = event.startDate;
  if (!start) throw new CalendarError("feed_invalid");
  const startTzid = tzidOf(start);
  const startMs = toEpoch(start, startTzid, context);
  let endMs: number;
  const end = component.hasProperty("dtend") ? event.endDate : undefined;
  if (end) {
    endMs = toEpoch(end, tzidOf(end) ?? startTzid, context);
  } else if (component.hasProperty("duration")) {
    const computed = event.endDate;
    endMs = toEpoch(computed, startTzid, context);
  } else if (start.isDate) {
    const next = start.clone();
    next.adjust(1, 0, 0, 0);
    endMs = toEpoch(next, startTzid, context);
  } else {
    return;
  }
  push(startMs, endMs, status, context, intervals);
}

function expandRecurring(
  event: IcalEvent,
  exceptions: IcalComponent[],
  context: ParseContext,
  intervals: EpochInterval[],
  budget: { remaining: number },
  limit: number,
): void {
  const masterTzid = tzidOf(event.startDate);
  const seenRecurrenceIds = new Set<string>();
  let iterator: ReturnType<IcalEvent["iterator"]>;
  try {
    iterator = event.iterator();
  } catch {
    throw new CalendarError("feed_invalid");
  }
  for (;;) {
    let next: IcalTime | null;
    try {
      next = iterator.next();
    } catch {
      throw new CalendarError("feed_invalid");
    }
    if (!next) break;
    spend(budget, limit);
    const originalStartMs = toEpoch(next, masterTzid, context);
    if (originalStartMs >= context.rangeEndMs) break;
    seenRecurrenceIds.add(next.toString());
    emitOccurrence(event, next, masterTzid, context, intervals);
  }

  // A modified occurrence whose original slot falls after the range can be
  // moved into the range; include those explicitly.
  for (const exception of exceptions) {
    const recurrenceId = exception.getFirstPropertyValue("recurrence-id") as IcalTime | null;
    if (!recurrenceId || seenRecurrenceIds.has(recurrenceId.toString())) continue;
    const originalMs = toEpoch(recurrenceId, tzidOf(recurrenceId) ?? masterTzid, context);
    if (originalMs < context.rangeEndMs) continue;
    addSingle(exception, context, intervals, budget, limit);
  }
}

function emitOccurrence(
  event: IcalEvent,
  occurrence: IcalTime,
  masterTzid: string | undefined,
  context: ParseContext,
  intervals: EpochInterval[],
): void {
  let details: ReturnType<IcalEvent["getOccurrenceDetails"]>;
  try {
    details = event.getOccurrenceDetails(occurrence);
  } catch {
    throw new CalendarError("feed_invalid");
  }
  const item = details.item;
  const status = classify(item.component);
  if (!status) return;
  const isMaster = item === event;
  const startTzid = isMaster ? masterTzid : (tzidOf(item.startDate) ?? masterTzid);
  // ICAL.js derives occurrence ends from the start's wall clock plus the
  // event duration, so both ends are interpreted in the start's zone.
  const startMs = toEpoch(details.startDate, startTzid, context);
  const endMs = toEpoch(details.endDate, startTzid, context);
  push(startMs, endMs, status, context, intervals);
}
